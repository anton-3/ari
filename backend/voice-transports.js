import { setTimeout as sleep } from "node:timers/promises";
import { DeepgramStream } from "./voice-deepgram.js";
import { speechSegments, kokoroPcm, convertAudio, sendPacedFrames } from "./voice-audio.js";
import { GREETING } from "./voice-prompts.js";
import { providerFetch } from "./voice-http.js";

export class RelayTransport {
  constructor(session, ws, config) {
    Object.assign(this, { session, ws, config });
    this.stack = "twilio";
    this.interruptible = true;
  }
  send(message) {
    if (this.ws.readyState !== 1) throw new Error("Relay disconnected");
    this.ws.send(JSON.stringify(message));
  }
  async speak(text, turn, interruptible = true) {
    if (turn?.aborted) return;
    this.interruptible = interruptible;
    this.send({ type: "text", token: text, last: true, interruptible });
    this.session.recordSpoken(text, turn);
    // Relay supplies exact heard text on interruption. It owns playback pacing.
    this.interruptible = true;
  }
  async play(file, turn, interruptible = true) {
    if (turn?.aborted) return;
    this.send({ type: "play", source: `https://${this.config.host}/${file}`, loop: 1, interruptible, preemptible: false });
    if (!interruptible) {
      this.interruptible = false;
      try { await sleep(Number(process.env.EGG_SOUND_MS || 4200), undefined, { signal: turn.controller.signal }); }
      finally { this.interruptible = true; }
    }
  }
  clear() { /* Twilio has already cleared Relay speech when it emits interrupt. */ }
  async end() { this.send({ type: "end", handoffData: '{"reason":"bogos"}' }); }
  dispose() { this.ws.close(); }
}

export class MediaTransport {
  constructor(session, ws, streamSid, config, { fallback, end, release, Deepgram = DeepgramStream, fetcher = providerFetch, greetingCache = new Map() } = {}) {
    Object.assign(this, { session, ws, streamSid, config, fallback, endCall: end, release, fetcher, greetingCache });
    this.stack = "custom";
    this.ready = false;
    this.interruptible = true;
    this.marks = new Map();
    this.markCounter = 0;
    this.dg = new Deepgram(config);
    this.dg.on("fault", (error) => this.fail(error));
    this.dg.on("utterance", (text, wordEnd) => {
      session.log(session, "utterance_final", { at: Date.now(), speechToFinalMs: this.audioEpoch !== undefined && wordEnd !== undefined ? Math.max(0, performance.now() - this.audioEpoch - wordEnd * 1000) : undefined });
      session.enqueue(text);
    });
    this.dg.on("speechStarted", () => {
      if (this.interruptible && (this.playback || session.current)) {
        const started = performance.now();
        session.interrupt();
        session.log(session, "clear_sent", { ms: performance.now() - started });
      }
    });
    this.dg.on("metadata", (modelInfo) => session.log(session, "stt_model", { modelInfo }));
    this.dg.on("ready", () => { void this.greet(); });
  }

  async greet() {
    try {
      if (!this.session.queue.length) await this.output(this.session.greeting, null, true, null, this.session.greeting === GREETING);
      if (this.closed) return;
      this.ready = true;
      void this.session.drain();
    } catch (error) { this.fail(error); }
  }

  send(message) {
    if (this.closed || this.ws.readyState !== 1) throw new Error("Media disconnected");
    this.ws.send(JSON.stringify({ ...message, streamSid: this.streamSid }));
  }

  receive(message) {
    if (this.closed) return;
    if (message.event === "media" && message.media?.track === "inbound") {
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(message.media.payload || "") || message.media.payload.length > 16000) {
        return this.fail(new Error("Invalid Twilio audio payload"));
      }
      const bytes = Buffer.from(message.media.payload, "base64");
      // Map Deepgram's sample clock to arrival time, including transport pauses.
      this.receivedBytes ??= 0;
      this.audioEpoch = performance.now() - this.receivedBytes / 8;
      this.receivedBytes += bytes.length;
      this.dg.audio(bytes);
    }
    if (message.event === "mark") {
      const pending = this.marks.get(message.mark?.name);
      if (!pending) return;
      this.marks.delete(message.mark.name);
      clearTimeout(pending.timer);
      if (pending.generation === this.session.generation && !pending.controller.signal.aborted) {
        this.session.recordSpoken(pending.text, pending.turn);
        this.session.log(this.session, "playback_complete", { mark: message.mark.name });
      }
      pending.resolve();
    }
  }

  ack(text, turn, controller) {
    controller.signal.throwIfAborted();
    const name = `${this.session.generation}-${++this.markCounter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.marks.delete(name);
        reject(new Error("Twilio playback acknowledgement timeout"));
      }, 3000);
      this.marks.set(name, { resolve, reject, timer, text, turn, controller, generation: this.session.generation });
      try { this.send({ event: "mark", mark: { name } }); }
      catch (error) { clearTimeout(timer); this.marks.delete(name); reject(error); }
    });
  }

  async output(text, turn, interruptible, file = null, cacheGreeting = false) {
    if (turn?.aborted || this.closed) return;
    const controller = new AbortController();
    const abort = () => controller.abort(turn.controller.signal.reason);
    turn?.controller.signal.addEventListener("abort", abort, { once: true });
    this.playback = controller;
    this.interruptible = interruptible;
    const started = performance.now();
    let first = true;
    try {
      for (const segment of file ? [""] : speechSegments(text)) {
        controller.signal.throwIfAborted();
        this.playbackSegment = segment;
        const cacheKey = `${this.config.kokoroUrl}:${this.config.voice}:${this.config.speed}`;
        const cached = cacheGreeting && this.greetingCache.get(cacheKey);
        const generated = [];
        const pcm = file ? null : kokoroPcm(this.config, segment, controller.signal, this.fetcher);
        const frames = cached ? (async function* () { yield* cached; })() : convertAudio(pcm, controller.signal, file);
        await sendPacedFrames(frames, (bytes) => {
          if (cacheGreeting && !cached) generated.push(Buffer.from(bytes));
          if (first) {
            first = false;
            this.session.log(this.session, "first_audio", { ms: performance.now() - started });
          }
          this.send({ event: "media", media: { payload: bytes.toString("base64") } });
        }, controller.signal, () => this.ws.bufferedAmount || 0);
        if (cacheGreeting && !cached) this.greetingCache.set(cacheKey, generated);
        await this.ack(segment, turn, controller);
        this.playbackSegment = null;
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        this.fail(error);
        throw error;
      }
    } finally {
      controller.abort();
      turn?.controller.signal.removeEventListener("abort", abort);
      if (this.playback === controller) {
        this.playback = null;
        this.interruptible = true;
      }
    }
  }

  speak(text, turn, interruptible = true) { return this.output(text, turn, interruptible); }
  play(file, turn, interruptible = true) { return this.output("", turn, interruptible, file); }

  clear(force = false) {
    if (!force && !this.interruptible) return;
    if (this.playbackSegment) {
      this.session.interruptedSpeech = { text: this.playbackSegment, at: Date.now(), generation: this.session.generation };
      this.playbackSegment = null;
    }
    this.playback?.abort();
    for (const pending of this.marks.values()) {
      clearTimeout(pending.timer);
      pending.resolve(); // Cleared audio must never be recorded as heard.
    }
    this.marks.clear();
    if (!this.closed && this.ws.readyState === 1) this.send({ event: "clear" });
  }

  fail(error) {
    if (this.closed || this.failed) return;
    this.failed = true;
    this.session.log(this.session, "audio_failure", { reason: error.message });
    void this.fallback(this.session).catch(() => this.endCall(this.session));
  }

  async end() {
    this.session.ended = true;
    await this.endCall(this.session);
  }

  dispose() {
    if (this.closed) return;
    this.clear(true);
    this.closed = true;
    this.dg.close();
    this.ws.close();
    this.release(this.session);
  }
}
