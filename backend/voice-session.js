import { randomBytes } from "node:crypto";
import { SYSTEM_PROMPT, GREETING } from "./voice-prompts.js";

const READ_ONLY_TOOLS = new Set(["list_instances", "list_agents", "get_incident", "get_live_metrics"]);
const ordered = (value) => Array.isArray(value) ? value.map(ordered) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, ordered(value[key])])) : value;

export function voiceLog(session, event, fields = {}) {
  console.log(JSON.stringify({ component: "voice", callSid: session.callSid, stack: session.transport?.stack || (session.custom && !session.fallback ? "custom" : "twilio"), event, ...fields }));
}

export class CallSession {
  constructor({ callSid, greeting = GREETING, prompt = "", complete, dispatch, log = voiceLog, incidentId, recipient, onClose }) {
    Object.assign(this, { callSid, greeting, complete, dispatch, log, onClose });
    this.context = { callSid, incidentId, recipient };
    this.startedAt = new Date();
    this.actionLog = []; // every tool Ari ran this call, for the postmortem
    this.token = randomBytes(32).toString("base64url");
    this.systemPrompt = SYSTEM_PROMPT + (prompt ? `\n\nInstructions for this call:\n${prompt}` : "");
    this.messages = [];
    this.queue = [];
    this.operations = new Map();
    this.generation = 0;
    this.alive = true;
    this.needsResume = false;
  }

  attach(transport) {
    this.transport = transport;
    this.lastSpokenTurn = null;
    this.disconnectedAt = null;
  }

  recordSpoken(text, turn) {
    if (!text || (turn && (turn.aborted || this.current !== turn))) return;
    if (turn?.spokenMessage) turn.spokenMessage.content += ` ${text}`;
    else {
      const entry = { role: "assistant", content: text };
      this.messages.push(entry);
      if (turn) turn.spokenMessage = entry;
    }
    if (turn) this.lastSpokenTurn = turn;
  }

  interrupt(heard) {
    if (this.transport?.interruptible === false) return;
    this.generation++;
    const turn = this.current || this.lastSpokenTurn;
    if (turn) {
      turn.aborted = true;
      turn.controller.abort();
      if (heard !== undefined && turn.spokenMessage) {
        if (heard) turn.spokenMessage.content = heard;
        else this.messages.splice(this.messages.indexOf(turn.spokenMessage), 1);
      }
    }
    this.transport?.clear();
    this.log(this, "interrupt");
  }

  enqueue(text) {
    if (!this.alive || !text?.trim()) return;
    this.queue.push(text.trim());
    this.log(this, "turn_queued", { depth: this.queue.length });
    void this.drain();
  }

  resume() {
    this.needsResume = true;
    void this.drain();
  }

  async drain() {
    if (this.running || !this.transport || this.transport.ready === false || !this.alive) return;
    this.running = true;
    try {
      while (this.alive && this.transport && this.transport.ready !== false && (this.queue.length || this.needsResume)) {
        const text = this.queue.splice(0).join(" ");
        this.needsResume = false;
        if (text) {
          // A new caller request may legitimately ask to repeat an action. A
          // transport fallback, however, must retain the prior operation ledger.
          if (!this.context.incidentId) this.operations.clear();
          const last = this.messages.at(-1);
          if (last?.role === "user") last.content += ` ${text}`;
          else this.messages.push({ role: "user", content: text });
        }
        const turn = { controller: new AbortController(), generation: this.generation };
        this.current = turn;
        try {
          await this.respond(turn);
        } catch (error) {
          if (!turn.aborted && this.transport) {
            this.log(this, "response_error", { error: error.name });
            try { await this.transport.speak("Sorry, I hit a snag. Could you say that again?", turn); }
            catch { /* The audio adapter initiates fallback on provider failure. */ }
          }
        } finally {
          if (this.current === turn) this.current = null;
        }
      }
    } finally {
      this.running = false;
    }
  }

  async respond(turn) {
    for (let step = 0; step < 6; step++) {
      if (turn.aborted || !this.alive) return;
      const started = performance.now();
      const choice = await this.complete([{ role: "system", content: this.systemPrompt }, ...this.messages], turn.controller.signal);
      this.log(this, "model_complete", { ms: performance.now() - started, step });
      if (turn.aborted || !this.alive) return;
      if (choice.tool_calls?.length) {
        this.messages.push(choice);
        for (const call of choice.tool_calls) {
          let result;
          if (turn.aborted || !this.alive) result = "Not executed: caller interrupted before dispatch.";
          else {
            let args;
            try {
              args = JSON.parse(call.function.arguments || "{}");
              if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Invalid arguments");
            }
            catch { args = undefined; result = "Not executed: invalid tool arguments."; }
            if (args) {
              const key = `${call.function.name}:${JSON.stringify(ordered(args))}`;
              const previous = this.operations.get(key);
              if (!READ_ONLY_TOOLS.has(call.function.name) && previous !== undefined) {
                result = `Not executed again: this action was already dispatched for the current request. Previous outcome: ${previous}`;
                this.messages.push({ role: "tool", tool_call_id: call.id, content: result });
                continue;
              }
              const started = performance.now();
              // A dispatched operation is never retried or discarded on interruption.
              try { result = await this.dispatch(call.function.name, args, this.context); }
              catch { result = "Tool failed; outcome may be uncertain. Do not retry automatically. Verify current state first."; }
              this.actionLog.push({ at: new Date().toISOString(), name: call.function.name, args, result: typeof result === "string" ? result : JSON.stringify(result) });
              if (!READ_ONLY_TOOLS.has(call.function.name)) this.operations.set(key, typeof result === "string" ? result : JSON.stringify(result));
              this.log(this, "tool_complete", { name: call.function.name, ms: performance.now() - started });
            }
          }
          this.messages.push({ role: "tool", tool_call_id: call.id, content: typeof result === "string" ? result : JSON.stringify(result) });
        }
        continue;
      }
      const effects = [];
      const spoken = (choice.content || "").replace(/\[(rizz)\]/gi, (_, tag) => { effects.push(`${tag.toLowerCase()}.mp3`); return ""; }).replace(/\s+/g, " ").trim();
      if (spoken) await this.transport.speak(spoken, turn);
      for (const file of effects) {
        if (turn.aborted || !this.transport) return;
        await this.transport.play(file, turn);
      }
      return;
    }
    if (!turn.aborted) await this.transport.speak("Let me stop there and pick this up again in a moment.", turn);
  }

  disconnect() {
    this.interrupt();
    this.current?.controller.abort();
    if (this.current) this.current.aborted = true;
    // Retained conversation history is not an active transport/call. Keeping
    // this flag set blocks demo reset and prevents a legitimate reconnect.
    this.bound = false;
    this.transport = null;
    this.disconnectedAt = Date.now();
  }

  close() {
    if (this.alive) this.onClose?.(this);
    this.alive = false;
    this.bound = false;
    this.current?.controller.abort();
    this.transport?.dispose();
    this.transport = null;
    this.queue = [];
  }
}

export class SessionStore {
  constructor(create, { reservationMs = 30000, retentionMs = 300000 } = {}) {
    this.createSession = create;
    this.reservationMs = reservationMs;
    this.retentionMs = retentionMs;
    this.sessions = new Map();
    this.byCall = new Map();
    this.timer = setInterval(() => this.sweep(), 1000).unref();
  }
  create(data, custom) {
    const existing = this.byCall.get(data.callSid);
    if (existing) return existing;
    const session = this.createSession(data);
    session.custom = custom && !this.slot;
    session.reservedAt = Date.now();
    if (session.custom) this.slot = session;
    this.sessions.set(session.token, session);
    this.byCall.set(session.callSid, session);
    return session;
  }
  bind(token, callSid, mode) {
    const session = this.sessions.get(token);
    if (!session?.alive || session.callSid !== callSid || session.bound || (mode === "custom" && (!session.custom || session.fallback)) || (mode === "twilio" && session.custom && !session.fallback)) return null;
    session.bound = true;
    session.reservedAt = null;
    return session;
  }
  release(session) {
    if (this.slot === session) this.slot = null;
  }
  remove(session) {
    this.release(session);
    session.close();
    this.sessions.delete(session.token);
    this.byCall.delete(session.callSid);
  }
  sweep(now = Date.now()) {
    for (const session of this.sessions.values()) {
      if ((session.reservedAt && now - session.reservedAt >= this.reservationMs) || (session.disconnectedAt && now - session.disconnectedAt >= this.retentionMs)) this.remove(session);
    }
  }
  close() {
    clearInterval(this.timer);
    for (const session of [...this.sessions.values()]) this.remove(session);
  }
}
