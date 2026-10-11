// MyFiat Assistant server: the customer-side banking companion.
//   - POST /assistant/chat  -> text chat used by the MyFiat web UI
//   - POST /voice           -> Twilio webhook (ConversationRelay) for voice
//   - WS   /relay           -> the voice conversation loop
// Mirrors the enterprise backend's ConversationRelay pattern, but with the
// consumer MyFiat persona and ONLY the customer tools (no infra/security tools).

import http from "node:http";
import crypto from "node:crypto";
import express from "express";
import { WebSocketServer } from "ws";
import OpenAI from "openai";

import { tools, runTool, ACTION_TOOLS } from "./tools.js";
import { CHAT_SYSTEM_PROMPT, VOICE_SYSTEM_PROMPT } from "./persona.js";
import { placeSuspiciousChargeCall, DEMO_PHONE } from "./alert-call.js";

const PORT = process.env.PORT || 8072;
const PUBLIC_HOST = process.env.PUBLIC_HOST;
// Default greeting for INBOUND calls (no greeting param). Outbound flows (the
// suspicious-charge call) pass their own greeting via ?greeting=.
const GREETING =
  "Hi, this is Ari with MyFiat. I can help with your accounts, cards, subscriptions, and investments — what do you need?";
// A fixed demo user's Bearer token, used as the caller's identity on INBOUND
// calls so tools can read that seeded user's data. Outbound calls override it
// with a token passed as a ConversationRelay parameter.
const DEMO_TOKEN = process.env.MYFIAT_TOKEN || "";
const TTS_PROVIDER = process.env.TTS_PROVIDER || "ElevenLabs";
const TTS_VOICE = process.env.TTS_VOICE || "cjVigY5qzO86Huf0OWal"; // same warm voice as backend
const MAX_TOOL_STEPS = 6;

// OpenAI-compatible endpoint (the hackathon inference server): reads
// OPENAI_BASE_URL and OPENAI_API_KEY from env (inherited from ../backend/.env).
const client = new OpenAI();
const MODEL = process.env.CHAT_MODEL || "hackathon-chat";

// Shared tool loop. Returns { reply, actions } where actions lists any
// state-changing tools that ran this turn (for the UI's action chips).
async function runConversation({ systemPrompt, history, token, signal }) {
  // Ground every turn in the customer's real cards so Ari never has to ask which ones they have.
  const cards = token ? await runTool("list_cards", {}, token).catch(() => "") : "";
  const today = new Date().toISOString().slice(0, 10);
  const messages = [{ role: "system", content: `${systemPrompt}\n\nToday is ${today}.${cards ? `\nCustomer's cards: ${cards}` : ""}` }, ...history];
  const actions = [];
  for (let step = 0; step < MAX_TOOL_STEPS; step++) {
    const completion = await client.chat.completions.create(
      { model: MODEL, max_tokens: 1024, tools, tool_choice: "auto", messages },
      signal ? { signal } : undefined,
    );
    const choice = completion.choices[0].message;

    if (choice.tool_calls?.length) {
      messages.push(choice);
      for (const call of choice.tool_calls) {
        let args = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {}
        const result = await runTool(call.function.name, args, token);
        console.log(`tool ${call.function.name}(${JSON.stringify(args)}) -> ${String(result).slice(0, 160)}`);
        if (ACTION_TOOLS.has(call.function.name)) {
          actions.push({ tool: call.function.name, args, result: String(result) });
        }
        messages.push({ role: "tool", tool_call_id: call.id, content: String(result) });
      }
      continue; // let the model answer with the results
    }

    return { reply: (choice.content || "").trim(), actions, messages };
  }
  return { reply: "Let me pause there — ask me again and I'll pick it back up.", actions, messages };
}

// Twilio request signature check (same scheme as the backend).
function fromTwilio(req) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token) return true;
  const url = `https://${PUBLIC_HOST || req.headers.host}${req.originalUrl}`;
  const payload = Object.keys(req.body || {})
    .sort()
    .reduce((acc, k) => acc + k + req.body[k], url);
  const expected = crypto.createHmac("sha1", token).update(payload).digest("base64");
  const given = req.get("X-Twilio-Signature") || "";
  return given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

const xmlEscape = (s) =>
  String(s).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.get("/", (_req, res) => res.send("MyFiat Assistant: ok"));
app.get("/health", (_req, res) => res.json({ ok: true, service: "myfiat-assistant", model: MODEL }));

// --- TEXT CHAT -------------------------------------------------------------
// POST /assistant/chat { message, token, history? } -> { reply, actions }
app.post("/assistant/chat", async (req, res) => {
  const { message, token, history } = req.body || {};
  if (!message || typeof message !== "string") {
    return res.status(400).json({ error: "message is required" });
  }
  // Keep only well-formed prior turns; never trust a client-sent system turn.
  const priorTurns = Array.isArray(history)
    ? history
        .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .slice(-20)
    : [];
  try {
    const { reply, actions } = await runConversation({
      systemPrompt: CHAT_SYSTEM_PROMPT,
      history: [...priorTurns, { role: "user", content: message }],
      token,
    });
    res.json({ reply: reply || "Sorry, I didn't catch that — could you rephrase?", actions });
  } catch (err) {
    console.error("[chat] error:", err.message);
    // Degrade gracefully: never 500 the UI over a model/API hiccup.
    res.json({
      reply: "Sorry, I'm having trouble reaching my brain right now. Give me a moment and try again.",
      actions: [],
      error: err.message,
    });
  }
});

// --- VOICE (Twilio ConversationRelay) --------------------------------------
// Twilio hits this on an inbound/outbound call. alert-call.js passes
// ?greeting=...&prompt=...&token=... to steer the suspicious-charge call.
app.post("/voice", (req, res) => {
  if (!fromTwilio(req)) return res.sendStatus(403);
  const host = PUBLIC_HOST || req.headers.host;
  const greeting = req.query.greeting || GREETING;
  const prompt = req.query.prompt || "";
  const token = req.query.token || "";
  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay url="wss://${host}/relay" welcomeGreeting="${xmlEscape(greeting)}" interruptible="any"
      ttsProvider="${TTS_PROVIDER}" voice="${TTS_VOICE}" elevenlabsTextNormalization="on"
      transcriptionProvider="Deepgram" speechModel="nova-3-general" transcriptionLanguage="en-US">
      <Parameter name="greeting" value="${xmlEscape(greeting)}" />
      <Parameter name="prompt" value="${xmlEscape(prompt)}" />
      <Parameter name="token" value="${xmlEscape(token)}" />
    </ConversationRelay>
  </Connect>
</Response>`);
});

// Localhost-only trigger to place the proactive suspicious-charge call (handy
// for demos / the web UI's "call me" button). Body: { to?, token? }.
app.post("/alert-call", async (req, res) => {
  const ip = req.socket.remoteAddress || "";
  if (!(ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1")) return res.sendStatus(403);
  try {
    const call = await placeSuspiciousChargeCall({ to: req.body?.to || DEMO_PHONE, token: req.body?.token || "" });
    res.json({ ok: true, callSid: call.sid, to: req.body?.to || DEMO_PHONE });
  } catch (err) {
    console.error("[alert-call] failed:", err.message);
    res.status(502).json({ ok: false, error: err.message });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/relay" });

wss.on("connection", (ws) => {
  let systemPrompt = VOICE_SYSTEM_PROMPT;
  // Inbound calls act as the fixed demo user (MYFIAT_TOKEN). Outbound calls
  // override this with a token passed in the setup frame's customParameters.
  let token = DEMO_TOKEN;
  const messages = [{ role: "assistant", content: GREETING }];
  let current = null;
  let callSid = "unknown";

  const send = (msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));

  async function respond(userText) {
    const last = messages[messages.length - 1];
    if (last.role === "user") last.content += " " + userText;
    else messages.push({ role: "user", content: userText });

    const turn = { controller: new AbortController() };
    current = turn;
    try {
      const { reply, messages: updated } = await runConversation({
        systemPrompt,
        history: messages,
        token,
        signal: turn.controller.signal,
      });
      // Persist the model/tool turns the loop produced so context carries over.
      messages.length = 0;
      messages.push(...updated.filter((m) => m.role !== "system"));
      send({ type: "text", token: reply, last: true });
    } catch (err) {
      if (turn.aborted) {
        if (turn.heard) messages.push({ role: "assistant", content: turn.heard });
      } else {
        console.error(`[${callSid}] model error:`, err.message);
        send({ type: "text", token: "Sorry, I hit a snag. Could you say that again?", last: true });
      }
    } finally {
      if (current === turn) current = null;
    }
  }

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    switch (msg.type) {
      case "setup":
        callSid = msg.callSid;
        if (msg.customParameters?.greeting) messages[0].content = msg.customParameters.greeting;
        if (msg.customParameters?.prompt) systemPrompt += `\n\nInstructions for this call:\n${msg.customParameters.prompt}`;
        if (msg.customParameters?.token) token = msg.customParameters.token;
        if (!token) {
          // No account identity this session — still converse, but say so.
          systemPrompt +=
            "\n\nNote: you don't have access to this caller's MyFiat account in this session, so you cannot pull up their balances, transactions, cards, or subscriptions. Tell them that warmly if they ask for specifics, and offer general help or to have them sign in on the app.";
        }
        console.log(`[${callSid}] call connected (${msg.direction}) from ${msg.from} to ${msg.to}; acting as ${token ? "demo user (token set)" : "no account (no token)"}`);
        break;
      case "prompt":
        console.log(`[${callSid}] caller: ${msg.voicePrompt}`);
        respond(msg.voicePrompt);
        break;
      case "interrupt":
        if (current) {
          current.aborted = true;
          current.heard = msg.utteranceUntilInterrupt || "";
          current.controller.abort();
        }
        break;
      case "error":
        console.error(`[${callSid}] relay error:`, msg.description);
        break;
    }
  });

  ws.on("close", () => {
    current?.controller.abort();
    console.log(`[${callSid}] call ended`);
  });
});

server.listen(PORT, () => {
  console.log(`MyFiat Assistant on :${PORT}`);
  console.log(`  chat:  POST http://localhost:${PORT}/assistant/chat`);
  console.log(`  voice: POST https://<public-host>/voice  (needs its own tunnel to :${PORT})`);
});
