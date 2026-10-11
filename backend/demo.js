// npm run demo -- prepare|preflight|stop|reset|status
import { readFile } from 'node:fs/promises';
import { sshRun } from '../telemetry/src/fleet/ssh.js';
import { incidentConfContent } from '../telemetry/src/fleet/incident.js';
import { prepareRateLimitPr } from './rate-limit-pr.js';
import { voiceConfig } from './voice-config.js';
import { providerFetch } from './voice-http.js';
import { kokoroPcm } from './voice-audio.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const exec = promisify(execFile);
const API = process.env.TELEMETRY_URL || 'http://localhost:8090';
export async function api(path, body) {
  const res = await fetch(API + path, { ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(25000) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `telemetry ${res.status}`);
  return data;
}
export async function remote(node, command, input) {
  if (!node || !/^\d+\.\d+\.\d+\.\d+$/.test(node.publicIp)) throw new Error('owned fleet node is unavailable');
  const result = await sshRun(node.publicIp, command, { input, timeoutMs: 20000 });
  if (result.code !== 0) throw new Error(`${node.label}: ${result.stderr.trim() || result.stdout.trim()}`);
  return result.stdout;
}
const encoded = text => Buffer.from(text).toString('base64');

async function prepare(nodes) {
  const lb = nodes.find(n => n.role === 'lb');
  const traffic = nodes.find(n => n.role === 'traffic');
  for (const node of [lb, traffic]) if (node?.status !== 'running') throw new Error('load balancer and traffic node must be running');
  const template = await readFile(new URL('../telemetry/fleet-roles/lb.sh', import.meta.url), 'utf8');
  const log = template.match(/ari-net-log\.conf <<'NG'\n([\s\S]*?)\nNG/)[1];
  const site = template.match(/sites-available\/myfiat <<'NG'\n([\s\S]*?)\nNG/)[1];
  const reader = await readFile(new URL('../telemetry/fleet-roles/request-reader.py', import.meta.url), 'utf8');
  const conf = incidentConfContent([traffic.privateIp]);
  // Keep a full nginx rollback copy. No rate limiting is deployed by preparation.
  const deploy = `set -eu
test -d /opt/ari-net-nginx-before-demo || cp -a /etc/nginx /opt/ari-net-nginx-before-demo
mkdir -p /opt/ari-net
echo '${encoded(reader)}' | base64 -d > /opt/ari-net/request-reader.py
echo '${encoded(log)}' | base64 -d > /etc/nginx/conf.d/ari-net-log.conf
echo '${encoded(site)}' | base64 -d > /etc/nginx/sites-available/myfiat
echo '${encoded(conf)}' | base64 -d > /etc/nginx/conf.d/ari-net-incident.conf
test -f /etc/nginx/ari-net-blocklist.conf || echo '# Ari blocklist' > /etc/nginx/ari-net-blocklist.conf
rm -f /etc/nginx/sites-enabled/acmepay /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/myfiat /etc/nginx/sites-enabled/myfiat
if nginx -t; then systemctl reload nginx; else rm -f /etc/nginx/sites-enabled/myfiat; cp -a /opt/ari-net-nginx-before-demo/. /etc/nginx/; exit 1; fi
`;
  await remote(lb, 'bash -s', deploy);
  const normal = await readFile(new URL('../telemetry/fleet-roles/traffic.py', import.meta.url), 'utf8');
  const attack = await readFile(new URL('../telemetry/fleet-roles/demo-ddos.py', import.meta.url), 'utf8');
  await remote(traffic, 'bash -s', `set -eu
mkdir -p /opt/ari-net /etc/systemd/system/ari-traffic.service.d
test -f /opt/ari-net/traffic.py.before-demo || cp /opt/ari-net/traffic.py /opt/ari-net/traffic.py.before-demo
echo '${encoded(normal)}' | base64 -d > /opt/ari-net/traffic.py
echo '${encoded(attack)}' | base64 -d > /opt/ari-net/demo-ddos.py
printf '[Service]\\nEnvironment=DEMO_PROFILE=1\\n' > /etc/systemd/system/ari-traffic.service.d/demo.conf
systemctl daemon-reload
systemctl restart ari-traffic
`);
  console.log('Real request reader, client-IP trust and 1 req/s baseline deployed.');
  await prepareNextTake(nodes);
}

// Repeat takes reuse the installed traffic/logging setup and warm standby.
export async function prepareNextTake(nodes) {
  const lb = nodes.find(n => n.role === 'lb');
  const { node } = await api('/api/demo/standby', {});
  console.log(`Preparing ${node.label} (${node.id}). Bootstrap runs in telemetry; this may take minutes once.`);
  const started = Date.now();
  while (Date.now() - started < 15 * 60000) {
    const status = await api('/api/demo/status');
    if (status.standby?.status === 'running') break;
    if (status.standby?.error) throw new Error(status.standby.error);
    await new Promise(resolve => setTimeout(resolve, 2000));
    if (Date.now() - started > 149 * 6000) throw new Error('standby preparation timed out');
  }
  await prepareRateLimitPr({ validate: async config => {
    await remote(lb, 'cat > /tmp/ari-rate-limit-check.conf && nginx -t -c /tmp/ari-rate-limit-check.conf', config);
  } });
  console.log('web-03 is warm; the future PR patch passed nginx validation. No PR has been published.');
}

export async function preflight(nodes) {
  const status = await api('/api/demo/status');
  const errors = [];
  if (status.metrics.stale) errors.push('request feed is stale');
  if (!(status.metrics.requestsLast180s >= 90 && status.metrics.requestsLast180s <= 600)) errors.push('need a clean 3-minute baseline (90–600 requests)');
  if (status.incident.active || status.incident.blockedIps.length) errors.push('reset the previous incident/blocklist');
  if (status.standby?.status !== 'running' || status.standby.servingState !== 'standby') errors.push('web-03 must be healthy and on standby');
  let voice;
  try { voice = voiceConfig(); } catch (e) { errors.push(e.message); }
  for (const key of ['TWILIO_SID', 'TWILIO_AUTH_TOKEN', 'PUBLIC_HOST', 'OPENAI_API_KEY']) if (!process.env[key]) errors.push(`${key} is missing`);
  const checks = [];
  checks.push((async () => { try {
    const { stdout } = await exec('gh', ['api', 'repos/anton-3/hackmid2026', '--jq', '.permissions.push'], { timeout: 10000 });
    if (stdout.trim() !== 'true') throw new Error('no push permission');
  } catch { errors.push('GitHub push access failed'); } })());
  checks.push((async () => { try {
    const [response, readiness] = await Promise.all([
      providerFetch(`https://${process.env.PUBLIC_HOST}/`, { signal: AbortSignal.timeout(5000) }),
      providerFetch(`https://${process.env.PUBLIC_HOST}/health/voice`, { signal: AbortSignal.timeout(5000) }),
    ]);
    if (!response.ok || (await response.text()).trim() !== 'ok') throw new Error('unreachable');
    if (!readiness.ok || !(await readiness.json()).incidentGreetingReady) throw new Error('incident opening audio is not prepared; restart backend');
  } catch { errors.push('public voice tunnel is unavailable'); } })());
  if (voice?.stack && voice.stack !== 'twilio') {
    checks.push((async () => { try {
      for await (const bytes of kokoroPcm(voice, 'Hello, ready for the incident demo.', new AbortController().signal)) {
        if (bytes.length) break;
      }
    } catch (e) { errors.push(`speech provider preflight failed: ${e.message}`); } })());
  }
  try {
    const prepared = JSON.parse(await readFile(new URL('./.demo/pr-prepared.json', import.meta.url), 'utf8'));
    if (!prepared.validated || Date.now() - prepared.preparedAt > 86400000) errors.push('PR preparation expired');
  } catch { errors.push('PR worktree not prepared'); }
  const lb = nodes.find(n => n.role === 'lb');
  checks.push(remote(lb, 'nginx -t && curl -fsS --max-time 2 http://127.0.0.1/health >/dev/null').catch(e => errors.push(e.message)));
  if (status.standby?.status === 'running') checks.push(remote(status.standby, 'curl -fsS --max-time 2 http://127.0.0.1:3000/health >/dev/null && curl -fsS --max-time 2 http://127.0.0.1:3000/api/users/1 >/dev/null && curl -fsS --max-time 2 http://127.0.0.1:3000/api/merchants >/dev/null').catch(e => errors.push(e.message)));
  await Promise.all(checks);
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(`Preflight passed: ${status.metrics.requestsLast180s} real requests/3 min; web-03 ready. Verify the phone is available and the public voice tunnel is still live.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
const command = process.argv[2] || 'status';
try {
  const { nodes } = await api('/api/fleet');
  if (command === 'prepare') await prepare(nodes);
  else if (command === 'preflight') await preflight(nodes);
  else if (command === 'status') console.log(JSON.stringify(await api('/api/demo/status'), null, 2));
  else if (command === 'stop' || command === 'reset') {
    await remote(nodes.find(n => n.role === 'traffic'), 'systemctl stop ari-demo-attack 2>/dev/null || true');
    if (command === 'reset') await api('/api/demo/reset', {});
    console.log(command === 'reset' ? 'Reset complete. Wait 3 minutes for the observed traffic window to normalize; prepare a fresh PR worktree before the next PR take.' : 'Attack generator stopped.');
  } else throw new Error('Use prepare, preflight, status, stop or reset');
} catch (error) { console.error(error.message); process.exitCode = 1; }
}
