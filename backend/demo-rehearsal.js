// Explicit opt-in: real bans, standby activation, GitHub PR and SMS; no PSTN call.
import OpenAI from 'openai';
import { writeFile } from 'node:fs/promises';
import { CallSession } from './voice-session.js';
import { providerFetch } from './voice-http.js';
import { requestedTool } from './demo-intent.js';
import { INCIDENT_GREETING, incidentPrompt, DEMO_PHONE } from './incident.js';
import { demoJobs } from './demo-jobs.js';
import * as actions from './actions.js';
import * as linode from './linode.js';
if (!process.argv.includes('--live-tools')) throw new Error('Pass --live-tools to authorize real infrastructure actions, PR publication and SMS.');
try {
  const response = await fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/', { signal: AbortSignal.timeout(1000) });
  if (response.ok) throw new Error('Stop the voice backend before this controlled rehearsal; only one process may own the job ledger.');
} catch (error) {
  if (error.message.includes('job ledger')) throw error;
}
const API = process.env.TELEMETRY_URL || 'http://localhost:8090';
const status = async () => (await fetch(API + '/api/demo/status')).json();
const before = await status();
if (!before.incident.id || before.incident.attackerIps.length !== 5 || before.standby?.servingState !== 'standby') throw new Error('Need a retained five-source incident and prepared standby.');
const providers = [linode, actions], tools = providers.flatMap(p => p.tools);
const client = new OpenAI({ fetch: providerFetch });
const events = [];
const session = new CallSession({ callSid: 'controlled-tool-rehearsal', incidentId: before.incident.id, recipient: DEMO_PHONE,
  greeting: INCIDENT_GREETING, prompt: incidentPrompt(),
  log: (_s, event, data) => { events.push({ at: Date.now(), event, ...data }); console.log(JSON.stringify(events.at(-1))); },
  complete: async (messages, signal) => {
    const name = requestedTool(messages);
    return (await client.chat.completions.create({ model: process.env.CHAT_MODEL || 'hackathon-chat', max_tokens: 1024, tools,
      tool_choice: name ? { type: 'function', function: { name } } : 'auto', messages }, { signal, timeout: 30000, maxRetries: 0 })).choices[0].message;
  },
  dispatch: (name, args, context) => {
    if (!['block_ips', 'scale_web_app', 'open_rate_limit_pr', 'get_incident', 'get_live_metrics'].includes(name)) throw new Error('Unexpected rehearsal tool: ' + name);
    console.log(JSON.stringify({ event: 'dispatch', name, args }));
    return actions.runTool(name, args, context);
  },
});
session.attach({ ready: true, clear() {}, dispose() {}, speak: async (text, turn) => { console.log(JSON.stringify({ event: 'spoken_text', text })); session.recordSpoken(text, turn); } });
session.recordSpoken(INCIDENT_GREETING);
async function until(check, timeout = 45000) {
  const start = Date.now();
  while (!await check()) { if (Date.now() - start > timeout) throw new Error('Rehearsal timed out'); await new Promise(r => setTimeout(r, 100)); }
}
const approvalAt = Date.now();
session.enqueue('Yeah sure, ban the attacking IP addresses. Just to be safe, can you also spin up another node to serve the web app?');
await until(async () => { const d = await status(); return d.standby?.activation?.status === 'ready' && d.incident.blockedIps.length === 5; });
const servingMs = Date.now() - approvalAt;
await until(() => !session.running);
const prAt = Date.now();
session.enqueue('Can you implement new rate limiting in the reverse proxy node, code it in a new branch and text me the PR when you are done?');
const key = 'pr:' + before.incident.id;
await until(() => demoJobs.jobs[key] && demoJobs.jobs[key].status !== 'running');
const pr = demoJobs.jobs[key];
const result = { incidentId: before.incident.id, servingMs, prMs: Date.now() - prAt, pr, events };
await writeFile(new URL('./.demo/rehearsal.json', import.meta.url), JSON.stringify(result, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ servingMs, prMs: result.prMs, outcome: pr.status, url: pr.result?.url, smsStatus: pr.result?.smsStatus }));
session.close();
if (pr.status !== 'done') process.exitCode = 1;
