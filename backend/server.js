import http from "node:http";
import crypto from "node:crypto";
import express from "express";
import { WebSocketServer } from "ws";
import OpenAI from "openai";
import { tools, runTool } from "./linode.js";

const PORT = process.env.PORT || 8080;
const PUBLIC_HOST = process.env.PUBLIC_HOST;
const GREETING = "Hey, it's Ari. What's up?";
// ConversationRelay voice. ElevenLabs voices are billed through Twilio; no ElevenLabs key needed.
const TTS_PROVIDER = process.env.TTS_PROVIDER || "ElevenLabs";
const TTS_VOICE = process.env.TTS_VOICE || "cjVigY5qzO86Huf0OWal"; // "Eric", smooth and trustworthy

const ARI = `You are Ari, an always-on AI security engineer. You watch over a team's infrastructure and codebases around the clock: you monitor deployments and live traffic, pentest and scan for vulnerabilities, verify every finding with a proof-of-concept exploit, and can take actions like rolling back a commit or scaling up nodes when the team approves.
Personality: calm, sharp, and friendly, like a trusted senior engineer on the team. Confident but never alarmist. Get to the point.
You can control the team's compute instances with your tools: list them, shut one down, or boot one back up. Always confirm with the person before you shut anything down, then do it and tell them it's done. Call list_instances if you're unsure of the exact label.
If you don't have real data about the team's systems in this conversation, don't invent specific incidents, numbers, or findings; say what you'd check instead.`;

const SYSTEM_PROMPT = `${ARI}

You are on a phone call. Everything you write is read aloud by a text-to-speech engine, so:
- Reply in plain spoken sentences. No markdown, lists, headings, emoji, or code blocks.
- Keep replies short and conversational, usually one to three sentences, unless asked for more.
- Say technical things the way an engineer would say them out loud (say "slash api slash login", not "/api/login").
- The caller's words come from speech recognition and may contain transcription errors; infer the likely meaning, and ask if it's genuinely unclear.`;

const SMS_SYSTEM_PROMPT = `${ARI}

You are texting with someone over SMS.
- Write plain text only. No markdown, since it won't render.
- Keep replies brief, like a text message from a coworker: usually one to three sentences.`;

// OpenAI-compatible endpoint (the hackathon's Akamai inference server); reads OPENAI_BASE_URL and OPENAI_API_KEY.
const client = new OpenAI();
const MODEL = process.env.CHAT_MODEL || "hackathon-chat";

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
// Outbound calls (see call.js) pass ?greeting=...&prompt=... to customize the conversation.
app.post("/voice", (req, res) => {
  if (!fromTwilio(req)) return res.sendStatus(403);
  const host = PUBLIC_HOST || req.headers.host;
  const greeting = req.query.greeting || GREETING;
  const prompt = req.query.prompt || "";
  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay url="wss://${host}/relay" welcomeGreeting="${xmlEscape(greeting)}" interruptible="any"
      ttsProvider="${TTS_PROVIDER}" voice="${TTS_VOICE}" elevenlabsTextNormalization="on"
      transcriptionProvider="Deepgram" speechModel="nova-3-general">
      <Parameter name="greeting" value="${xmlEscape(greeting)}" />
      <Parameter name="prompt" value="${xmlEscape(prompt)}" />
    </ConversationRelay>
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
    const completion = await client.chat.completions.create({
      model: MODEL,
      max_tokens: 1024,
      messages: [{ role: "system", content: SMS_SYSTEM_PROMPT }, ...thread],
    });
    reply = (completion.choices[0].message.content || "").trim();
    thread.push({ role: "assistant", content: reply });
  } catch (err) {
    thread.pop();
    console.error(`[sms ${from}] model error:`, err);
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
  let systemPrompt = SYSTEM_PROMPT;
  const messages = [{ role: "assistant", content: GREETING }];
  let current = null; // { controller, aborted, heard } for the in-flight reply
  let callSid = "unknown";

  const send = (msg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));

  async function respond(userText) {
    // Messages must alternate; merge into the previous user turn if the last reply never landed.
    const last = messages[messages.length - 1];
    if (last.role === "user") last.content += " " + userText;
    else messages.push({ role: "user", content: userText });

    const turn = { controller: new AbortController() };
    current = turn;

    try {
      // Tool loop: the model may call Linode tools (shut down / boot / list) before
      // giving its spoken answer. We run those, feed results back, and repeat until
      // it produces plain text, which Twilio reads aloud.
      for (let step = 0; step < 6; step++) {
        const completion = await client.chat.completions.create(
          {
            model: MODEL,
            max_tokens: 1024,
            tools,
            tool_choice: "auto",
            messages: [{ role: "system", content: systemPrompt }, ...messages],
          },
          { signal: turn.controller.signal },
        );
        const choice = completion.choices[0].message;

        if (choice.tool_calls?.length) {
          messages.push(choice);
          for (const call of choice.tool_calls) {
            let args = {};
            try {
              args = JSON.parse(call.function.arguments || "{}");
            } catch {}
            const result = await runTool(call.function.name, args);
            console.log(`[${callSid}] tool ${call.function.name}(${JSON.stringify(args)}) -> ${result}`);
            messages.push({ role: "tool", tool_call_id: call.id, content: result });
          }
          continue; // let the model speak now that it has the results
        }

        const reply = (choice.content || "").trim();
        send({ type: "text", token: reply, last: true });
        messages.push({ role: "assistant", content: reply });
        return;
      }
      send({ type: "text", token: "Let me stop there and pick this up again in a moment.", last: true });
    } catch (err) {
      if (turn.aborted) {
        // Caller interrupted: keep only what they actually heard.
        if (turn.heard) messages.push({ role: "assistant", content: turn.heard });
      } else {
        console.error(`[${callSid}] model error:`, err);
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
        console.log(`[${callSid}] call connected (${msg.direction}) from ${msg.from} to ${msg.to}`);
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
  console.log(`Listening on :${PORT} — webhooks: POST https://<public-host>/voice and /sms`);
});
