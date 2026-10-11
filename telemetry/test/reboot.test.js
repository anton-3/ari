import test from 'node:test';
import assert from 'node:assert/strict';

process.env.LINODE_API_TOKEN = 'test-token';
const { Fleet } = await import('../src/fleet/index.js');
const linode = await import('../src/fleet/linode.js');

const instance = { id: 123, label: 'app-1', status: 'running', tags: ['ari-net', 'role:app'], ipv4: [], region: 'us-ord', type: 'g6-nanode-1' };
function makeFleet() {
  const fleet = new Fleet({ log: () => {}, stateFile: '/tmp/ari-reboot-test-missing.json' });
  fleet.enabled = true;
  fleet.instances.set('123', { inst: instance, role: 'app', label: 'app-1' });
  fleet._state('123').ready = true;
  return fleet;
}

test('reboot preserves the node and transitions from shutdown to booting', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push([url, options.method]);
    return new Response(JSON.stringify(options.method === 'GET' ? instance : {}));
  });
  const fleet = makeFleet();
  assert.deepEqual(await fleet.rebootNode('123'), { ok: true });
  assert.equal(fleet.nodeView('123').status, 'rebooting');
  assert.equal(fleet.instances.size, 1);
  assert.equal(fleet.deleted.size, 0);
  fleet._state('123').reboot.startedAt -= 3000;
  assert.equal(fleet.nodeView('123').status, 'booting');
  await assert.rejects(fleet.rebootNode('123'), { status: 409 });
  assert.deepEqual(calls.map((c) => c[1]), ['GET', 'POST']);
  assert.ok(calls[1][0].endsWith('/123/reboot'));
});

test('reboot API failure restores the running node', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url, options) => new Response(
    JSON.stringify(options.method === 'GET' ? instance : { errors: [{ reason: 'busy' }] }),
    { status: options.method === 'GET' ? 200 : 409 },
  ));
  const fleet = makeFleet();
  await assert.rejects(fleet.rebootNode('123'), { status: 409 });
  assert.equal(fleet.nodeView('123').status, 'running');
  assert.equal(fleet._state('123').reboot, null);
});

test('ownership and state guards prevent reboot mutation', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    calls.push(options.method);
    return new Response(JSON.stringify({ ...instance, tags: [] }));
  });
  await assert.rejects(linode.rebootInstance('107864618'), { status: 403 });
  assert.equal(calls.length, 0);
  await assert.rejects(linode.rebootInstance('123'), { status: 403 });
  assert.deepEqual(calls, ['GET']);
  const fleet = makeFleet();
  fleet._state('123').deleting = true;
  await assert.rejects(fleet.rebootNode('123'), { status: 409 });
  await assert.rejects(fleet.rebootNode('controller'), { status: 403 });
  assert.deepEqual(calls, ['GET']);
});
