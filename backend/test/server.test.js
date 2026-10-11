import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import twilio from 'twilio';
import WebSocket from 'ws';
import { createVoiceServer, validateTwilio } from '../server.js';

const config = { stack: 'custom', host: 'example.test', twilioToken: 'test-token', twilioSid: 'ACtest', ttsProvider: 'ElevenLabs', ttsVoice: 'Eric', model: 'nova-3' };
const client = { chat: { completions: { create: async () => ({ choices: [{ message: { role: 'assistant', content: 'Hello.' } }] }) } } };
class FakeMedia {
  constructor(session, ws, streamSid, config, options) { Object.assign(this, { session, ws, options, ready: true }); }
  clear() {} receive() {} speak() {} play() {}
  dispose() { this.options.release(this.session); this.ws.close(); }
}
function tcFixture() {
  const updates = [];
  return { updates, calls: () => ({ fetch: async () => ({ status: 'in-progress' }), update: async (data) => { updates.push(data); } }) };
}
async function setup(t, overrides = {}) {
  const tc = tcFixture();
  const runtime = createVoiceServer({ config, client, twilioClient: tc, Media: FakeMedia, log: () => {}, ...overrides });
  runtime.server.listen(0, '127.0.0.1'); await once(runtime.server, 'listening');
  t.after(() => runtime.close());
  return { ...runtime, tc, base: `http://127.0.0.1:${runtime.server.address().port}` };
}
async function post(r, path, body, signed = true) {
  return fetch(r.base + path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(signed ? { 'X-Twilio-Signature': twilio.getExpectedTwilioSignature(config.twilioToken, 'https://' + config.host + path, body) } : {}) }, body: new URLSearchParams(body) });
}
function socket(r, path) {
  return new WebSocket(r.base.replace(/^http:/, 'ws:') + path, { headers: { 'X-Twilio-Signature': twilio.getExpectedTwilioSignature(config.twilioToken, 'https://' + config.host + path, {}) } });
}
async function until(check) { for (let i = 0; i < 100; i++) { if (check()) return; await sleep(5); } assert.fail('timed out'); }

test('signature validation uses public URL and rejects invalid signatures including upgrades', () => {
  const req = { originalUrl: '/voice?greeting=hello', headers: {}, body: { CallSid: 'CAtest' } };
  req.headers['x-twilio-signature'] = twilio.getExpectedTwilioSignature(config.twilioToken, 'https://example.test' + req.originalUrl, req.body);
  assert.equal(validateTwilio(req, config), true);
  assert.equal(validateTwilio({ ...req, body: { CallSid: 'wrong' } }, config), false);
  assert.equal(validateTwilio(req, { ...config, twilioToken: '' }), false);
  assert.equal(validateTwilio({ url: '/media', headers: { 'x-twilio-signature': 'invalid' } }, config, true), false);
});
test('signed voice webhook selects custom, overflow and incident greeting without changing phone webhook', async (t) => {
  const r = await setup(t);
  assert.equal((await post(r, '/voice', { CallSid: 'CAx' }, false)).status, 403);
  const first = await post(r, '/voice?greeting=Incident%20on%20MyFiat&prompt=Ask%20permission', { CallSid: 'CAone' });
  assert.match(await first.text(), /<Stream /);
  assert.equal(r.store.byCall.get('CAone').greeting, 'Incident on MyFiat');
  assert.match(r.store.byCall.get('CAone').systemPrompt, /Ask permission/);
  const overflow = await post(r, '/voice', { CallSid: 'CAtwo' });
  assert.match(await overflow.text(), /ConversationRelay/);
  const repeated = await post(r, '/voice', { CallSid: 'CAone' });
  assert.match(await repeated.text(), /<Stream /);
  assert.equal(r.store.sessions.size, 2);
});
test('existing mode requires no custom providers and relay submits final prompts only', async (t) => {
  const r = await setup(t, { config: { ...config, stack: 'twilio' } });
  assert.match(await (await post(r, '/voice', { CallSid: 'CArelay' })).text(), /ConversationRelay/);
  const s = r.store.byCall.get('CArelay');
  const ws = socket(r, '/relay'); await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'setup', callSid: s.callSid, customParameters: { session: s.token } }));
  await until(() => s.transport);
  ws.send(JSON.stringify({ type: 'prompt', voicePrompt: 'partial', last: false }));
  await sleep(10); assert.equal(s.messages.some((m) => m.role === 'user'), false);
  const reply = once(ws, 'message');
  ws.send(JSON.stringify({ type: 'prompt', voicePrompt: 'Hello', last: true }));
  assert.equal(JSON.parse((await reply)[0]).type, 'text');
  ws.close(); await once(ws, 'close');
  await until(() => s.transport === null);
  assert.equal(s.bound, false);
  assert.equal(s.alive, true); // Conversation remains retained for reconnect.
  assert.equal([...r.store.sessions.values()].some(s => s.alive && s.bound), false);
});
test('custom stream binds once; fallback preserves completed tool results and frees slot', async (t) => {
  const r = await setup(t);
  await post(r, '/voice', { CallSid: 'CAone' });
  const s = r.store.byCall.get('CAone');
  const ws = socket(r, '/media'); await once(ws, 'open');
  ws.send(JSON.stringify({ event: 'start', start: { callSid: s.callSid, streamSid: 'MZone', customParameters: { session: s.token }, mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 } } }));
  await until(() => s.transport);
  s.messages.push({ role: 'tool', tool_call_id: 'completed', content: 'IPs already blocked' });
  await r.fallback(s); await r.fallback(s);
  assert.equal(r.tc.updates.length, 1);
  assert.match(r.tc.updates[0].url, /voice\/fallback/);
  assert.equal(r.store.slot, null);
  const path = '/voice/fallback?session=' + s.token;
  assert.equal((await post(r, path, { CallSid: 'wrong' })).status, 403);
  assert.match(await (await post(r, path, { CallSid: s.callSid })).text(), /I switched audio connections/);
  const relay = socket(r, '/relay'); await once(relay, 'open');
  relay.send(JSON.stringify({ type: 'setup', callSid: s.callSid, customParameters: { session: s.token } }));
  await until(() => s.transport?.constructor.name === 'RelayTransport');
  assert.equal(s.messages.find((m) => m.tool_call_id === 'completed').content, 'IPs already blocked');
  const next = await post(r, '/voice', { CallSid: 'CAnext' }); assert.match(await next.text(), /<Stream /);
  relay.close(); await once(relay, 'close');
});
test('fallback checks call status and does not reconnect a completed call', async (t) => {
  let updates = 0;
  const r = await setup(t, { twilioClient: { calls: () => ({ fetch: async () => ({ status: 'completed' }), update: async () => { updates++; } }) } });
  await post(r, '/voice', { CallSid: 'CAended' });
  await r.fallback(r.store.byCall.get('CAended'));
  assert.equal(updates, 0); assert.equal(r.store.sessions.size, 0); assert.equal(r.store.slot, null);
});
test('fallback REST failure ends cleanly and removes session', async (t) => {
  const calls = [];
  const r = await setup(t, { twilioClient: { calls: () => ({ fetch: async () => ({ status: 'in-progress' }), update: async (data) => { calls.push(data); if (data.url) throw new Error('update failed'); } }) } });
  await post(r, '/voice', { CallSid: 'CAfailed' });
  await r.fallback(r.store.byCall.get('CAfailed'));
  assert.equal(calls.at(-1).status, 'completed'); assert.equal(r.store.sessions.size, 0);
});
test('bad stream token is rejected before starting any provider', async (t) => {
  const r = await setup(t);
  const ws = socket(r, '/media'); await once(ws, 'open');
  const closed = once(ws, 'close');
  ws.send(JSON.stringify({ event: 'start', start: { callSid: 'CAwrong', streamSid: 'MZwrong', customParameters: { session: 'bad' } } }));
  assert.equal((await closed)[0], 1008); assert.equal(r.store.sessions.size, 0);
});

test('fallback during a running tool waits for its result and resumes without another dispatch', async (t) => {
  let resolveTool, dispatches = 0, completions = 0;
  const model = { chat: { completions: { create: async () => ({ choices: [{ message: ++completions === 1 ? { role: 'assistant', content: null, tool_calls: [{ id: 'one', type: 'function', function: { name: 'block_ips', arguments: '{}' } }] } : { role: 'assistant', content: 'The ban is complete.' } }] }) } } };
  const r = await setup(t, { client: model, dispatch: async () => { dispatches++; return new Promise((resolve) => { resolveTool = resolve; }); } });
  await post(r, '/voice', { CallSid: 'CAtool' });
  const s = r.store.byCall.get('CAtool');
  const media = socket(r, '/media'); await once(media, 'open');
  media.send(JSON.stringify({ event: 'start', start: { callSid: s.callSid, streamSid: 'MZtool', customParameters: { session: s.token }, mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 } } }));
  await until(() => s.transport);
  s.enqueue('Block the addresses'); await until(() => resolveTool);
  await r.fallback(s);
  await post(r, '/voice/fallback?session=' + s.token, { CallSid: s.callSid });
  const relay = socket(r, '/relay'); await once(relay, 'open');
  relay.send(JSON.stringify({ type: 'setup', callSid: s.callSid, customParameters: { session: s.token } }));
  await until(() => s.transport?.constructor.name === 'RelayTransport');
  const reply = once(relay, 'message');
  resolveTool('Five addresses blocked');
  assert.equal(JSON.parse((await reply)[0]).token, 'The ban is complete.');
  assert.equal(dispatches, 1);
  assert.equal(s.messages.find((m) => m.tool_call_id === 'one').content, 'Five addresses blocked');
  relay.close(); await once(relay, 'close');
});
test('WebSocket upgrades require a valid signature', async (t) => {
  const r = await setup(t);
  const ws = new WebSocket(r.base.replace(/^http:/, 'ws:') + '/media');
  const error = once(ws, 'error');
  assert.match((await error)[0].message, /403/);
});
