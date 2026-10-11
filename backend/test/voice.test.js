import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { voiceConfig, mediaTwiml, relayTwiml } from '../voice-config.js';
import { TranscriptBuffer, DeepgramStream } from '../voice-deepgram.js';
import { CallSession, SessionStore } from '../voice-session.js';
import { audioFrames, speechSegments, convertAudio, kokoroPcm, sendPacedFrames } from '../voice-audio.js';
import { MediaTransport, RelayTransport, warmGreeting, greetingIsReady } from '../voice-transports.js';

const config = {
  stack: 'custom', host: 'example.test', twilioSid: 'ACtest', twilioToken: 'test-token',
  deepgramKey: 'fake-secret', model: 'nova-3', language: 'en-US', endpointing: 300, utteranceEnd: 1000,
  kokoroUrl: 'https://kokoro.test', kokoroKey: 'fake-secret', voice: 'af_heart', speed: 1,
  ttsProvider: 'ElevenLabs', ttsVoice: 'Eric',
};
const session = (overrides = {}) => new CallSession({ callSid: 'CAtest', complete: async () => ({ role: 'assistant', content: 'Hello there.' }), dispatch: async () => 'done', log: () => {}, ...overrides });
async function until(check) {
  for (let i = 0; i < 1000; i++) { if (check()) return; await sleep(5); }
  assert.fail('condition timed out');
}
function attach(s) {
  const said = [];
  s.attach({ ready: true, interruptible: true, clear() {}, dispose() {}, async speak(t, turn) { said.push(t); s.recordSpoken(t, turn); }, async play() {}, async end() {} });
  return said;
}
const final = (text, start, end, speechFinal = false) => ({ type: 'Results', is_final: true, speech_final: speechFinal, start, duration: end - start, channel: { alternatives: [{ transcript: text, words: text ? [{ end }] : [] }] } });

// These tests cover behavioral invariants, rather than only mirroring config fields.
test('configuration permits existing mode without custom keys, rejects incomplete custom and unsupported protocol', () => {
  assert.equal(voiceConfig({ ARI_VOICE_STACK: 'twilio' }, false).stack, 'twilio');
  assert.throws(() => voiceConfig({}, false), /PUBLIC_HOST/);
  assert.throws(() => voiceConfig({ ARI_VOICE_STACK: 'other' }, false));
  assert.throws(() => voiceConfig({ ARI_VOICE_STACK: 'custom' }, false), /PUBLIC_HOST/);
  const env = { ARI_VOICE_STACK: 'custom', PUBLIC_HOST: 'example.test', TWILIO_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'token', DEEPGRAM_API: 'key', KOKORO_TTS_BASE_URL: 'https://kokoro.test', KOKORO_TTS_API_KEY: 'key' };
  assert.equal(voiceConfig(env, false).model, 'nova-3');
  const { ARI_VOICE_STACK, ...defaultEnv } = env;
  assert.equal(voiceConfig(defaultEnv, false).stack, 'custom');
  assert.throws(() => voiceConfig({ ...env, DEEPGRAM_MODEL: 'flux-general-en' }, false), /Flux/);
  assert.throws(() => voiceConfig({ ...env, DEEPGRAM_UTTERANCE_END_MS: '300' }, false));
});
test('TwiML escapes greeting, carries opaque session only, and fallback changes greeting', () => {
  const s = session({ greeting: 'Hello <friend> & "you"', prompt: 'private incident context' });
  assert.match(relayTwiml(config, s), /Hello &lt;friend&gt; &amp; &quot;you&quot;/);
  assert.match(relayTwiml(config, s, true), /I switched audio connections/);
  assert.match(mediaTwiml(config, s), /<Connect>\s*<Stream/);
  assert.doesNotMatch(mediaTwiml(config, s), /private incident context/);
});
test('Nova final segments are accumulated and endpoint/utterance-end duplicates do not submit twice', () => {
  const turns = [];
  const b = new TranscriptBuffer((t) => turns.push(t));
  b.accept({ ...final('interim', 0, 1), is_final: false });
  b.accept(final('Please block', 0, 1));
  b.accept(final('Please block', 0, 1));
  assert.deepEqual(turns, []);
  b.accept(final('those addresses', 1, 2, true));
  b.accept({ type: 'UtteranceEnd', last_word_end: 2 });
  b.accept(final('those addresses', 1, 2, true));
  assert.deepEqual(turns, ['Please block those addresses']);
  b.accept(final('Thank you', 3, 4));
  b.accept({ type: 'UtteranceEnd', last_word_end: 4 });
  b.accept(final('', 4, 5, true));
  assert.deepEqual(turns, ['Please block those addresses', 'Thank you']);
});
test('session reservations enforce one custom call, token binding and expiration', () => {
  const store = new SessionStore((data) => session(data), { reservationMs: 10, retentionMs: 10 });
  const a = store.create({ callSid: 'CAa' }, true);
  const b = store.create({ callSid: 'CAb' }, true);
  assert.equal(a.custom, true); assert.equal(b.custom, false);
  assert.equal(store.bind(a.token, 'wrong', 'custom'), null);
  assert.equal(store.bind(a.token, 'CAa', 'twilio'), null);
  assert.equal(store.bind(a.token, 'CAa', 'custom'), a);
  assert.equal(store.bind(a.token, 'CAa', 'custom'), null);
  store.release(a);
  a.disconnectedAt = Date.now() - 20;
  store.sweep();
  assert.equal(store.sessions.has(a.token), false);
  const c = store.create({ callSid: 'CAc' }, true);
  assert.equal(c.custom, true);
  c.reservedAt -= 20;
  store.sweep();
  assert.equal(store.slot, null);
  store.close();
});
test('interruption does not repeat an in-flight tool and cancels undispatched tools', async () => {
  let resolveTool, toolStarted;
  const begun = new Promise((r) => { toolStarted = r; });
  const calls = [];
  let completions = 0;
  const s = session({
    complete: async () => ++completions === 1 ? { role: 'assistant', content: null, tool_calls: [
      { id: 'one', type: 'function', function: { name: 'block_ips', arguments: '{}' } },
      { id: 'two', type: 'function', function: { name: 'scale_web_app', arguments: '{}' } },
    ] } : { role: 'assistant', content: 'The addresses are blocked.' },
    dispatch: async (name) => { calls.push(name); toolStarted(); return new Promise((r) => { resolveTool = r; }); },
  });
  const said = attach(s);
  s.enqueue('Block them.');
  await begun;
  s.interrupt();
  s.enqueue('Did it finish?');
  resolveTool('Five addresses blocked');
  await until(() => !s.running);
  assert.deepEqual(calls, ['block_ips']);
  assert.deepEqual(said, ['The addresses are blocked.']);
  assert.equal(s.messages.find((m) => m.tool_call_id === 'one').content, 'Five addresses blocked');
  assert.match(s.messages.find((m) => m.tool_call_id === 'two').content, /Not executed/);
});
test('tool exceptions preserve uncertain outcome and are not retried', async () => {
  let count = 0, completions = 0;
  const s = session({ complete: async () => ++completions === 1 ? { role: 'assistant', tool_calls: [{ id: 'x', function: { name: 'scale', arguments: '{}' } }] } : { role: 'assistant', content: 'I need to verify its state.' }, dispatch: async () => { count++; throw new Error('network'); } });
  attach(s); s.enqueue('Scale'); await until(() => !s.running);
  assert.equal(count, 1);
  assert.match(s.messages.find((m) => m.role === 'tool').content, /uncertain/);
});
test('interrupted model results cannot produce stale speech', async () => {
  let resolve, calls = 0;
  const s = session({ complete: async () => ++calls === 1 ? new Promise((r) => { resolve = r; }) : { role: 'assistant', content: 'New answer.' } });
  const said = attach(s); s.enqueue('Old question');
  await until(() => resolve);
  s.interrupt(); s.enqueue('New question'); resolve({ role: 'assistant', content: 'Stale answer.' });
  await until(() => !s.running);
  assert.deepEqual(said, ['New answer.']);
});
test('Relay uses exact heard text to trim its optimistic history', async () => {
  const s = session();
  s.attach(new RelayTransport(s, { readyState: 1, send() {}, close() {} }, config));
  s.enqueue('hello'); await until(() => !s.running);
  s.interrupt('Hello');
  assert.equal(s.messages.at(-1).content, 'Hello');
});
test('frames retain all bytes across arbitrary input boundaries', async () => {
  const input = Buffer.alloc(401, 127);
  async function* chunks() { yield input.subarray(0, 3); yield input.subarray(3, 350); yield input.subarray(350); }
  const frames = []; for await (const f of audioFrames(chunks())) frames.push(f);
  assert.deepEqual(frames.map((f) => f.length), [160, 160, 81]);
  assert.deepEqual(Buffer.concat(frames), input);
});
test('speech segmentation preserves order and bounded first segment', () => {
  const text = 'I checked the incident. ' + 'These are the current findings from our load balancer. '.repeat(8).trim();
  const segments = speechSegments(text);
  assert.ok(segments[0].length <= 80);
  assert.ok(segments.every((s) => s.length <= 160));
  assert.equal(segments.join(' '), text);
});
test('FFmpeg converts 24k PCM to headerless 8k mulaw and sound paths are constrained', async () => {
  async function* pcm() { yield Buffer.alloc(4800); }
  const parts = []; for await (const f of convertAudio(pcm(), new AbortController().signal)) parts.push(f);
  assert.equal(Buffer.concat(parts).length, 800);
  assert.equal(Buffer.concat(parts).subarray(0, 4).toString('ascii') === 'RIFF', false);
  await assert.rejects(async () => { for await (const f of convertAudio(null, new AbortController().signal, '../secret')) void f; }, /Unknown sound/);
});
test('Kokoro rejects queue errors, invalid formats and odd PCM; abort reaches HTTP request', async () => {
  const signal = new AbortController().signal;
  const read = async (fetcher, sig = signal) => { for await (const f of kokoroPcm(config, 'Hello', sig, fetcher)) void f; };
  await assert.rejects(read(async () => new Response('', { status: 429 })), /429/);
  await assert.rejects(read(async () => new Response('wav')), /format/);
  const headers = { 'x-audio-format': 'pcm_s16le', 'x-sample-rate': '24000' };
  await assert.rejects(read(async () => new Response(Buffer.alloc(3), { headers })), /length/);
  const c = new AbortController(); let httpSignal;
  const waiting = read(async (_, options) => { httpSignal = options.signal; return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason))); }, c.signal);
  c.abort(); await assert.rejects(waiting); assert.equal(httpSignal.aborted, true);
});
test('pacing starts at first audio, keeps lead bounded and observes cancellation', async () => {
  const c = new AbortController(); const times = [];
  async function* frames() { await sleep(50); for (let i = 0; i < 20; i++) yield Buffer.alloc(160); }
  await sendPacedFrames(frames(), () => times.push(performance.now()), c.signal);
  assert.ok(times.at(-1) - times[0] >= 170);
  c.abort();
  await assert.rejects(sendPacedFrames(frames(), () => {}, c.signal));
});

class FakeDeepgram extends EventEmitter { close() { this.closed = true; } audio(bytes) { this.bytes = bytes; } }
test('answering noise cannot cancel opening audio; early speech waits for the greeting', async () => {
  let release, completed = false, t;
  const s = session({ greeting: 'Hello caller.', complete: async () => { completed = true; return { role: 'assistant', content: '' }; } });
  const sent = [];
  const ws = { readyState: 1, send(raw) { const msg = JSON.parse(raw); sent.push(msg); if (msg.event === 'mark') queueMicrotask(() => t.receive(msg)); }, close() {} };
  t = new MediaTransport(s, ws, 'MZtest', config, { Deepgram: FakeDeepgram,
    fetcher: () => new Promise(resolve => { release = () => resolve(new Response(Buffer.alloc(4800), { headers: { 'x-audio-format': 'pcm_s16le', 'x-sample-rate': '24000' } })); }),
    fallback: async () => assert.fail('opening failed'), end: async () => {}, release() {} });
  s.attach(t); t.dg.emit('ready'); await until(() => release);
  t.dg.emit('speechStarted'); t.dg.emit('utterance', 'Hello Ari', 1);
  assert.equal(t.playback.signal.aborted, false);
  assert.equal(completed, false);
  assert.equal(sent.some(m => m.event === 'clear'), false);
  release(); await until(() => completed);
  assert.ok(sent.some(m => m.event === 'media'));
  assert.equal(s.messages[0].content, 'Hello caller.');
  assert.equal(s.messages[1].content, 'Hello Ari');
  t.dispose();
});
test('an early caller utterance proceeds even while the cancelled greeting is pending', async () => {
  let completed = false;
  const s = session({ complete: async () => { completed = true; return { role: 'assistant', content: '' }; } });
  const t = new MediaTransport(s, { readyState: 1, send() {}, close() {} }, 'MZtest', config,
    { Deepgram: FakeDeepgram, fallback: async () => {}, end: async () => {}, release() {} });
  s.attach(t);
  t.greetingActive = false;
  const greeting = new AbortController();
  t.playback = greeting;
  t.dg.emit('utterance', 'Hello Ari', 1);
  await until(() => completed);
  assert.equal(greeting.signal.aborted, true);
  assert.equal(t.ready, true);
  assert.equal(s.messages[0].content, 'Hello Ari');
  t.dispose();
});
test('cleared marks never enter history; late acknowledgements are ignored', async () => {
  const s = session(); const sent = [];
  const ws = { readyState: 1, bufferedAmount: 0, send(raw) { sent.push(JSON.parse(raw)); }, close() {} };
  const t = new MediaTransport(s, ws, 'MZtest', config, { Deepgram: FakeDeepgram, fallback: async () => {}, end: async () => {}, release() {} });
  s.attach(t);
  const controller = new AbortController();
  const promise = t.ack('Not heard', null, controller);
  const name = sent.at(-1).mark.name;
  t.clear(); await promise;
  t.receive({ event: 'mark', mark: { name } });
  assert.deepEqual(s.messages, []);
  assert.equal(t.marks.size, 0);
  assert.equal(sent.at(-1).event, 'clear');
  const ack = t.ack('Heard', null, new AbortController());
  t.receive({ event: 'mark', mark: { name: sent.at(-1).mark.name } }); await ack;
  assert.equal(s.messages.at(-1).content, 'Heard');
  t.dispose(); assert.equal(t.dg.closed, true);
});
test('provider faults initiate fallback once and audio remains inbound-only', () => {
  const s = session(); let failures = 0;
  const t = new MediaTransport(s, { readyState: 1, send() {}, close() {} }, 'MZtest', config, { Deepgram: FakeDeepgram, fallback: async () => { failures++; }, end: async () => {}, release() {} });
  t.receive({ event: 'media', media: { track: 'outbound', payload: '////' } });
  assert.equal(t.dg.bytes, undefined);
  t.receive({ event: 'media', media: { track: 'inbound', payload: '////' } });
  assert.equal(t.dg.bytes.length, 3);
  t.dg.emit('fault', new Error('Disconnected')); t.dg.emit('fault', new Error('Again'));
  assert.equal(failures, 1); t.dispose();
});
class FakeSocket extends EventEmitter {
  constructor(url, options) { super(); this.url = url; this.options = options; this.readyState = 0; this.sent = []; this.bufferedAmount = 0; }
  send(bytes) { this.sent.push(bytes); }
  close() { this.readyState = 3; this.emit('close'); }
  terminate() { this.close(); }
}
test('Deepgram bridges buffered audio after handshake and closes its timers', () => {
  const d = new DeepgramStream(config, { Socket: FakeSocket });
  const faults = []; d.on('fault', (e) => faults.push(e));
  d.audio(Buffer.alloc(160));
  d.ws.readyState = 1; d.ws.emit('open');
  assert.equal(d.ws.sent[0].length, 160);
  assert.equal(d.ws.url.searchParams.get('encoding'), 'mulaw');
  assert.equal(d.ws.options.headers.Authorization, 'Token fake-secret');
  d.close(); assert.equal(d.closed, true); assert.equal(faults.length, 0);
});
test('voice activity alone does not confirm speech; duplicate finalized text cannot interrupt twice', () => {
  const d = new DeepgramStream(config, { Socket: FakeSocket }); let confirmed = 0;
  d.on('speechConfirmed', () => confirmed++);
  d.ws.emit('message', JSON.stringify({ type: 'SpeechStarted' }));
  assert.equal(confirmed, 0);
  const result = { type: 'Results', is_final: true, speech_final: true, start: 0, duration: 1, channel: { alternatives: [{ transcript: 'Hello', words: [{ end: 1 }] }] } };
  d.ws.emit('message', JSON.stringify(result));
  d.ws.emit('message', JSON.stringify(result));
  assert.equal(confirmed, 1);
  d.ws.emit('message', JSON.stringify({ type: 'SpeechStarted' }));
  d.ws.emit('message', JSON.stringify({ ...result, start: 2 }));
  assert.equal(confirmed, 2); d.close();
});
test('Deepgram startup audio is bounded and malformed provider messages fail visibly', () => {
  const d = new DeepgramStream(config, { Socket: FakeSocket }); let failures = 0;
  d.on('fault', () => failures++);
  d.audio(Buffer.alloc(16001)); assert.equal(failures, 1);
  d.ws.emit('message', 'not json'); assert.equal(failures, 2); d.close();
});

test('Kokoro first-audio timeout aborts the underlying request', async () => {
  let httpSignal;
  const fetcher = async (_, options) => {
    httpSignal = options.signal;
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason)));
  };
  await assert.rejects(async () => { for await (const bytes of kokoroPcm(config, 'hello', new AbortController().signal, fetcher)) void bytes; }, /timeout/);
  assert.equal(httpSignal.aborted, true);
});
test('Deepgram confirmed speech cancels real paced conversion and prevents stale output/history', async () => {
  const s = session(); const sent = []; let t; let interruptionScheduled = false;
  const ws = { readyState: 1, bufferedAmount: 0, send(raw) {
    const msg = JSON.parse(raw); sent.push(msg);
    if (msg.event === 'media' && !interruptionScheduled) {
      interruptionScheduled = true;
      setTimeout(() => t.dg.emit('speechConfirmed'), 15);
    }
  }, close() {} };
  const fetcher = async () => new Response(Buffer.alloc(96000), { headers: { 'x-audio-format': 'pcm_s16le', 'x-sample-rate': '24000' } });
  let failures = 0;
  t = new MediaTransport(s, ws, 'MZtest', config, { Deepgram: FakeDeepgram, fetcher, fallback: async () => { failures++; }, end: async () => {}, release() {} });
  s.attach(t); t.ready = true;
  s.enqueue('Hello'); await until(() => !s.running);
  const count = sent.filter((m) => m.event === 'media').length;
  await sleep(30);
  assert.equal(sent.filter((m) => m.event === 'media').length, count);
  assert.ok(count < 100);
  assert.ok(sent.some((m) => m.event === 'clear'));
  assert.equal(s.messages.some((m) => m.role === 'assistant'), false);
  assert.equal(failures, 0); t.dispose();
});
test('missing playback acknowledgement is a visible failure, not fabricated heard speech', async () => {
  const s = session();
  const t = new MediaTransport(s, { readyState: 1, send() {}, close() {} }, 'MZtest', config, { Deepgram: FakeDeepgram, fallback: async () => {}, end: async () => {}, release() {} });
  await assert.rejects(t.ack('Not confirmed', null, new AbortController()), /acknowledgement timeout/);
  assert.deepEqual(s.messages, []); assert.equal(t.marks.size, 0); t.dispose();
});
test('standard greeting is reused across calls without another synthesis request', async () => {
  const greetingCache = new Map(); let fetches = 0;
  const fetcher = async () => { fetches++; return new Response(Buffer.alloc(4800), { headers: { 'x-audio-format': 'pcm_s16le', 'x-sample-rate': '24000' } }); };
  for (let i = 0; i < 2; i++) {
    const s = session(); let t;
    const ws = { readyState: 1, send(raw) { const msg = JSON.parse(raw); if (msg.event === 'mark') queueMicrotask(() => t.receive(msg)); }, close() {} };
    t = new MediaTransport(s, ws, 'MZtest', config, { Deepgram: FakeDeepgram, fetcher, greetingCache, fallback: async () => {}, end: async () => {}, release() {} });
    s.attach(t); t.dg.emit('ready'); await until(() => t.ready);
    assert.equal(s.messages.at(-1).content, s.greeting); t.dispose();
  }
  assert.equal(fetches, 1);
});
test('a prepared incident opening plays without live synthesis and readiness is tied to its text', async () => {
  const cache = new Map(); let requests = 0, t;
  const fetcher = async () => { requests++; return new Response(Buffer.alloc(4800), { headers: { 'x-audio-format': 'pcm_s16le', 'x-sample-rate': '24000' } }); };
  const text = 'Hello, incident detected.';
  await warmGreeting(config, text, cache, fetcher);
  assert.equal(greetingIsReady(config, text, cache), true);
  assert.equal(greetingIsReady(config, 'Different opening.', cache), false);
  const s = session({ greeting: text });
  const ws = { readyState: 1, send(raw) { const message = JSON.parse(raw); if (message.event === 'mark') queueMicrotask(() => t.receive(message)); }, close() {} };
  t = new MediaTransport(s, ws, 'MZtest', config, { Deepgram: FakeDeepgram, greetingCache: cache,
    fetcher: async () => assert.fail('prepared opening must not synthesize on the call'), fallback: async () => assert.fail('prepared opening failed'), end: async () => {}, release() {} });
  s.attach(t); t.dg.emit('ready'); await until(() => t.ready);
  assert.equal(requests, 1); assert.equal(s.messages[0].content, text); t.dispose();
});

test('non-object tool arguments are rejected without dispatch', async () => {
  let calls = 0, completions = 0;
  const s = session({ complete: async () => ++completions === 1 ? { role: 'assistant', tool_calls: [{ id: 'invalid', function: { name: 'block_ips', arguments: '[]' } }] } : { role: 'assistant', content: 'Please clarify.' }, dispatch: async () => { calls++; } });
  attach(s); s.enqueue('Block'); await until(() => !s.running);
  assert.equal(calls, 0);
  assert.match(s.messages.find((m) => m.role === 'tool').content, /invalid tool arguments/);
});

test('model cannot repeat the same mutating action within a request or after fallback', async () => {
  let calls = 0, completions = 0;
  const s = session({ complete: async () => ++completions <= 2 ? { role: 'assistant', tool_calls: [{ id: 'action-' + completions, function: { name: 'scale_web_app', arguments: '{}' } }] } : { role: 'assistant', content: 'It is booting.' }, dispatch: async () => { calls++; return 'Node started'; } });
  attach(s); s.enqueue('Add a node'); await until(() => !s.running);
  assert.equal(calls, 1);
  assert.match(s.messages.find((m) => m.tool_call_id === 'action-2').content, /Not executed again/);
  completions = 0;
  s.resume(); await until(() => !s.running);
  assert.equal(calls, 1);
});
