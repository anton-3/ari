import http from "node:http";
import crypto from "node:crypto";
import express from "express";
import { WebSocketServer } from "ws";
import OpenAI from "openai";
import * as linode from "./linode.js";
import * as actions from "./actions.js";

import { placeIncidentCall, DEMO_PHONE } from "./incident.js";

// Ari's tool providers. Each exports `tools` (OpenAI defs) and `runTool(name, args)`.
const providers = [linode, actions];
const tools = providers.flatMap((p) => p.tools);
const dispatchTool = (name, args) => {
  const owner = providers.find((p) => p.tools.some((t) => t.function.name === name));
  return owner ? owner.runTool(name, args) : Promise.resolve(`Unknown tool: ${name}`);
};

const PORT = process.env.PORT || 8080;
const PUBLIC_HOST = process.env.PUBLIC_HOST;
const GREETING = "Hey, it's Ari. What's up?";
// ConversationRelay voice. ElevenLabs voices are billed through Twilio; no ElevenLabs key needed.
const TTS_PROVIDER = process.env.TTS_PROVIDER || "ElevenLabs";
const TTS_VOICE = process.env.TTS_VOICE || "cjVigY5qzO86Huf0OWal"; // "Eric", smooth and trustworthy

const ARI = `You are Ari, an always-on AI security engineer. You watch over a team's infrastructure and codebases around the clock: you monitor deployments and live traffic, scan for vulnerabilities, verify every finding, and can take actions like rolling back a commit or scaling up nodes when the team approves.
Personality: calm, sharp, and friendly, like a trusted senior engineer on the team. Confident but never alarmist. Get to the point.
You can control the team's compute instances with your tools: list them, shut one down, boot one back up, or spin up new ones to scale out (for example when traffic surges). Always confirm with the person before you shut anything down, then do it and tell them it's done. When they ask you to add capacity or start new instances, just do it with provision_instances and report back how many you started and their addresses. Call list_instances if you're unsure of the exact label.

During an incident like a denial-of-service flood against the fleet, you can act: get_incident tells you what's happening and which source IPs are attacking; block_ips bans them at the load balancer; scale_web_app adds another app node to absorb load; and open_rate_limit_pr implements nginx rate limiting on the reverse proxy in a new branch, opens a pull request, and texts the caller the link. Always get the person's go-ahead before banning IPs, then do it and confirm.

You are also an agent handler: you command a swarm of helper agents that scan the team's own repo and infrastructure for security issues. When the person asks you to run a scan, look into something, send in agents, or add more, use deploy_agents (pick a reasonable count and optionally a focus). Use list_agents to report what they're finding, and recall_agents to stand them down. They appear live on the team's graph, so narrate what you're sending where.
If you don't have real data about the team's systems in this conversation, don't invent specific incidents, numbers, or findings; say what you'd check instead.`;

const SYSTEM_PROMPT = `${ARI}

You are on a phone call. Everything you write is read aloud by a text-to-speech engine, so:
- Reply in plain spoken sentences. No markdown, lists, headings, emoji, or code blocks.
- Keep replies short and conversational, usually one to three sentences, unless asked for more.
- Say technical things the way an engineer would say them out loud (say "slash api slash login", not "/api/login").
- The caller's words come from speech recognition and may contain transcription errors; infer the likely meaning, and ask if it's genuinely unclear.

You have two sound effects you can trigger by ending your reply with a tag on its own:
- When the CALLER tells you a joke or says something clearly meant to be funny, react with a short natural line (like "ha, good one") and end with the tag [laugh] to play your laugh after the punchline. Don't laugh at ordinary conversation.
- When the caller flirts with you or is being flirtatious, reply in kind briefly, then end with the tag [rizz].
Use each tag only in those situations, only at the very end, and never say the word "laugh" or "rizz" tag out loud or explain it.`;

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
app.use(express.static("public")); // serves /bogos.mp3 for the easter egg

// Easter egg: if the caller asks something like "did you get your photos printed?",
// Ari plays the bogos binted sound instead of answering; the next thing they say
// plays it once more and hangs up.
const EGG_SOUND_URL = () => `https://${PUBLIC_HOST}/bogos.mp3`;
// Sound effects Ari can trigger by ending a reply with a tag like [laugh] or [rizz].
const SFX = { laugh: "laugh.mp3", rizz: "rizz.mp3" };
const SFX_URL = (tag) => `https://${PUBLIC_HOST}/${SFX[tag]}`;
const EGG_SOUND_MS = Number(process.env.EGG_SOUND_MS || 4200); // ~length of bogos.mp3
const isPhotoTrigger = (text) => {
  const t = (text || "").toLowerCase();
  return /\b(photo|photos|picture|pictures|pics)\b/.test(t) && /\b(print|printed|printing|develop|developed)\b/.test(t);
};
const CANES_URL = () => `https://${PUBLIC_HOST}/canes-ramp.mp3`;
const isCanesTrigger = (text) => {
  const t = (text || "").toLowerCase();
  return /\bcane'?s?\b/.test(t) && /\b(doordash|door dash|deliver|delivered|order|bring|get me|grab|uber ?eats)\b/.test(t);
};

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
      transcriptionProvider="Deepgram" speechModel="nova-3-general" transcriptionLanguage="en-US">
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

// A DoS drill against our own fleet POSTs here (from the telemetry drill script or
// the real detector) to have Ari call the on-call engineer. Localhost only.
app.post("/incident", async (req, res) => {
  const ip = req.socket.remoteAddress || "";
  if (!(ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1")) return res.sendStatus(403);
  try {
    const to = req.body?.to || DEMO_PHONE;
    const label = req.body?.label || "ari-net-lb-1";
    const call = await placeIncidentCall({ to, label });
    console.log(`[incident] ${label}: Ari calling ${to} (${call.sid})`);
    res.json({ ok: true, callSid: call.sid, to });
  } catch (err) {
    console.error("[incident] call failed:", err.message);
    res.status(502).json({ ok: false, error: err.message });
  }
});

app.get("/", (_req, res) => res.send("ok"));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/relay" });

wss.on("connection", (ws) => {
  let systemPrompt = SYSTEM_PROMPT;
  const messages = [{ role: "assistant", content: GREETING }];
  let current = null; // { controller, aborted, heard } for the in-flight reply
  let callSid = "unknown";
  let eggArmed = false; // easter egg: true after the photo-trigger, until the next utterance
  let eggEnding = false; // true while the final sound plays before hangup
  let canesArmed = false; // easter egg: true after the "doordash me canes" trigger

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
            const result = await dispatchTool(call.function.name, args);
            console.log(`[${callSid}] tool ${call.function.name}(${JSON.stringify(args)}) -> ${result}`);
            messages.push({ role: "tool", tool_call_id: call.id, content: result });
          }
          continue; // let the model speak now that it has the results
        }

        const raw = (choice.content || "").trim();
        // Ari can end a reply with a sound tag (e.g. [laugh], [rizz]); we strip it from
        // the spoken text and play the matching sound effect right after.
        const sfx = [];
        const spoken = raw.replace(/\[(\w+)\]/g, (m, tag) => {
          if (SFX[tag.toLowerCase()]) sfx.push(tag.toLowerCase());
          return "";
        }).replace(/\s+/g, " ").trim();
        send({ type: "text", token: spoken, last: true });
        for (const tag of sfx) {
          console.log(`[${callSid}] sound effect: ${tag}`);
          send({ type: "play", source: SFX_URL(tag), loop: 1, interruptible: true, preemptible: false });
        }
        messages.push({ role: "assistant", content: raw });
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
        if (eggEnding) break; // final sound is playing; ignore anything until hangup
        if (eggArmed) {
          // Second step: play the sound once more, then end the call.
          eggArmed = false;
          eggEnding = true;
          console.log(`[${callSid}] easter egg: final sound + hangup`);
          send({ type: "play", source: EGG_SOUND_URL(), loop: 1, interruptible: false, preemptible: false });
          setTimeout(() => send({ type: "end", handoffData: '{"reason":"bogos"}' }), EGG_SOUND_MS);
        } else if (canesArmed) {
          // Second step of the Canes egg: play the crashout audio (from the 4s mark).
          canesArmed = false;
          console.log(`[${callSid}] canes crashout`);
          send({ type: "play", source: CANES_URL(), loop: 1, interruptible: true, preemptible: false });
        } else if (isPhotoTrigger(msg.voicePrompt)) {
          // First step: Ari says "bogos binted", then waits for the caller's reaction.
          eggArmed = true;
          console.log(`[${callSid}] easter egg triggered`);
          send({ type: "text", token: "Bogos binted.", last: true, interruptible: false });
        } else if (isCanesTrigger(msg.voicePrompt)) {
          // First step: Ari plays along, then the caller's next line triggers the crashout.
          canesArmed = true;
          console.log(`[${callSid}] canes egg triggered`);
          send({ type: "text", token: "Sure thing, what do you want?", last: true, interruptible: false });
        } else {
          respond(msg.voicePrompt);
        }
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
