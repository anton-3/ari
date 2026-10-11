import http from "node:http";
import { pathToFileURL, fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";
import OpenAI from "openai";
import twilio from "twilio";
import * as linode from "./linode.js";
import * as actions from "./actions.js";
import { placeIncidentCall, DEMO_PHONE } from "./incident.js";
import { SMS_SYSTEM_PROMPT, GREETING } from "./voice-prompts.js";
import { voiceConfig, xmlEscape, relayTwiml, mediaTwiml, fallbackUrl } from "./voice-config.js";
import { CallSession, SessionStore, voiceLog } from "./voice-session.js";
import { writeAndSendPostmortem, needsPostmortem } from "./postmortem.js";
import { RelayTransport, MediaTransport } from "./voice-transports.js";
import { providerFetch } from "./voice-http.js";

const providers = [linode, actions];
const tools = providers.flatMap((p) => p.tools);
const dispatchTool = (name, args) => {
  const owner = providers.find((p) => p.tools.some((t) => t.function.name === name));
  return owner ? owner.runTool(name, args) : Promise.resolve(`Unknown tool: ${name}`);
};

export function validateTwilio(req, config, upgrade = false) {
  if (!config.twilioToken) return false;
  const host = config.host || req.headers.host;
  const path = req.originalUrl || req.url;
  const url = `https://${host}${path}`;
  const signature = req.headers["x-twilio-signature"] || "";
  const params = upgrade ? {} : (req.body || {});
  const candidates = [url];
  if (upgrade) {
    // Voice WSS signatures may use the WebSocket scheme and a trailing slash.
    candidates.push(url.replace(/^https:/, "wss:"));
    for (const candidate of [...candidates]) {
      const parsed = new URL(candidate);
      if (!parsed.pathname.endsWith("/")) { parsed.pathname += "/"; candidates.push(parsed.toString()); }
    }
  }
  return candidates.some((candidate) => twilio.validateRequest(config.twilioToken, signature, candidate, params));
}

export function createVoiceServer({ config = voiceConfig(), client = new OpenAI({ fetch: providerFetch }), dispatch = dispatchTool, twilioClient, Media = MediaTransport, log = voiceLog } = {}) {
  const model = process.env.CHAT_MODEL || "hackathon-chat";
  const tc = twilioClient || (config.twilioSid && config.twilioToken ? twilio(config.twilioSid, config.twilioToken, { timeout: 10000, autoRetry: false }) : null);
  const store = new SessionStore((data) => new CallSession({
    ...data, dispatch, log,
    // If Ari changed anything on the call, write the postmortem and email the team.
    onClose: (s) => {
      if (!needsPostmortem(s.actionLog)) return;
      writeAndSendPostmortem({ client, model, callSid: s.callSid, messages: s.messages, actions: s.actionLog, startedAt: s.startedAt })
        .then((r) => console.log(`[${s.callSid}] postmortem ${r.ok ? "emailed" : "saved, email failed: " + r.error} -> ${r.file}`))
        .catch((e) => console.error(`[${s.callSid}] postmortem failed:`, e.message));
    },
    complete: async (messages, signal) => {
      const response = await client.chat.completions.create({ model, max_tokens: 1024, tools, tool_choice: "auto", messages }, { signal, timeout: 30000, maxRetries: 0 });
      return response.choices[0].message;
    },
  }));
  const app = express();
  const greetingCache = new Map();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.static(fileURLToPath(new URL("./public", import.meta.url))));
  const fromTwilio = (req) => validateTwilio(req, config);

  const endCall = async (session) => {
    session.ended = true;
    try { if (tc) await tc.calls(session.callSid).update({ status: "completed" }); }
    catch { log(session, "end_call_failed"); }
    finally { store.remove(session); }
  };

  function prepareFallback(session) {
    if (!session.fallback) {
      session.fallback = true;
      session.needsResume = Boolean(session.current || session.queue.length);
      // Force cancellation even during a normally non-interruptible sound effect.
      session.current?.controller.abort();
      if (session.current) session.current.aborted = true;
      session.transport?.dispose();
      session.transport = null;
      store.release(session);
      session.disconnectedAt = Date.now();
      session.bound = false;
      log(session, "fallback", { target: "ConversationRelay" });
    }
  }

  async function fallback(session) {
    if (session.ended || !session.alive || session.fallback) return;
    prepareFallback(session);
    try {
      if (!tc) throw new Error("Missing Twilio client");
      const call = await tc.calls(session.callSid).fetch();
      if (call.status !== "in-progress") { store.remove(session); return; }
      await tc.calls(session.callSid).update({ url: fallbackUrl(config, session), method: "POST" });
    } catch {
      log(session, "fallback_failed");
      await endCall(session);
    }
  }

  app.post("/voice", (req, res) => {
    if (!fromTwilio(req)) return res.sendStatus(403);
    if (!req.body.CallSid) return res.sendStatus(400);
    const session = store.create({
      callSid: req.body.CallSid,
      greeting: typeof req.query.greeting === "string" ? req.query.greeting : GREETING,
      prompt: typeof req.query.prompt === "string" ? req.query.prompt : "",
    }, config.stack === "custom");
    if (!session.alive) return res.sendStatus(410);
    const cfg = { ...config, host: config.host || req.headers.host };
    log(session, "route", { stack: session.custom && !session.fallback ? "custom" : "twilio", sttModel: session.custom ? config.model : "nova-3-general" });
    res.type("text/xml").send(session.custom && !session.fallback ? mediaTwiml(cfg, session) : relayTwiml(cfg, session, session.fallback));
  });

  app.post("/voice/fallback", (req, res) => {
    if (!fromTwilio(req)) return res.sendStatus(403);
    const session = store.sessions.get(req.query.session);
    if (!session?.alive || session.ended || session.callSid !== req.body.CallSid || !session.custom) return res.sendStatus(403);
    prepareFallback(session);
    res.type("text/xml").send(relayTwiml(config, session, true));
  });

  // Per-number SMS history remains independent of the call transports.
  const smsThreads = new Map();
  app.post("/sms", async (req, res) => {
    if (!fromTwilio(req)) return res.sendStatus(403);
    const from = req.body.From;
    const text = (req.body.Body || "").trim();
    const thread = smsThreads.get(from) || [];
    thread.push({ role: "user", content: text || "(empty message)" });
    let reply;
    try {
      const completion = await client.chat.completions.create({ model, max_tokens: 1024, messages: [{ role: "system", content: SMS_SYSTEM_PROMPT }, ...thread] });
      reply = (completion.choices[0].message.content || "").trim();
      thread.push({ role: "assistant", content: reply });
    } catch {
      thread.pop();
      reply = "Sorry, I hit a snag. Try again in a moment.";
    }
    while (thread.length > 40) thread.splice(0, 2);
    smsThreads.set(from, thread);
    res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${xmlEscape(reply)}</Message></Response>`);
  });

  app.post("/incident", async (req, res) => {
    const ip = req.socket.remoteAddress || "";
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ip)) return res.sendStatus(403);
    try {
      const call = await placeIncidentCall({ to: req.body?.to || DEMO_PHONE, label: req.body?.label || "ari-net-lb-1" });
      res.json({ ok: true, callSid: call.sid, to: call.to });
    } catch {
      res.status(502).json({ ok: false, error: "Could not place incident call" });
    }
  });
  app.get("/", (_req, res) => res.send("ok"));

  const server = http.createServer(app);
  const relayWss = new WebSocketServer({ noServer: true, maxPayload: 65536 });
  const mediaWss = new WebSocketServer({ noServer: true, maxPayload: 65536 });
  server.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url, "http://localhost").pathname;
    const wss = path === "/relay" ? relayWss : path === "/media" ? mediaWss : null;
    if (!wss || !validateTwilio(req, config, true)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
  });

  relayWss.on("connection", (ws) => {
    let session;
    const setupTimer = setTimeout(() => ws.close(1008, "Missing setup"), 5000);
    ws.on("error", () => {});
    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { ws.close(1008, "Invalid JSON"); return; }
      if (msg.type === "setup") {
        if (session) { ws.close(1008, "Duplicate setup"); return; }
        session = store.bind(msg.customParameters?.session, msg.callSid, "twilio");
        if (!session || (session.custom && !session.fallback)) { ws.close(1008, "Invalid session"); return; }
        clearTimeout(setupTimer);
        const transport = new RelayTransport(session, ws, config);
        session.attach(transport);
        session.recordSpoken(session.fallback ? "I switched audio connections." : session.greeting);
        log(session, "connected", { stack: "twilio" });
        if (session.needsResume || session.queue.length) void session.drain();
      } else if (!session) { ws.close(1008, "Missing setup"); }
      else if (msg.type === "prompt" && msg.last !== false) {
        // Relay's prompt may be partial; only submit completed speech.
        if (session.current && !session.current.aborted) session.interrupt();
        session.enqueue(msg.voicePrompt);
      } else if (msg.type === "interrupt") session.interrupt(msg.utteranceUntilInterrupt || "");
      else if (msg.type === "error") log(session, "relay_error", { code: msg.code });
    });
    ws.on("close", () => {
      clearTimeout(setupTimer);
      if (session?.transport?.ws === ws) {
        session.disconnect();
        log(session, "disconnected", { stack: "twilio" });
      }
    });
  });

  mediaWss.on("connection", (ws) => {
    let session;
    let transport;
    const startTimer = setTimeout(() => ws.close(1008, "Missing start"), 5000);
    ws.on("error", () => {});
    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { ws.close(1008, "Invalid JSON"); return; }
      if (msg.event === "start") {
        if (session) { ws.close(1008, "Duplicate start"); return; }
        session = store.bind(msg.start?.customParameters?.session, msg.start?.callSid, "custom");
        if (!session || !msg.start?.streamSid) { ws.close(1008, "Invalid session"); return; }
        clearTimeout(startTimer);
        const format = msg.start.mediaFormat;
        if (format?.encoding !== "audio/x-mulaw" || format.sampleRate !== 8000 || format.channels !== 1) {
          void fallback(session);
          ws.close(1008, "Unsupported audio");
          return;
        }
        transport = new Media(session, ws, msg.start.streamSid, config, { fallback, end: endCall, release: (s) => store.release(s), greetingCache });
        session.attach(transport);
        log(session, "connected", { stack: "custom" });
      } else if (msg.event === "connected") { /* Precedes start. */ }
      else if (!transport) { ws.close(1008, "Missing start"); }
      else if (msg.event === "stop") {
        // Do not redirect a caller who has hung up. Check the call's status first.
        transport.dispose();
        void fallback(session);
      } else transport.receive(msg);
    });
    ws.on("close", () => {
      clearTimeout(startTimer);
      transport?.dispose();
      if (session && !session.fallback && !session.ended) void fallback(session);
    });
  });

  async function close() {
    store.close();
    for (const ws of [...relayWss.clients, ...mediaWss.clients]) ws.terminate();
    await new Promise((resolve) => server.close(resolve));
    relayWss.close();
    mediaWss.close();
  }
  return { app, server, store, fallback, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = voiceConfig();
  const runtime = createVoiceServer({ config });
  runtime.server.listen(process.env.PORT || 8080, () => {
    console.log(`Ari listening on :${process.env.PORT || 8080}; voice stack: ${config.stack}`);
  });
}
