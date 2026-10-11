import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DemoJobs } from '../demo-jobs.js';
import { patchNginx, extractNginx, ZONE, APPLY, ariCommitEnv, PR_TITLE } from '../rate-limit-pr.js';
import { CallSession } from '../voice-session.js';
import { requestedTool } from '../demo-intent.js';

const state = () => path.join(mkdtempSync(path.join(tmpdir(), 'ari-jobs-')), 'jobs.json');
test('PR identity uses Ari for one subprocess and preserves configured email without mutating its environment', () => {
  const env = { PATH: '/usr/bin', GIT_AUTHOR_NAME: 'Maintainer', GIT_COMMITTER_NAME: 'Maintainer', GIT_AUTHOR_EMAIL: 'maintainer@example.test' };
  const identity = ariCommitEnv(env);
  assert.equal(identity.GIT_AUTHOR_NAME, 'Ari');
  assert.equal(identity.GIT_COMMITTER_NAME, 'Ari');
  assert.equal(identity.GIT_AUTHOR_EMAIL, env.GIT_AUTHOR_EMAIL);
  assert.equal(env.GIT_AUTHOR_NAME, 'Maintainer');
  const custom = ariCommitEnv({ ...env, ARI_PR_EMAIL: 'ari@example.test' });
  assert.equal(custom.GIT_AUTHOR_EMAIL, 'ari@example.test');
  assert.equal(custom.GIT_COMMITTER_EMAIL, 'ari@example.test');
  assert.match(PR_TITLE, /^Ari:/);
});
test('explicit rate-limit PR requests select the tool; questions and refusals do not', () => {
  const request = 'Can you implement new rate limiting in the reverse proxy, code it in a new branch and text me the PR?';
  assert.equal(requestedTool([{ role: 'user', content: request }]), 'open_rate_limit_pr');
  assert.equal(requestedTool([{ role: 'user', content: "Don't implement rate limiting or open a PR yet" }]), undefined);
  assert.equal(requestedTool([{ role: 'user', content: 'Did you finish the rate limiting PR?' }]), undefined);
  assert.equal(requestedTool([{ role: 'tool', content: request }]), undefined);
});
test('a background job survives caller lifetime and duplicate requests start it once', async () => {
  const jobs = new DemoJobs(state());
  let release, calls = 0;
  const op = jobs.start('pr:incident-1', () => { calls++; return new Promise(resolve => { release = resolve; }); });
  assert.equal(jobs.start('pr:incident-1', () => assert.fail('duplicated')), op);
  await Promise.resolve();
  release({ ok: true, url: 'https://github.com/a/b/pull/1', smsStatus: 'queued' });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(calls, 1);
  assert.equal(op.status, 'done');
  assert.equal(new DemoJobs(jobs.file).jobs[op.id].result.smsStatus, 'queued');
});
test('restart preserves uncertain operations and failures rather than resending', async () => {
  const file = state();
  const jobs = new DemoJobs(file);
  jobs.start('pr:one', () => new Promise(() => {}));
  const restarted = new DemoJobs(file);
  assert.equal(restarted.start('pr:one', () => assert.fail('must not resend')).status, 'uncertain');
  const failed = jobs.start('pr:two', async () => ({ ok: false, url: 'https://github.com/a/b/pull/2', smsStatus: 'failed', error: 'Twilio rejected' }));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(failed.status, 'failed');
  assert.equal(failed.result.smsStatus, 'failed');
});
test('rate-limit patch is complete, idempotent and refuses ambiguous templates', () => {
  const source = readFileSync(new URL('../../telemetry/fleet-roles/lb.sh', import.meta.url), 'utf8');
  const result = patchNginx(source);
  assert.equal(result.changed, true);
  assert.ok(result.out.includes(ZONE)); assert.ok(result.out.includes(APPLY));
  assert.match(result.out, /limit_req_status 429;/);
  assert.equal(patchNginx(result.out).changed, false);
  assert.throws(() => patchNginx(source.replace('# ari:rate-limit-zone', '')), /marker/);
  const config = extractNginx(result.out);
  assert.match(config, /http \{/); assert.match(config, /server 127.0.0.1:3000;/);
});
test('incident context and mutation ledger survive subsequent turns', async () => {
  let model = 0, dispatched = 0;
  const session = new CallSession({ callSid: 'CAone', incidentId: 'incident-1', recipient: '+15551234567', log: () => {},
    complete: async () => ++model % 2 ? { role: 'assistant', tool_calls: [{ id: String(model), function: { name: 'open_rate_limit_pr', arguments: '{}' } }] } : { role: 'assistant', content: 'Started.' },
    dispatch: async (_name, _args, context) => { dispatched++; assert.equal(context.incidentId, 'incident-1'); return 'Started'; } });
  session.attach({ ready: true, speak: async () => {}, clear() {}, dispose() {} });
  session.enqueue('Please open the PR');
  while (session.running) await new Promise(resolve => setTimeout(resolve, 5));
  session.enqueue('Did you open the PR?');
  while (session.running) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(dispatched, 1);
  session.close();
});
