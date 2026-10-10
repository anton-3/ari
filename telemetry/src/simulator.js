// Traffic simulation engine for Ari telemetry.
// Produces realistic fake metrics + logs. In "synthetic" mode (default) it
// NEVER sends real network traffic anywhere. In optional "live" mode it may make
// benign HTTP GETs to the AcmePay target app to sample real-ish latency, but
// never floods.

const SERIES_MAX = 300;   // ~5 min @ 1s
const LOG_MAX = 500;

// ---- believable request paths for an AcmePay-style app ----
const NORMAL_PATHS = [
  ['GET', '/'],
  ['GET', '/dashboard'],
  ['GET', '/api/account'],
  ['GET', '/api/transactions'],
  ['POST', '/api/payments'],
  ['GET', '/api/balance'],
  ['POST', '/api/login'],
  ['GET', '/static/app.js'],
  ['GET', '/health'],
];
const ATTACK_PATHS = [
  ['POST', '/api/login'],
  ['POST', '/api/payments'],
  ['GET', '/admin'],
  ['GET', '/.env'],
  ['GET', '/api/account?id=1%20OR%201=1'],
];

const USER_AGENTS_SRC = ['web', 'mobile', 'api'];

function randn() {
  // Box-Muller
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function randIp() {
  return `${1 + Math.floor(Math.random() * 223)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${1 + Math.floor(Math.random() * 254)}`;
}

// A small pool of "attacker" IPs so surges look concentrated.
const ATTACKER_IPS = Array.from({ length: 4 }, () => randIp());

export class Simulator {
  constructor({ liveTarget = null } = {}) {
    this.mode = 'normal';
    this.target = liveTarget; // e.g. http://localhost:8070 when live sampling
    this.liveSample = null;   // latest sampled latency from live target (ms)
    this.series = [];         // [{ t, rps, errorRate, latencyMs, activeUsers }]
    this.logs = [];           // rolling buffer
    this.listeners = new Set(); // log listeners (for WS push)
    this.startTime = Date.now();
    this._seedTopology();
    this._seedVulns();
    this._surgeStartedAt = 0;
  }

  onLog(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  setMode(mode, target) {
    if (mode !== 'normal' && mode !== 'surge') return false;
    const prev = this.mode;
    this.mode = mode;
    if (target) this.target = target;
    if (mode === 'surge' && prev !== 'surge') {
      this._surgeStartedAt = Date.now();
      this._pushLog({ level: 'warn', source: 'waf', ip: ATTACKER_IPS[0], method: 'POST', path: '/api/login', status: 429,
        msg: 'Traffic surge detected: request rate spiking from a small set of source IPs' });
      // degrade topology to look like it's under load
      this._setNode('app-1', 'degraded');
      this._setNode('edge', 'degraded');
    } else if (mode === 'normal' && prev !== 'normal') {
      this._pushLog({ level: 'info', source: 'waf', ip: '-', method: '-', path: '-', status: 200,
        msg: 'Traffic returned to normal baseline' });
      for (const n of this.topology.nodes) n.status = 'healthy';
    }
    return true;
  }

  // ---------- topology ----------
  _seedTopology() {
    this.topology = {
      nodes: [
        { id: 'internet', label: 'Internet', type: 'edge', status: 'healthy' },
        { id: 'edge', label: 'WAF / Edge', type: 'firewall', status: 'healthy' },
        { id: 'lb', label: 'Load Balancer', type: 'lb', status: 'healthy' },
        { id: 'app-1', label: 'AcmePay App 1', type: 'app', status: 'healthy' },
        { id: 'app-2', label: 'AcmePay App 2', type: 'app', status: 'healthy' },
        { id: 'db', label: 'Postgres (primary)', type: 'db', status: 'healthy' },
        { id: 'cache', label: 'Redis Cache', type: 'cache', status: 'healthy' },
      ],
      edges: [
        { from: 'internet', to: 'edge' },
        { from: 'edge', to: 'lb' },
        { from: 'lb', to: 'app-1' },
        { from: 'lb', to: 'app-2' },
        { from: 'app-1', to: 'db' },
        { from: 'app-2', to: 'db' },
        { from: 'app-1', to: 'cache' },
        { from: 'app-2', to: 'cache' },
      ],
    };
  }
  _setNode(id, status) {
    const n = this.topology.nodes.find((x) => x.id === id);
    if (n) n.status = status;
  }

  // ---------- vulns ----------
  _seedVulns() {
    const now = Date.now();
    this.vulns = [
      { id: 'VULN-1001', severity: 'critical', title: 'SQL injection in transaction search', project: 'AcmePay', endpoint: 'GET /api/transactions', status: 'open', discoveredAt: new Date(now - 3600e3 * 6).toISOString() },
      { id: 'VULN-1002', severity: 'high', title: 'Missing rate limiting on login', project: 'AcmePay', endpoint: 'POST /api/login', status: 'open', discoveredAt: new Date(now - 3600e3 * 3).toISOString() },
      { id: 'VULN-1003', severity: 'medium', title: 'Verbose stack traces leaked on 500', project: 'AcmePay', endpoint: 'GET /api/payments', status: 'open', discoveredAt: new Date(now - 3600e3 * 2).toISOString() },
      { id: 'VULN-1004', severity: 'low', title: 'Cookie missing SameSite attribute', project: 'AcmePay', endpoint: 'ALL', status: 'remediated', discoveredAt: new Date(now - 3600e3 * 24).toISOString() },
      { id: 'VULN-1005', severity: 'high', title: 'Outdated TLS ciphers accepted at edge', project: 'AcmePay', endpoint: 'WAF / Edge', status: 'remediated', discoveredAt: new Date(now - 3600e3 * 30).toISOString() },
    ];
  }
  upsertVuln(v) {
    if (!v || typeof v !== 'object') return null;
    const id = v.id || `VULN-${1000 + this.vulns.length + Math.floor(Math.random() * 9000)}`;
    const existing = this.vulns.find((x) => x.id === id);
    const merged = {
      id,
      severity: v.severity || existing?.severity || 'medium',
      title: v.title || existing?.title || 'Untitled finding',
      project: v.project || existing?.project || 'AcmePay',
      endpoint: v.endpoint || existing?.endpoint || 'ALL',
      status: v.status || existing?.status || 'open',
      discoveredAt: existing?.discoveredAt || v.discoveredAt || new Date().toISOString(),
    };
    if (existing) Object.assign(existing, merged);
    else this.vulns.push(merged);
    return merged;
  }
  setVulnStatus(id, status) {
    const v = this.vulns.find((x) => x.id === id);
    if (!v) return null;
    v.status = status;
    return v;
  }

  // ---------- logs ----------
  _pushLog(entry) {
    const full = { ts: new Date().toISOString(), level: 'info', source: 'app', ip: '-', method: 'GET', path: '/', status: 200, msg: '', ...entry };
    this.logs.push(full);
    if (this.logs.length > LOG_MAX) this.logs.shift();
    for (const fn of this.listeners) {
      try { fn(full); } catch { /* ignore */ }
    }
    return full;
  }

  // ---------- main tick ----------
  tick() {
    const now = Date.now();
    const secsOfDay = ((now / 1000) % 86400);
    // gentle diurnal variation (sine over a day) + noise
    const diurnal = 0.75 + 0.35 * Math.sin((secsOfDay / 86400) * 2 * Math.PI);

    let rps, errorRate, latencyMs, activeUsers, bandwidthMbps;

    if (this.mode === 'surge') {
      const rampSecs = (now - this._surgeStartedAt) / 1000;
      const ramp = clamp(rampSecs / 5, 0.4, 1); // ramp in over ~5s
      rps = Math.round((1800 + randn() * 180) * ramp);
      errorRate = clamp(0.35 + randn() * 0.06, 0.05, 0.85);
      latencyMs = Math.round(clamp(850 + randn() * 160, 200, 3000));
      activeUsers = Math.round(clamp(120 + randn() * 20, 20, 400)); // real users few; traffic from bots
      bandwidthMbps = +(clamp(420 + randn() * 60, 50, 1200)).toFixed(1);
    } else {
      rps = Math.round(clamp(140 * diurnal + randn() * 12, 20, 600));
      errorRate = clamp(0.012 + randn() * 0.004, 0, 0.08);
      latencyMs = Math.round(clamp(120 + randn() * 18, 40, 400));
      activeUsers = Math.round(clamp(900 * diurnal + randn() * 40, 50, 3000));
      bandwidthMbps = +(clamp(38 * diurnal + randn() * 4, 2, 200)).toFixed(1);
    }

    // if live sampling available, nudge latency toward real sample
    if (this.liveSample != null) {
      latencyMs = Math.round(latencyMs * 0.5 + this.liveSample * 0.5);
    }

    const point = { t: new Date(now).toISOString(), rps, errorRate: +errorRate.toFixed(4), latencyMs, activeUsers };
    this.series.push(point);
    if (this.series.length > SERIES_MAX) this.series.shift();

    // generate a few representative log lines this tick
    this._generateLogs(rps, errorRate);

    return this.snapshot(point, bandwidthMbps);
  }

  _generateLogs(rps, errorRate) {
    // emit ~2-4 log lines/sec regardless of rps (buffer is bounded)
    const n = this.mode === 'surge' ? 4 : 2 + Math.floor(Math.random() * 2);
    for (let i = 0; i < n; i++) {
      const attack = this.mode === 'surge' && Math.random() < 0.8;
      const [method, path] = attack ? pick(ATTACK_PATHS) : pick(NORMAL_PATHS);
      const ip = attack ? pick(ATTACKER_IPS) : randIp();
      const isErr = Math.random() < errorRate;
      let status = 200;
      if (isErr) status = attack ? pick([401, 403, 429, 500]) : pick([400, 404, 500]);
      else if (method === 'POST') status = pick([200, 201]);
      const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
      const source = pick(USER_AGENTS_SRC);
      let msg = `${method} ${path} -> ${status}`;
      if (attack && status === 429) msg = `rate limit triggered for ${ip}`;
      if (attack && path.includes('OR%201=1')) msg = `possible SQL injection attempt from ${ip}`;
      this._pushLog({ level, source, ip, method, path, status, msg });
    }
  }

  snapshot(latest, bandwidthMbps) {
    const point = latest || this.series[this.series.length - 1] || { rps: 0, errorRate: 0, latencyMs: 0, activeUsers: 0 };
    if (bandwidthMbps == null) bandwidthMbps = this.mode === 'surge' ? 420 : 38;
    return {
      ts: new Date().toISOString(),
      mode: this.mode,
      rps: point.rps,
      errorRate: point.errorRate,
      latencyMs: point.latencyMs,
      activeUsers: point.activeUsers,
      bandwidthMbps,
      series: this.series.slice(-SERIES_MAX),
    };
  }

  getLogs(limit = 100) {
    const n = clamp(parseInt(limit, 10) || 100, 1, LOG_MAX);
    return this.logs.slice(-n);
  }

  // optional: benign live sample of the target app (one GET, not a flood)
  async sampleLiveTarget() {
    if (!this.target) return;
    try {
      const t0 = Date.now();
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 2000);
      await fetch(this.target + '/health', { signal: ctrl.signal }).catch(() => fetch(this.target, { signal: ctrl.signal }));
      clearTimeout(to);
      this.liveSample = Date.now() - t0;
    } catch {
      this.liveSample = null;
    }
  }
}
