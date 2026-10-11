import { spawnSync } from "node:child_process";

export function voiceConfig(env = process.env, checkFfmpeg = true) {
  const number = (key, fallback, min, max) => {
    const n = Number(env[key] || fallback);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`Invalid ${key}`);
    return n;
  };
  const stack = env.ARI_VOICE_STACK || "custom";
  const deepgram = stack === "custom-with-deepgram";
  const config = {
    stack,
    host: env.PUBLIC_HOST,
    twilioToken: env.TWILIO_AUTH_TOKEN,
    twilioSid: env.TWILIO_SID,
    ttsProvider: env.TTS_PROVIDER || "ElevenLabs",
    ttsVoice: env.TTS_VOICE || "cjVigY5qzO86Huf0OWal",
    // custom transcribes with the self-hosted STT on the voice-model node (voice-stt/), which speaks
    // Deepgram's streaming /v1/listen protocol, so the Deepgram client and its option names are reused.
    // custom-with-deepgram keeps Kokoro but sends the same stream to Deepgram itself.
    sttUrl: deepgram ? "wss://api.deepgram.com/v1/listen" : env.STT_URL,
    deepgramKey: deepgram ? env.DEEPGRAM_API : env.STT_API_KEY,
    model: deepgram ? env.DEEPGRAM_MODEL || "nova-3" : "parakeet-tdt-0.6b-v2",
    language: "en-US",
    endpointing: number("STT_ENDPOINTING_MS", 300, 50, 2000),
    utteranceEnd: 1000,
    kokoroUrl: env.KOKORO_TTS_BASE_URL?.replace(/\/$/, ""),
    kokoroKey: env.KOKORO_TTS_API_KEY,
    voice: env.KOKORO_TTS_VOICE || "af_heart",
    speed: number("KOKORO_TTS_SPEED", 1, 0.5, 2),
  };
  if (!["twilio", "custom", "custom-with-deepgram"].includes(stack)) throw new Error("ARI_VOICE_STACK must be twilio, custom or custom-with-deepgram");
  if (stack !== "twilio") {
    for (const key of ["PUBLIC_HOST", "TWILIO_SID", "TWILIO_AUTH_TOKEN", ...(deepgram ? ["DEEPGRAM_API"] : ["STT_URL", "STT_API_KEY"]), "KOKORO_TTS_BASE_URL", "KOKORO_TTS_API_KEY"]) {
      if (!env[key]?.trim()) throw new Error(`Custom voice requires ${key}`);
    }
    if (deepgram && !/^nova-(2|3)(-|$)/.test(config.model)) throw new Error("DEEPGRAM_MODEL must use the Nova v1 streaming protocol; Flux is not supported");
    const stt = new URL(config.sttUrl);
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(stt.hostname);
    if (stt.protocol !== "wss:" && !(stt.protocol === "ws:" && local)) throw new Error("STT_URL must use WSS (WS is allowed for localhost only)");
    const url = new URL(config.kokoroUrl);
    if (url.protocol !== "https:") throw new Error("KOKORO_TTS_BASE_URL must use HTTPS");
    if (checkFfmpeg && spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status !== 0) {
      throw new Error("Custom voice requires ffmpeg on PATH");
    }
  }
  return config;
}

export const xmlEscape = (value) => String(value).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]);

export function relayTwiml(config, session, fallback = false) {
  const greeting = fallback ? "I switched audio connections." : session.greeting;
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect>
    <ConversationRelay url="wss://${xmlEscape(config.host)}/relay" welcomeGreeting="${xmlEscape(greeting)}" interruptible="any"
      ttsProvider="${xmlEscape(config.ttsProvider)}" voice="${xmlEscape(config.ttsVoice)}" elevenlabsTextNormalization="on"
      transcriptionProvider="Deepgram" speechModel="nova-3-general" transcriptionLanguage="en-US">
      <Parameter name="session" value="${xmlEscape(session.token)}" />
    </ConversationRelay></Connect></Response>`;
}

export function fallbackUrl(config, session) {
  return `https://${config.host}/voice/fallback?session=${encodeURIComponent(session.token)}`;
}

export function mediaTwiml(config, session) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect>
    <Stream url="wss://${xmlEscape(config.host)}/media"><Parameter name="session" value="${xmlEscape(session.token)}" /></Stream>
    </Connect><Redirect method="POST">${xmlEscape(fallbackUrl(config, session))}</Redirect></Response>`;
}
