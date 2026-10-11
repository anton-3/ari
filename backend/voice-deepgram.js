import { EventEmitter } from "node:events";
import WebSocket from "ws";

// Nova's finalized segments and endpoint events are separate; deduplicate both.
export class TranscriptBuffer {
  constructor(submit) {
    this.submit = submit;
    this.parts = [];
    this.seen = new Set();
    this.submittedEnd = -1;
  }
  accept(message) {
    if (message.type === "UtteranceEnd") {
      if (message.last_word_end > this.submittedEnd) this.flush();
      return;
    }
    if (message.type !== "Results") return;
    const alternative = message.channel?.alternatives?.[0];
    const text = alternative?.transcript?.trim();
    const end = alternative?.words?.at(-1)?.end ?? ((message.start || 0) + (message.duration || 0));
    const key = `${message.start}:${end}`;
    if (message.is_final && text && end > this.submittedEnd && !this.seen.has(key)) {
      this.seen.add(key);
      this.parts.push({ text, end });
    }
    if (message.speech_final) this.flush();
  }
  flush() {
    if (!this.parts.length) return;
    const text = this.parts.map((p) => p.text).join(" ");
    this.submittedEnd = Math.max(...this.parts.map((p) => p.end));
    this.parts = [];
    this.seen.clear();
    this.submit(text, this.submittedEnd);
  }
}

export class DeepgramStream extends EventEmitter {
  constructor(config, { Socket = WebSocket } = {}) {
    super();
    const url = new URL(config.sttUrl || "wss://api.deepgram.com/v1/listen");
    const params = {
      model: config.model, language: config.language,
      encoding: "mulaw", sample_rate: 8000, channels: 1,
      interim_results: true, vad_events: true, punctuate: true, smart_format: true,
      endpointing: config.endpointing, utterance_end_ms: config.utteranceEnd,
    };
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    this.buffer = [];
    this.bytes = 0;
    this.lastAudio = Date.now();
    this.transcripts = new TranscriptBuffer((text, end) => this.emit("utterance", text, end));
    // This deployment's dual-stack DNS lookup delays the handshake by ~5s.
    // Deepgram supports IPv4; select it so startup stays inside the audio budget.
    this.ws = new Socket(url, { headers: { Authorization: `Token ${config.deepgramKey}` }, family: 4, handshakeTimeout: 5000 });
    this.ws.on("open", () => {
      if (this.closed) return;
      for (const audio of this.buffer) this.ws.send(audio);
      this.buffer = [];
      this.bytes = 0;
      this.emit("ready");
    });
    this.ws.on("message", (raw) => {
      if (this.closed) return;
      try {
        const message = JSON.parse(raw);
        if (message.type === "Error") return this.emit("fault", new Error("Deepgram provider error"));
        if (message.type === "SpeechStarted") this.emit("speechStarted");
        if (message.type === "Metadata") this.emit("metadata", message.model_info);
        this.transcripts.accept(message);
      } catch { this.emit("fault", new Error("Invalid Deepgram message")); }
    });
    this.ws.on("error", (error) => {
      if (!this.closed) {
        const status = /Unexpected server response: (\d+)/.exec(error.message)?.[1];
        const detail = status ? `HTTP ${status}` : (error.code || "handshake/network error");
        this.emit("fault", new Error(`Deepgram connection failed (${detail})`));
      }
    });
    this.ws.on("close", () => { if (!this.closed) this.emit("fault", new Error("Deepgram connection closed")); });
    this.keepalive = setInterval(() => {
      if (this.ws.readyState === WebSocket.OPEN && Date.now() - this.lastAudio >= 3000) this.ws.send(JSON.stringify({ type: "KeepAlive" }));
    }, 3000).unref();
  }
  audio(bytes) {
    if (this.closed) return;
    this.lastAudio = Date.now();
    if (this.ws.readyState === WebSocket.OPEN) {
      if (this.ws.bufferedAmount > 16000) return this.emit("fault", new Error("Deepgram audio backlog"));
      this.ws.send(bytes);
    } else {
      this.bytes += bytes.length;
      if (this.bytes > 16000) return this.emit("fault", new Error("Deepgram startup audio overflow"));
      this.buffer.push(bytes);
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.keepalive);
    this.buffer = [];
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "CloseStream" }));
      this.ws.close();
    } else this.ws.terminate();
  }
}
