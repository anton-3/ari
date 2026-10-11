import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { providerFetch } from "./voice-http.js";

export const SOUND_FILES = new Set(["bogos.mp3", "canes-ramp.mp3", "laugh.mp3", "rizz.mp3"]);

export function speechSegments(text) {
  const parts = [];
  let remaining = text.trim();
  while (remaining) {
    const limit = parts.length ? 160 : 80;
    if (remaining.length <= limit) { parts.push(remaining); break; }
    const head = remaining.slice(0, limit + 1);
    const sentence = [...head.matchAll(/[.!?;:]\s/g)].at(-1)?.index;
    let cut = sentence !== undefined ? sentence + 1 : head.lastIndexOf(" ");
    if (cut <= 0) cut = limit;
    parts.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  return parts;
}

export async function* audioFrames(source, frameSize = 160) {
  let pending = Buffer.alloc(0);
  for await (const bytes of source) {
    pending = Buffer.concat([pending, bytes]);
    while (pending.length >= frameSize) {
      yield pending.subarray(0, frameSize);
      pending = pending.subarray(frameSize);
    }
  }
  if (pending.length) yield pending;
}

async function timed(promise, ms, signal, label) {
  let timer;
  let abort;
  try {
    signal?.throwIfAborted();
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), ms);
        abort = () => reject(signal.reason || new Error("Aborted"));
        signal?.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}

export async function* kokoroPcm(config, text, signal, fetcher = providerFetch) {
  const started = performance.now();
  // Timeout must also cancel the underlying HTTP request, not just stop awaiting it.
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  let reader;
  try {
    signal?.throwIfAborted();
    const response = await timed(fetcher(`${config.kokoroUrl}/v1/audio/speech/stream`, {
      method: "POST", signal: controller.signal,
      headers: { Authorization: `Bearer ${config.kokoroKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "kokoro", input: text, voice: config.voice, speed: config.speed, response_format: "pcm" }),
    }), 3000, signal, "Kokoro first-audio timeout");
    if (!response.ok) throw new Error(`Kokoro HTTP ${response.status}`);
    if (response.headers.get("x-audio-format") !== "pcm_s16le" || response.headers.get("x-sample-rate") !== "24000") throw new Error("Unexpected Kokoro audio format");
    reader = response.body.getReader();
    let total = 0;
    while (true) {
      const firstBudget = Math.max(1, 3000 - (performance.now() - started));
      const result = await timed(reader.read(), total ? 3000 : firstBudget, signal, "Kokoro audio stalled");
      if (result.done) break;
      total += result.value.length;
      yield Buffer.from(result.value);
    }
    if (!total || total % 2) throw new Error("Invalid Kokoro PCM length");
  } finally {
    controller.abort();
    await reader?.cancel().catch(() => {});
    signal?.removeEventListener("abort", abort);
  }
}

export async function* convertAudio(source, signal, file = null) {
  if (file && !SOUND_FILES.has(file)) throw new Error("Unknown sound effect");
  const input = file
    ? ["-i", fileURLToPath(new URL(`./public/${file}`, import.meta.url))]
    : ["-probesize", "32", "-analyzeduration", "0", "-f", "s16le", "-ar", "24000", "-ac", "1", "-i", "pipe:0"];
  const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", ...input, "-ar", "8000", "-ac", "1", "-f", "mulaw", "-flush_packets", "1", "pipe:1"], { stdio: [file ? "ignore" : "pipe", "pipe", "pipe"] });
  child.stderr.resume();
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`Audio conversion failed (${code})`)));
  });
  // Avoid unhandled rejection while stdout is still being consumed.
  exited.catch(() => {});
  child.stdin?.on("error", () => {});
  const abort = () => { child.kill("SIGKILL"); child.stdout.destroy(signal.reason); };
  signal.addEventListener("abort", abort, { once: true });
  let feedError;
  const feeding = file ? Promise.resolve() : (async () => {
    try {
      for await (const bytes of source) {
        signal.throwIfAborted();
        if (!child.stdin.write(bytes)) await once(child.stdin, "drain", { signal });
      }
      child.stdin.end();
    } catch (error) {
      feedError = error;
      child.kill("SIGKILL");
      child.stdout.destroy(error);
    }
  })();
  try {
    signal.throwIfAborted();
    yield* audioFrames(child.stdout);
    await feeding;
    if (feedError) throw feedError;
    await exited;
  } finally {
    child.kill("SIGKILL");
    signal.removeEventListener("abort", abort);
    // Aborting the transport also aborts the source HTTP request.
  }
}

export async function sendPacedFrames(frames, send, signal, buffered = () => 0) {
  let started;
  let audioMs = 0;
  for await (const frame of frames) {
    signal.throwIfAborted();
    started ??= performance.now();
    const lead = audioMs - (performance.now() - started);
    if (lead > 180) await sleep(lead - 180, undefined, { signal });
    if (buffered() > 16000) throw new Error("Twilio playback socket backlog");
    send(frame);
    audioMs += frame.length / 8;
  }
  return audioMs;
}
