import http from "node:http";
import crypto from "node:crypto";
import express from "express";
import { WebSocketServer } from "ws";
import Anthropic from "@anthropic-ai/sdk";

const PORT = process.env.PORT || 8080;
const PUBLIC_HOST = process.env.PUBLIC_HOST;
const GREETING = "Hi, this is Claude. What's on your mind?";

const SYSTEM_PROMPT = `You are Claude, talking with someone over a phone call.
Everything you write is read aloud by a text-to-speech engine, so:
- Reply in plain spoken sentences. No markdown, lists, headings, emoji, or code blocks.
- Keep replies short and conversational, usually one to three sentences, unless asked for more.
- Spell out things that are awkward to read aloud (say "for example", not "e.g.").
- The caller's words come from speech recognition and may contain transcription errors; infer the likely meaning, and ask if it's genuinely unclear.`;

const SMS_SYSTEM_PROMPT = `You are Claude, chatting with someone over SMS text messages.
- Write plain text only. No markdown, since it won't render.
- Keep replies brief, like a text message: usually a few sentences at most.`;

const client = new Anthropic();
const MODEL_PARAMS = {
  model: "claude-opus-5-5",
  output_config: { effort: "low" }, // phone and SMS need low latency
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default",
};

// Reject requests that weren't signed by Twilio with our auth token.
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
  s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]);

const app = express();
app.use(express.urlencoded({ extended: false }));

// Twilio hits this webhook when a call comes in; the TwiML hands the call to ConversationRelay.
app.post("/voice", (req, res) => {
  if (!fromTwilio(req)) return res.sendStatus(403);
  const host = PUBLIC_HOST || req.headers.host;
  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay url="wss://${host}/relay" welcomeGreeting="${GREETING}" interruptible="any" />
  </Connect>
</Response>`);
});

// Per-number SMS conversation history (in memory; resets when the server restarts).
const smsThreads = new Map();
const MAX_SMS_MESSAGES = 40;

app.post("/sms", async (req, res) => {
  if (!fromTwilio(req)) return res.sendStatus(403);
  const from = req.body.From;
  const text = (req.body.Body || "").trim();
  console.log(`[sms ${from}] ${text}`);

  const thread = smsThreads.get(from) || [];
  thread.push({ role: "user", content: text || "(empty message)" });

  let reply;
  try {
    const final = await client.beta.messages.create({
      ...MODEL_PARAMS,
      max_tokens: 1024,
      system: SMS_SYSTEM_PROMPT,
      messages: thread,
    });
    if (final.stop_reason === "refusal") {
      thread.pop();
      reply = "Sorry, I can't help with that one.";
    } else {
      thread.push({ role: "assistant", content: final.content });
      reply = final.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("")
        .trim();
    }
  } catch (err) {
    thread.pop();
    console.error(`[sms ${from}] Claude error:`, err);
    reply = "Sorry, I hit a snag. Try again in a moment.";
  }
  // Drop the oldest exchanges, keeping the thread starting on a user turn.
  while (thread.length > MAX_SMS_MESSAGES) thread.splice(0, 2);
  smsThreads.set(from, thread);

  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response><Message>${xmlEscape(reply)}</Message></Response>`);
});

app.get("/", (_req, res) => res.send("ok"));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/relay" });

wss.on("connection", (ws) => {
  /** @type {Anthropic.Beta.BetaMessageParam[]} */
  const messages = [{ role: "assistant", content: GREETING }];
  let current = null; // { stream, spoken } for the in-flight reply
  let callSid = "unknown";

  const send = (msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));

  async function respond(userText) {
    // Messages must alternate; merge into the previous user turn if the last reply never landed.
    const last = messages[messages.length - 1];
    if (last.role === "user") last.content += " " + userText;
    else messages.push({ role: "user", content: userText });

    const stream = client.beta.messages.stream({
      ...MODEL_PARAMS,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages,
    });
    const turn = { stream, spoken: "" };
    current = turn;

    stream.on("text", (token) => {
      turn.spoken += token;
      send({ type: "text", token, last: false });
    });

    try {
      const final = await stream.finalMessage();
      if (final.stop_reason === "refusal") {
        send({ type: "text", token: "Sorry, I can't help with that one.", last: true });
        messages.pop();
      } else {
        send({ type: "text", token: "", last: true });
        messages.push({ role: "assistant", content: final.content });
      }
    } catch (err) {
      if (turn.aborted) {
        // Caller interrupted: keep only what they actually heard.
        if (turn.heard) messages.push({ role: "assistant", content: turn.heard });
      } else {
        console.error(`[${callSid}] Claude error:`, err);
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
        console.log(`[${callSid}] call connected from ${msg.from}`);
        break;
      case "prompt":
        console.log(`[${callSid}] caller: ${msg.voicePrompt}`);
        respond(msg.voicePrompt);
        break;
      case "interrupt":
        if (current) {
          current.aborted = true;
          current.heard = msg.utteranceUntilInterrupt || "";
          current.stream.abort();
        }
        break;
      case "error":
        console.error(`[${callSid}] relay error:`, msg.description);
        break;
    }
  });

  ws.on("close", () => {
    current?.stream.abort();
    console.log(`[${callSid}] call ended`);
  });
});

server.listen(PORT, () => {
  console.log(`Listening on :${PORT} — webhooks: POST https://<public-host>/voice and /sms`);
});
