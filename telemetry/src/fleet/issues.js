// Real per-node issues, computed only from observed data.
//
// Fast checks run on every collector sample (unreachable, cpu, memory, disk,
// service down, nginx 5xx). Slower checks run on their own cadence and can also
// be triggered on demand by an agent job:
//   - public exposure: TCP connect from this controller to the node's PUBLIC IP
//     on 3000/5432/6379 (only our own ari-net nodes, only those ports);
//   - SSH brute force: failed logins in the last 10 min from journalctl;
//   - pending security updates (apt, every 10 min);
//   - known AcmePay vulnerabilities, by statically reading the deployed code.
// An issue keeps a stable id while its condition holds and clears when it stops.
import net from 'node:net';
import { sshRun } from './ssh.js';
import { symbolAt } from './codemap.js';

export const EXPECTED_SERVICE = {
  lb: { name: 'nginx', port: 80 },
  app: { name: 'node', port: 3000 },
  db: { name: 'postgres', port: 5432 },
  cache: { name: 'redis-server', port: 6379 },
};
export const PRIVATE_PORTS = [3000, 5432, 6379];

// ---- issue store (per node) ----
export class IssueStore {
  constructor() { this.byNode = new Map(); }
  _m(nodeId) { if (!this.byNode.has(nodeId)) this.byNode.set(nodeId, new Map()); return this.byNode.get(nodeId); }
  list(nodeId) {
    const order = { critical: 0, high: 1, medium: 2, low: 3 };
    return [...this._m(nodeId).values()].sort((a, b) => order[a.severity] - order[b.severity]);
  }
  get(nodeId, key) { return this._m(nodeId).get(key) || null; }
  // set(nodeId, key, data) raises/updates; set(nodeId, key, null) clears.
  set(nodeId, key, data) {
    const m = this._m(nodeId);
    if (!data) { const had = m.has(key); m.delete(key); return had ? 'cleared' : null; }
    const prev = m.get(key);
    const issue = { id: `${nodeId}:${key}`, since: prev ? prev.since : new Date().toISOString(), ...data };
    m.set(key, issue);
    return prev ? 'updated' : 'raised';
  }
  // clear every key under a prefix that isn't in `keep`
  clearPrefix(nodeId, prefix, keep = new Set()) {
    const m = this._m(nodeId);
    for (const k of [...m.keys()]) if (k.startsWith(prefix) && !keep.has(k)) m.delete(k);
  }
  drop(nodeId) { this.byNode.delete(nodeId); }
}

// ---- fast checks from a sample ----
export function fastChecks(store, node, st) {
  const id = node.id;
  // unreachable: 2+ consecutive failed samples
  // (only for nodes that have answered before; a booting node isn't "down")
  store.set(id, 'unreachable', st.everOk && st.failStreak >= 2 ? {
    severity: 'high', kind: 'unreachable', title: 'Node unreachable',
    detail: `SSH sample failed ${st.failStreak} times in a row: ${st.lastError || 'unknown error'}`, source: 'collector/ssh',
  } : null);
  const s = st.sample;
  if (!s || st.failStreak > 0) return;

  // cpu > 0.9 sustained >= 10s
  if (node.cpu != null && node.cpu > 0.9) { st.cpuHighSince = st.cpuHighSince || Date.now(); } else st.cpuHighSince = null;
  const cpuFor = st.cpuHighSince ? (Date.now() - st.cpuHighSince) / 1000 : 0;
  store.set(id, 'cpu-high', cpuFor >= 10 ? {
    severity: 'medium', kind: 'cpu-high', title: 'CPU saturated',
    detail: `CPU ${(node.cpu * 100).toFixed(0)}% for ${cpuFor.toFixed(0)}s (load1 ${s.load1})`, source: '/proc/stat',
  } : null);

  const memFrac = s.memTotal ? (s.memTotal - s.memAvail) / s.memTotal : 0;
  store.set(id, 'mem-high', memFrac > 0.9 ? {
    severity: 'medium', kind: 'mem-high', title: 'Memory nearly exhausted',
    detail: `${(memFrac * 100).toFixed(0)}% of ${(s.memTotal / 2 ** 20).toFixed(0)} MiB in use`, source: '/proc/meminfo',
  } : null);

  store.set(id, 'disk-full', s.diskPct != null && s.diskPct > 90 ? {
    severity: 'high', kind: 'disk-full', title: 'Root disk almost full',
    detail: `/ is ${s.diskPct}% used`, source: 'df',
  } : null);

  // service down (only once the role has been configured)
  const exp = EXPECTED_SERVICE[node.role];
  if (exp && s.ready) {
    const l = s.listen.find((x) => x.port === exp.port);
    const ok = l && l.procs.some((p) => p.name === exp.name || p.name.startsWith(exp.name));
    store.set(id, 'service-down', ok ? null : {
      severity: 'high', kind: 'service-down', title: `${exp.name} not listening on :${exp.port}`,
      detail: l ? `:${exp.port} is held by ${l.procs.map((p) => p.name).join(', ') || 'unknown'}` : `nothing is listening on :${exp.port}`,
      source: 'ss -tlnp',
    });
  }

  // nginx 5xx rate over the last 60s (lb)
  if (s.http) {
    const { total, errors5xx } = s.http;
    const rate = total ? errors5xx / total : 0;
    const sev = total >= 20 && rate > 0.05 ? 'high' : total >= 20 && rate > 0.01 ? 'medium' : null;
    store.set(id, 'http-5xx', sev ? {
      severity: sev, kind: 'http-5xx', title: 'Elevated HTTP 5xx rate',
      detail: `${errors5xx}/${total} requests returned 5xx in the last 60s (${(rate * 100).toFixed(1)}%)`,
      source: 'nginx access log',
    } : null);
  }
}

// ---- public exposure (TCP connect from the controller) ----
export function probePort(ip, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: ip, port });
    let done = false;
    const end = (open) => { if (done) return; done = true; sock.destroy(); resolve(open); };
    sock.setTimeout(timeoutMs, () => end(false));
    sock.once('connect', () => end(true));
    sock.once('error', () => end(false));
  });
}

export async function checkExposure(store, node, onStep) {
  const results = [];
  for (const port of PRIVATE_PORTS) {
    const open = await probePort(node.publicIp, port);
    results.push({ port, open });
    store.set(node.id, `public-exposure:${port}`, open ? {
      severity: 'critical', kind: 'public-exposure', title: `Internal port ${port} reachable from the internet`,
      detail: `TCP connect to ${node.publicIp}:${port} succeeded from outside the private network`, source: 'tcp-probe',
    } : null);
    if (onStep) await onStep({ port, open });
  }
  return results;
}

// ---- SSH brute force (journalctl, last 10 min) ----
export async function checkAuthLog(store, node) {
  const cmd = "journalctl -u ssh -u sshd --since '-10min' -q --no-pager -o cat 2>/dev/null | "
    + "grep -E 'Failed password|Invalid user|authenticating user|Failed publickey' | tail -n 5000";
  const r = await sshRun(node.publicIp, cmd, { timeoutMs: 15000 });
  if (r.code !== 0 && r.code !== 1) return null;
  const attempts = new Map(); // ip:port -> ip  (one attempt per source connection)
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/(\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]{6,}) port (\d+)/i);
    if (m) attempts.set(`${m[1]}:${m[2]}`, m[1]);
  }
  const perIp = new Map();
  for (const ip of attempts.values()) perIp.set(ip, (perIp.get(ip) || 0) + 1);
  const top = [...perIp.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const count = attempts.size;
  store.set(node.id, 'ssh-bruteforce', count > 20 ? {
    severity: 'medium', kind: 'ssh-bruteforce', title: 'SSH brute-force attempts',
    detail: `${count} failed SSH logins in the last 10 min from ${perIp.size} IPs; top: ${top.map(([ip, n]) => `${ip} (${n})`).join(', ')}`,
    source: 'journalctl -u ssh',
  } : null);
  return { count, sources: perIp.size, top };
}

// ---- nginx log analysis on demand (lb): last 60s status breakdown ----
export async function checkNginxLog(node) {
  const cmd = "tail -n 20000 /var/log/nginx/ari-access.log 2>/dev/null | awk -v t=$(( $(date +%s) - 60 )) "
    + "'$1>=t{n++; s[substr($2,1,1)\"xx\"]++} END{printf \"%d\", n+0; for(k in s) printf \" %s=%d\", k, s[k]; print \"\"}'";
  const r = await sshRun(node.publicIp, cmd, { timeoutMs: 15000 });
  if (r.code !== 0) return null;
  const [n, ...rest] = r.stdout.trim().split(' ');
  const classes = Object.fromEntries(rest.map((kv) => kv.split('=')).map(([k, v]) => [k, Number(v)]));
  return { total: Number(n) || 0, classes };
}

// ---- pending security updates ----
export async function checkUpdates(store, node) {
  const r = await sshRun(node.publicIp, "apt list --upgradable 2>/dev/null | grep -- '-security' | cut -d/ -f1", { timeoutMs: 30000 });
  if (r.code !== 0 && r.code !== 1) return null;
  const pkgs = r.stdout.split('\n').map((x) => x.trim()).filter(Boolean);
  const important = pkgs.filter((p) => /^linux-|^openssh/.test(p));
  store.set(node.id, 'security-updates', pkgs.length ? {
    severity: important.length ? 'medium' : 'low', kind: 'security-updates',
    title: `${pkgs.length} pending security update${pkgs.length === 1 ? '' : 's'}`,
    detail: (important.length ? `includes ${important.slice(0, 4).join(', ')}; ` : '') + pkgs.slice(0, 12).join(', ') + (pkgs.length > 12 ? ', ...' : ''),
    source: 'apt list --upgradable',
  } : null);
  return { count: pkgs.length, important };
}

// ---- known AcmePay vulnerabilities in the DEPLOYED code (static read) ----
// Severity per target-app/SECURITY-NOTES.md. Paths are repo-relative so they
// line up with repograph/codemap ids; the node path is /opt/acmepay/<rel>.
const CODE_RULES = [
  { key: 'SQLI', severity: 'critical', title: 'SQL injection in transaction search (string-concatenated SQL)',
    rel: 'src/server.js', re: /LIKE '%\$\{|= '\$\{/, endpoint: 'GET /api/transactions' },
  { key: 'SECRETS', severity: 'high', title: 'Hard-coded secrets committed to source',
    rel: 'src/config.js', re: /sk_live_|jwtSecret:\s*'/, endpoint: 'ALL' },
  { key: 'IDOR', severity: 'high', title: 'Broken access control / IDOR on user profile',
    rel: 'src/server.js', re: /app\.get\('\/api\/users\/:id',\s*async\s*\(req/, endpoint: 'GET /api/users/:id' },
  { key: 'VERBOSE', severity: 'medium', title: 'Verbose error messages leak stack traces & SQL',
    rel: 'src/server.js', re: /stack:\s*err\.stack/, endpoint: 'GET /api/transactions' },
  { key: 'MD5', severity: 'medium', title: 'Weak password hashing (unsalted MD5)',
    rel: 'src/db.js', re: /password_md5 TEXT/, endpoint: 'POST /api/login' },
];

export async function checkCode(store, node) {
  if (node.role !== 'app') return null;
  const files = [...new Set(CODE_RULES.map((r) => r.rel))];
  const r = await sshRun(node.publicIp, `cd /opt/acmepay && grep -nH '' ${files.join(' ')}`, { timeoutMs: 15000 });
  if (r.code !== 0) return null;
  const byFile = new Map();
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^([^:]+):(\d+):(.*)$/);
    if (!m) continue;
    if (!byFile.has(m[1])) byFile.set(m[1], []);
    byFile.get(m[1]).push({ n: Number(m[2]), text: m[3] });
  }
  const found = [];
  const keep = new Set();
  for (const rule of CODE_RULES) {
    const hits = (byFile.get(rule.rel) || []).filter((l) => rule.re.test(l.text));
    const key = `app-vuln:${rule.key}`;
    if (hits.length) {
      keep.add(key);
      const file = `target-app/${rule.rel}`;
      const issue = {
        severity: rule.severity, kind: 'app-vuln', title: rule.title,
        detail: `${file}:${hits.map((h) => h.n).join(',')} (deployed at /opt/acmepay/${rule.rel}) - ${rule.endpoint}`,
        source: 'code-scan', file, line: hits[0].n, endpoint: rule.endpoint,
        // innermost codemap symbol containing the line, so the badge lands on it
        symbolId: symbolAt(file, hits[0].n),
      };
      store.set(node.id, key, issue);
      found.push({ key, ...issue });
    }
  }
  store.clearPrefix(node.id, 'app-vuln:', keep);
  return found;
}
