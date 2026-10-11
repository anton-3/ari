import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Fleet } from '../src/fleet/index.js';

function fleetWith(reply) {
  const calls = [];
  const ssh = async (_ip, cmd) => { calls.push(cmd); return { code: 0, stdout: reply, stderr: '' }; };
  const f = new Fleet({ log: () => {}, ssh, stateFile: path.join(mkdtempSync(path.join(tmpdir(), 'lease-')), 's.json') });
  f.lbNode = () => ({ id: 'lb1', publicIp: '203.0.113.1' });
  return { f, calls };
}

test('a controller that does not hold the lease places no incident calls', async () => {
  const { f } = fleetWith('follower alice@laptop\n');
  await f.renewLease();
  assert.equal(f.leader, false);
  assert.equal(f.leaseHolder, 'alice@laptop');
  let called = false;
  globalThis.fetch = async () => { called = true; return { ok: true, json: async () => ({}) }; };
  f.incidentView = () => ({ active: true, id: 'inc1' });
  await f.notifyIncident();
  assert.equal(called, false, 'followers never place incident calls');
});

test('the lease holder is leader and the lease command is atomic', async () => {
  const { f, calls } = fleetWith('leader me@host\n');
  await f.renewLease();
  assert.equal(f.leader, true);
  assert.match(calls[0], /flock -w 3 9/);
  assert.match(calls[0], /controller\.lease/);
});
