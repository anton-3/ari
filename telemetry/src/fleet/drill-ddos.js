#!/usr/bin/env node
// Incident-response DRILL: a bounded L7 request spike against OUR OWN ari-net
// load balancer, to exercise detection + mitigation. AUTHORIZED, own-LB-only.
//
//   - Target is hard-pinned to the current ari-net lb's public IP, resolved at
//     runtime from the fleet (GET /api/fleet). There is NO target argument;
//     it refuses to run if no ari-net lb exists.
//   - It rotates an X-Forwarded-For header across 5 synthetic documentation IPs
//     (203.0.113.10-.14, RFC 5737 TEST-NET-3 — not real hosts); with the lb's
//     real_ip config those are logged as the client IPs.
//   - Hard caps: duration <= 60s, an overall request ceiling, modest
//     concurrency. SIGINT (or the deadline / ceiling) stops it. It auto-stops.
//
// Env: FLEET_API (default http://localhost:8090), ARI_BACKEND_URL
//      (default http://localhost:8080), DRILL_SECONDS, DRILL_MAX_REQUESTS,
//      DRILL_CONCURRENCY.
import http from 'node:http';

const FLEET_API = process.env.FLEET_API || 'http://localhost:8090';
const ARI_BACKEND_URL = process.env.ARI_BACKEND_URL || 'http://localhost:8080';

// Hard safety caps.
const MAX_SECONDS = 60;
const MAX_REQUESTS = 6000;
const MAX_CONCURRENCY = 16;
const SECONDS = Math.min(MAX_SECONDS, Math.max(5, parseInt(process.env.DRILL_SECONDS || '45', 10)));
const CEILING = Math.min(MAX_REQUESTS, Math.max(100, parseInt(process.env.DRILL_MAX_REQUESTS || '4000', 10)));
const CONCURRENCY = Math.min(MAX_CONCURRENCY, Math.max(1, parseInt(process.env.DRILL_CONCURRENCY || '8', 10)));

// Fixed synthetic "source" IPs (RFC 5737 documentation range, not real hosts).
const SOURCE_IPS = ['203.0.113.10', '203.0.113.11', '203.0.113.12', '203.0.113.13', '203.0.113.14'];
const PATHS = ['/', '/api/merchants', '/api/transactions?user=a', '/health', '/api/users/1'];

async function resolveLb() {
  const res = await fetch(`${FLEET_API}/api/fleet`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`cannot read fleet (${res.status})`);
  const { nodes } = await res.json();
  const lb = (nodes || []).find((n) => n.role === 'lb' && n.status === 'running' && n.publicIp);
  if (!lb) throw new Error('no running ari-net lb in the fleet — refusing to run');
  return lb;
}

let sent = 0, ok = 0, failed = 0, stop = false;
const agent = new http.Agent({ keepAlive: true, maxSockets: CONCURRENCY });

function oneRequest(host) {
  return new Promise((resolve) => {
    const xff = SOURCE_IPS[sent % SOURCE_IPS.length];
    const path = PATHS[Math.floor(Math.random() * PATHS.length)];
    const req = http.request({ host, port: 80, path, method: 'GET', agent,
      headers: { 'X-Forwarded-For': xff, 'User-Agent': 'ari-drill/1.0' }, timeout: 5000 }, (res) => {
      res.resume();
      res.on('end', () => { ok++; resolve(); });
    });
    req.on('error', () => { failed++; resolve(); });
    req.on('timeout', () => { req.destroy(); failed++; resolve(); });
    req.end();
  });
}

async function notifyBackend(lb) {
  try {
    await fetch(`${ARI_BACKEND_URL}/incident`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(4000),
      body: JSON.stringify({ type: 'ddos', drill: true, lbNodeId: lb.id, label: lb.label,
        target: lb.publicIp, attackerIps: SOURCE_IPS,
        message: `DRILL: simulated DoS spike on ${lb.label} from 203.0.113.0/24` }),
    });
    console.log(`[drill] notified Ari backend at ${ARI_BACKEND_URL}/incident`);
  } catch (e) {
    console.log(`[drill] backend notify skipped (${e.message}) — the real detector still catches it`);
  }
}

async function worker(host, deadline) {
  while (!stop && sent < CEILING && Date.now() < deadline) {
    sent++;
    await oneRequest(host);
  }
}

const lb = await resolveLb();
const deadline = Date.now() + SECONDS * 1000;
console.log(`[drill] simulating DoS spike on ${lb.label} from 203.0.113.0/24 for ${SECONDS}s`);
console.log(`[drill] target ${lb.publicIp}:80 | caps: <=${SECONDS}s, <=${CEILING} requests, ${CONCURRENCY} concurrent | Ctrl-C to stop`);

process.on('SIGINT', () => { if (!stop) { stop = true; console.log('\n[drill] stop requested; winding down...'); } });
const timer = setInterval(() => {
  if (stop || Date.now() >= deadline || sent >= CEILING) return;
  process.stdout.write(`\r[drill] sent=${sent} ok=${ok} failed=${failed} elapsed=${Math.round((SECONDS * 1000 - (deadline - Date.now())) / 1000)}s   `);
}, 500);

await notifyBackend(lb);
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(lb.publicIp, deadline)));
stop = true;
clearInterval(timer);
agent.destroy();
const why = sent >= CEILING ? 'request ceiling' : (Date.now() >= deadline ? 'time limit' : 'stop flag');
console.log(`\n[drill] done (${why}): sent=${sent} ok=${ok} failed=${failed}. The detector should now show an incident; block the attacker IPs to clear it.`);
process.exit(0);
