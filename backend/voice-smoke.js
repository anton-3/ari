// Real provider inference, synthetic telephone audio, no phone calls or real tools.
import OpenAI from 'openai';
import { voiceConfig } from './voice-config.js';
import { CallSession } from './voice-session.js';
import { MediaTransport } from './voice-transports.js';
import { kokoroPcm, convertAudio, sendPacedFrames } from './voice-audio.js';
import * as linode from './linode.js';
import * as actions from './actions.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { providerFetch } from './voice-http.js';
import { INCIDENT_GREETING, incidentPrompt } from './incident.js';

// Always a custom-audio run; ARI_VOICE_STACK=custom-with-deepgram picks Deepgram for the STT leg.
const config = voiceConfig({ ...process.env, ARI_VOICE_STACK: process.env.ARI_VOICE_STACK === 'custom-with-deepgram' ? 'custom-with-deepgram' : 'custom' });
const client = new OpenAI({ fetch: providerFetch });
const tools = [...linode.tools, ...actions.tools];
const events = [];
let failed;
let transport;
let audioBytes = 0;
const session = new CallSession({
  callSid: 'synthetic-provider-smoke',
  ...(process.argv.includes('--incident-greeting') ? { greeting: INCIDENT_GREETING, prompt: incidentPrompt() } : {}),
  log: (_s, event, fields) => {
    const item = { event, ...fields }; events.push(item); console.log(JSON.stringify(item));
  },
  complete: async (messages, signal) => {
    const result = await client.chat.completions.create({ model: process.env.CHAT_MODEL || 'hackathon-chat', messages, tools, max_tokens: 128 }, { signal, timeout: 30000, maxRetries: 0 });
    return result.choices[0].message;
  },
  dispatch: async () => 'Smoke test: no infrastructure action was executed.',
});
const ws = {
  readyState: 1, bufferedAmount: 0,
  send(raw) {
    const message = JSON.parse(raw);
    if (message.event === 'media') audioBytes += Buffer.from(message.media.payload, 'base64').length;
    if (message.event === 'mark') setTimeout(() => transport.receive(message), 200);
  },
  close() { this.readyState = 3; },
};
transport = new MediaTransport(session, ws, 'synthetic-stream', config, {
  fallback: async () => { failed = new Error('Provider failed; see stage logs'); session.close(); },
  end: async () => session.close(), release() {},
});
session.attach(transport);
if (process.argv.includes('--answer-during-greeting')) {
  transport.dg.once('ready', () => {
    transport.dg.emit('speechStarted');
    transport.dg.emit('utterance', 'Hello Ari, you are on speaker.', 0);
  });
}
async function waitFor(check, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (failed) throw failed;
    if (Date.now() > deadline) throw new Error('Smoke test timed out');
    await sleep(25);
  }
}
try {
  await waitFor(() => transport.ready);
  await waitFor(() => !session.running);
  for (const text of ['Hello Ari. Please tell me your name.', 'Please say the word MyFiat.']) {
    const before = session.messages.filter((m) => m.role === 'user').length;
    const signal = new AbortController().signal;
    const frames = convertAudio(kokoroPcm(config, text, signal), signal);
    await sendPacedFrames(frames, (bytes) => transport.receive({ event: 'media', media: { track: 'inbound', payload: bytes.toString('base64') } }), signal);
    // Endpointing needs real silence after each utterance.
    for (let i = 0; i < 75; i++) {
      transport.receive({ event: 'media', media: { track: 'inbound', payload: Buffer.alloc(160, 255).toString('base64') } });
      await sleep(20);
    }
    await waitFor(() => session.messages.filter((m) => m.role === 'user').length > before && !session.running);
  }
  console.log(JSON.stringify({ ok: true, turns: session.messages.filter((m) => m.role === 'user').length, outputAudioSeconds: audioBytes / 8000, firstAudioMs: events.filter((e) => e.event === 'first_audio').map((e) => e.ms), note: 'Synthetic audio; no PSTN call or real tool actions.' }));
} finally {
  session.close();
}
