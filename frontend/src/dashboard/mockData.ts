// Built-in mock data so the dashboard always renders, even with no telemetry
// service running. The generators produce plausible, continuously-evolving data.
import type {
  LogEntry,
  Metrics,
  SeriesPoint,
  Topology,
  Vuln,
} from './types'

const SERIES_LEN = 150 // ~5 min at 2s cadence

function rnd(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

// ---- Metrics ---------------------------------------------------------------

function makePoint(t: number, base: number): SeriesPoint {
  const wave = Math.sin(t / 15000) * 180
  const rps = Math.max(20, Math.round(base + wave + rnd(-60, 60)))
  return {
    t,
    rps,
    errorRate: Math.max(0, +(rnd(0.2, 2.6) + (wave > 120 ? 0.8 : 0)).toFixed(2)),
    latencyMs: Math.round(rnd(40, 120) + (wave > 120 ? 40 : 0)),
    activeUsers: Math.round(rps * rnd(2.5, 3.5)),
  }
}

export function makeMetricsSeed(): Metrics {
  const now = Date.now()
  const base = 520
  const series: SeriesPoint[] = []
  for (let i = SERIES_LEN - 1; i >= 0; i--) {
    series.push(makePoint(now - i * 2000, base))
  }
  const last = series[series.length - 1]
  return {
    ts: now,
    mode: 'mock',
    rps: last.rps,
    errorRate: last.errorRate,
    latencyMs: last.latencyMs,
    activeUsers: last.activeUsers,
    bandwidthMbps: +rnd(180, 640).toFixed(1),
    series,
  }
}

// Advance a metrics snapshot by one tick, keeping the rolling window length.
export function advanceMetrics(prev: Metrics): Metrics {
  const now = Date.now()
  const next = makePoint(now, 520)
  const series = [...prev.series.slice(1), next]
  return {
    ts: now,
    mode: 'mock',
    rps: next.rps,
    errorRate: next.errorRate,
    latencyMs: next.latencyMs,
    activeUsers: next.activeUsers,
    bandwidthMbps: +Math.max(80, prev.bandwidthMbps + rnd(-40, 40)).toFixed(1),
    series,
  }
}

// ---- Logs ------------------------------------------------------------------

const LEVELS = ['info', 'info', 'info', 'debug', 'warn', 'error', 'critical'] as const
const SOURCES = ['edge-waf', 'lb-01', 'app-01', 'app-02', 'app-03', 'db-primary', 'cache-01', 'ari-engine'] as const
const METHODS = ['GET', 'GET', 'GET', 'POST', 'PUT', 'DELETE'] as const
const PATHS = [
  '/api/login',
  '/api/orders',
  '/api/users/me',
  '/api/products',
  '/healthz',
  '/api/checkout',
  '/admin/metrics',
  '/api/search',
] as const
const MSGS = [
  'request served',
  'rate limit applied',
  'upstream latency spike',
  'auth token refreshed',
  'blocked SQLi attempt',
  'connection pool saturated',
  'cache miss, backfilled',
  'anomalous traffic pattern flagged',
  'TLS handshake completed',
] as const

function randomIp(): string {
  return `${Math.floor(rnd(1, 223))}.${Math.floor(rnd(0, 255))}.${Math.floor(
    rnd(0, 255),
  )}.${Math.floor(rnd(1, 254))}`
}

export function makeLog(): LogEntry {
  const level = pick(LEVELS)
  const status =
    level === 'error' || level === 'critical'
      ? pick([500, 502, 503, 403])
      : level === 'warn'
        ? pick([429, 404, 301])
        : pick([200, 200, 200, 204, 206])
  return {
    ts: Date.now(),
    level,
    source: pick(SOURCES),
    ip: randomIp(),
    method: pick(METHODS),
    path: pick(PATHS),
    status,
    msg: pick(MSGS),
  }
}

export function makeLogSeed(n = 60): LogEntry[] {
  const out: LogEntry[] = []
  for (let i = 0; i < n; i++) {
    const l = makeLog()
    l.ts = Date.now() - (n - i) * 1500
    out.push(l)
  }
  return out
}

// ---- Topology --------------------------------------------------------------

export function makeTopology(): Topology {
  return {
    nodes: [
      { id: 'internet', label: 'Internet', type: 'internet', status: 'healthy' },
      { id: 'waf', label: 'Edge / WAF', type: 'waf', status: 'healthy' },
      { id: 'lb', label: 'Load Balancer', type: 'lb', status: 'healthy' },
      { id: 'app-01', label: 'app-01', type: 'app', status: 'healthy' },
      { id: 'app-02', label: 'app-02', type: 'app', status: 'degraded' },
      { id: 'app-03', label: 'app-03', type: 'app', status: 'healthy' },
      { id: 'db', label: 'db-primary', type: 'db', status: 'healthy' },
      { id: 'cache', label: 'cache-01', type: 'cache', status: 'healthy' },
    ],
    edges: [
      { from: 'internet', to: 'waf' },
      { from: 'waf', to: 'lb' },
      { from: 'lb', to: 'app-01' },
      { from: 'lb', to: 'app-02' },
      { from: 'lb', to: 'app-03' },
      { from: 'app-01', to: 'db' },
      { from: 'app-02', to: 'db' },
      { from: 'app-03', to: 'db' },
      { from: 'app-01', to: 'cache' },
      { from: 'app-02', to: 'cache' },
      { from: 'app-03', to: 'cache' },
    ],
  }
}

const STATUSES = ['healthy', 'healthy', 'healthy', 'degraded', 'down'] as const

// Randomly nudge one app/cache node's status to keep the graph alive.
export function jitterTopology(topo: Topology): Topology {
  const nodes = topo.nodes.map((n) => ({ ...n }))
  const candidates = nodes.filter(
    (n) => n.type === 'app' || n.type === 'cache',
  )
  if (candidates.length > 0 && Math.random() < 0.5) {
    const node = pick(candidates)
    node.status = pick(STATUSES)
  }
  return { nodes, edges: topo.edges }
}

// ---- Vulnerabilities -------------------------------------------------------

const VULN_TITLES = [
  { severity: 'critical', title: 'Unauthenticated RCE in image upload handler' },
  { severity: 'critical', title: 'SQL injection via order lookup filter' },
  { severity: 'high', title: 'Broken access control on /admin/metrics' },
  { severity: 'high', title: 'Secrets committed to public repository' },
  { severity: 'high', title: 'SSRF in webhook validation endpoint' },
  { severity: 'medium', title: 'Reflected XSS in search parameter' },
  { severity: 'medium', title: 'Missing rate limit on login endpoint' },
  { severity: 'medium', title: 'Outdated TLS ciphers enabled on edge' },
  { severity: 'low', title: 'Verbose error stack traces exposed' },
  { severity: 'low', title: 'Missing security headers on static assets' },
] as const

const PROJECTS = ['checkout-svc', 'auth-svc', 'web-gateway', 'orders-api', 'admin-portal'] as const
const ENDPOINTS = ['/api/upload', '/api/orders', '/admin/metrics', '/api/login', '/webhooks/stripe', '/api/search'] as const

let vulnCounter = 1000

export function makeVuln(): Vuln {
  const tpl = pick(VULN_TITLES)
  vulnCounter += 1
  return {
    id: `VULN-${vulnCounter}`,
    severity: tpl.severity,
    title: tpl.title,
    project: pick(PROJECTS),
    endpoint: pick(ENDPOINTS),
    status: pick(['discovered', 'discovered', 'investigating', 'remediated']),
    discoveredAt: Date.now(),
  }
}

export function makeVulnSeed(n = 7): Vuln[] {
  const out: Vuln[] = []
  for (let i = 0; i < n; i++) {
    const v = makeVuln()
    v.discoveredAt = Date.now() - i * 90000
    out.push(v)
  }
  return out
}
