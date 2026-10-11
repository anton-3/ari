// STT head-to-head: Deepgram vs self-hosted, through the backend's real DeepgramStream client.
// Phrases are synthesized by Kokoro, converted to 8 kHz mu-law, and streamed in real time (20 ms frames).
// Usage (from repo root):
//   node --env-file=backend/.env voice-stt/bench.mjs [stt-url] [stt-key]
// Reports per-phrase transcript, word error rate, and latency from end of speech to the final transcript.
import { spawnSync } from "node:child_process";
import { DeepgramStream } from "../backend/voice-deepgram.js";

const [sttUrl = "ws://localhost:8001/v1/listen", sttKey = process.env.STT_API_KEY] = process.argv.slice(2);
// BENCH_PHRASES=file.json ([[voice, text], ...]) swaps the phrase set; BENCH_PROVIDERS=self-hosted skips Deepgram.
import { readFileSync } from "node:fs";
const PROVIDERS = (process.env.BENCH_PROVIDERS || "deepgram,self-hosted").split(",");
const DEFAULT_PHRASES = [
  ["af_heart", "Yes, go ahead and block those IP addresses."],
  ["am_michael", "Can you spin up another node to serve the web app?"],
  ["af_heart", "Implement rate limiting in the reverse proxy, put it on a new branch, and text me the pull request."],
  ["bf_emma", "What's the current request rate on the load balancer?"],
  ["am_michael", "Shut down web zero two but leave the database running."],
  ["bm_george", "No, wait. Don't do that yet."],
  ["af_bella", "Roll back the last commit on the payments service and rotate the Stripe secret key."],
  ["am_adam", "How many requests per second are we seeing from those five addresses?"],
];

const PHRASES = process.env.BENCH_PHRASES ? JSON.parse(readFileSync(process.env.BENCH_PHRASES, "utf8")) : DEFAULT_PHRASES;

async function speech(voice, text) {
  const res = await fetch(`${process.env.KOKORO_TTS_BASE_URL}/v1/audio/speech/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.KOKORO_TTS_API_KEY}` },
    body: JSON.stringify({ model: "kokoro", input: text, voice, response_format: "pcm" }),
  });
  if (!res.ok) throw new Error(`Kokoro ${res.status}`);
  const pcm = Buffer.from(await res.arrayBuffer());
  const out = spawnSync("ffmpeg", ["-loglevel", "error", "-f", "s16le", "-ar", "24000", "-ac", "1", "-i", "pipe:0", "-ar", "8000", "-f", "mulaw", "pipe:1"], { input: pcm, maxBuffer: 1 << 26 });
  return out.stdout;
}

const words = (s) => s.toLowerCase().replace(/[^a-z0-9' ]/g, " ").split(/\s+/).filter(Boolean);
function wer(ref, hyp) {
  const r = words(ref), h = words(hyp);
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]);
  for (let j = 1; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++) for (let j = 1; j <= h.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
  return d[r.length][h.length] / r.length;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SILENCE = Buffer.alloc(160, 0xff); // 20 ms of mu-law silence

// Time of the last audible 20 ms frame in the clip (Kokoro clips end with trailing silence).
function speechEndMs(audio) {
  const lin = (u) => { u = ~u & 0xff; const m = (((u & 0x0f) << 3) + 0x84) << ((u >> 4) & 7); return (u & 0x80 ? 0x84 - m : m - 0x84); };
  let last = 0;
  for (let i = 0; i < audio.length; i += 160) {
    let e = 0; for (let j = i; j < Math.min(i + 160, audio.length); j++) e += lin(audio[j]) ** 2;
    if (Math.sqrt(e / 160) > 500) last = i + 160;
  }
  return last / 8;
}

// Stream one utterance in real time. Collect every submitted turn (a split sentence submits twice);
// latency = last submission minus the moment speech actually ended.
function run(provider, audio) {
  const config = provider === "deepgram"
    ? { deepgramKey: process.env.DEEPGRAM_API, model: "nova-3", language: "en-US", endpointing: 300, utteranceEnd: 1000 }
    : { sttUrl, deepgramKey: sttKey, model: "nova-3", language: "en-US", endpointing: 300, utteranceEnd: 1000 };
  return new Promise((resolve) => {
    const stream = new DeepgramStream(config);
    const turns = [];
    let t0, lastAt, error;
    stream.on("fault", (e) => { error = e.message; });
    stream.on("utterance", (t) => { turns.push(t); lastAt = performance.now(); });
    stream.once("ready", async () => {
      for (let i = 0; i < 15; i++) { stream.audio(SILENCE); await sleep(20); }
      t0 = performance.now();
      for (let i = 0; i < audio.length; i += 160) {
        stream.audio(audio.subarray(i, i + 160));
        await sleep(Math.max(0, t0 + ((i / 160) + 1) * 20 - performance.now()));
      }
      for (let i = 0; i < 125; i++) { stream.audio(SILENCE); await sleep(20); }
      stream.close();
      const end = t0 + speechEndMs(audio);
      resolve({ text: turns.join(" "), turns: turns.length, ms: lastAt ? lastAt - end : undefined, error });
    });
  });
}

const rows = [];
for (const [voice, ref] of PHRASES) {
  const audio = await speech(voice, ref);
  for (const provider of PROVIDERS) {
    const r = await run(provider, audio);
    rows.push({ provider, voice, wer: wer(ref, r.text), ms: r.ms, turns: r.turns, text: r.text, error: r.error });
    console.log(`${provider.padEnd(11)} ${voice.padEnd(10)} WER ${(wer(ref, r.text) * 100).toFixed(0).padStart(3)}%  ${r.ms ? Math.round(r.ms) + "ms" : r.error || "no transcript"}${r.turns > 1 ? ` (split x${r.turns})` : ""}  "${r.text}"`);
  }
}
for (const provider of PROVIDERS) {
  const rs = rows.filter((r) => r.provider === provider);
  const ms = rs.filter((r) => r.ms).map((r) => r.ms).sort((a, b) => a - b);
  console.log(`\n${provider}: mean WER ${(rs.reduce((a, r) => a + r.wer, 0) / rs.length * 100).toFixed(1)}%, end-of-speech -> final: median ${Math.round(ms[ms.length >> 1])}ms, max ${Math.round(ms.at(-1))}ms, failures ${rs.length - ms.length}, split turns ${rs.filter((r) => r.turns > 1).length}`);
}
