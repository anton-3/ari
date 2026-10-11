import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestTelemetry, parseRequest } from '../src/fleet/requests.js';
import { Fleet } from '../src/fleet/index.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const entry = (id, t, ip = '203.0.113.10', status = 200) => ({ id, line: `${t} ${status} ${ip} "GET /health HTTP/1.1" 80 192.168.132.24:3000 0.010` });

test('counts requests once, includes rejected traffic, expires exactly at the window boundary', () => {
  const requests = new RequestTelemetry();
  const records = [entry('1', 820), entry('2', 821), entry('3', 999, undefined, 403)];
  requests.ingest({ now: 1000, entries: records });
  requests.ingest({ now: 1000, entries: records });
  const snapshot = requests.snapshot({}, 1000000);
  assert.equal(snapshot.requestsLast180s, 2);
  assert.equal(snapshot.requestsPerMinute, 12);
  assert.equal(snapshot.errorRate, 0);
  assert.equal(snapshot.series.at(-1).requestsPerMinute, snapshot.requestsPerMinute);
  requests.ingest({ now: 1180, entries: [] });
  assert.equal(requests.snapshot({}, 1180000).requestsLast180s, 0);
});
test('stale and missing observations are explicit, while an empty observed window is zero', () => {
  const requests = new RequestTelemetry();
  assert.equal(requests.snapshot().requestsLast180s, null);
  requests.ingest({ now: 1000, entries: [] });
  assert.equal(requests.snapshot({}, 1000000).requestsLast180s, 0);
  assert.equal(requests.snapshot({}, 1006000).stale, true);
  requests.ingest({ gap: true });
  assert.equal(requests.snapshot({}, 1000000).stale, true);
  requests.ingest({ now: 1001, entries: [] });
  assert.equal(requests.snapshot({}, 1001000).stale, true, 'lost records keep the three-minute count unavailable');
  requests.ingest({ now: 1181, entries: [] });
  assert.equal(requests.snapshot({}, 1181000).stale, false);
  assert.equal(parseRequest({ id: 'bad', line: 'not a request' }), null);
});
function fleet(ssh = async () => ({ code: 0, stdout: 'reloaded', stderr: '' })) {
  const f = new Fleet({ log: () => {}, ssh, stateFile: path.join(mkdtempSync(path.join(tmpdir(), 'fleet-test-')), 'state.json') });
  f.enabled = true;
  for (const [id, role, label] of [['1', 'lb', 'load-balancer-01'], ['2', 'app', 'web-01'], ['3', 'app', 'web-03'], ['4', 'traffic', 'traffic-01']]) {
    f.instances.set(id, { id, role, label, publicIp: `172.232.1.${id}`, privateIp: `192.168.130.${id}`, inst: { status: 'running', tags: ['ari-net', `role:${role}`] } });
    f._state(id).ready = role;
  }
  f.demo.serving['3'] = 'standby';
  f.controllerIp = '198.51.100.1';
  f.incident._confAt = Date.now();
  return f;
}
test('detects five observed attackers, excludes baseline, retains identities after clearing', async () => {
  const f = fleet();
  const records = Array.from({ length: 400 }, (_, i) => entry(String(i), 999, `203.0.113.${10 + i % 5}`));
  records.push(entry('base', 999, '198.51.100.20'));
  f.requests.ingest({ now: 1000, entries: records });
  await f.pollIncident(); await f.pollIncident();
  assert.equal(f.incidentView().active, true);
  assert.equal(f.incidentView().attackerIps.length, 5);
  const id = f.incident.id;
  f.requests.ingest({ now: 1020, entries: [] });
  await f.pollIncident(); await f.pollIncident(); await f.pollIncident();
  assert.equal(f.incidentView().active, false);
  assert.equal(f.incident.id, id);
  assert.equal(f.demo.incidents.at(-1).attackerIps.length, 5);
  await f.blockIps(undefined, id);
  assert.deepEqual(f.incident.blockedIps.sort(), ['203.0.113.10','203.0.113.11','203.0.113.12','203.0.113.13','203.0.113.14']);
});
test('standby is excluded; duplicate activation uses one job and links appear only after readiness', async () => {
  let release;
  const f = fleet(async commandIp => {
    if (commandIp === '172.232.1.3') await new Promise(resolve => { release = resolve; });
    return { code: 0, stdout: 'reloaded', stderr: '' };
  });
  assert.equal(f.snapshot().nodes.some(n => n.label === 'web-03'), false);
  const first = f.activateStandby('incident-1');
  assert.equal(f.activateStandby('incident-1'), first);
  assert.equal(f.snapshot().nodes.some(n => n.label === 'web-03'), true);
  assert.equal(f.snapshot().links.some(l => l.target === '3'), false);
  release();
  for (let i = 0; i < 20 && first.status !== 'ready'; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(first.status, 'ready');
  assert.equal(f.snapshot().links.some(l => l.target === '3'), true);
});
test('failed activation never leaves a node in the upstream pool', async () => {
  const f = fleet(async () => ({ code: 1, stdout: '', stderr: 'failed' }));
  const op = f.activateStandby('failure');
  for (let i = 0; i < 20 && op.status !== 'failed'; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(op.status, 'failed');
  assert.equal(f.servingState('3'), 'failed');
  assert.equal(f.snapshot().links.some(l => l.target === '3'), false);
});
