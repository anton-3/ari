// Built-in, self-evolving mock data so the graph page always renders and
// animates even with no telemetry service running. Generators produce
// plausible, continuously-evolving data that mirrors the service contract.
import type {
  Agent,
  AgentEvent,
  AgentsResponse,
  Metrics,
  ReasoningLine,
  RepoGraph,
  RepoNode,
  SeriesPoint,
  Topology,
  GraphEdge,
} from './types'

function rnd(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

// ---- Metrics ---------------------------------------------------------------

const SERIES_LEN = 120

function makePoint(t: number, base: number, surge: boolean): SeriesPoint {
  const wave = Math.sin(t / 15000) * 180
  const boost = surge ? 900 : 0
  const rps = Math.max(20, Math.round(base + wave + boost + rnd(-60, 60)))
  return {
    t,
    rps,
    errorRate: Math.max(
      0,
      +(rnd(0.2, 2.6) + (wave > 120 ? 0.8 : 0) + (surge ? 6 : 0)).toFixed(2),
    ),
    latencyMs: Math.round(rnd(40, 120) + (wave > 120 ? 40 : 0) + (surge ? 180 : 0)),
    activeUsers: Math.round(rps * rnd(2.5, 3.5)),
  }
}

export function makeMetricsSeed(): Metrics {
  const now = Date.now()
  const base = 520
  const series: SeriesPoint[] = []
  for (let i = SERIES_LEN - 1; i >= 0; i--) {
    series.push(makePoint(now - i * 2000, base, false))
  }
  const last = series[series.length - 1]
  return {
    ts: now,
    mode: 'normal',
    rps: last.rps,
    errorRate: last.errorRate,
    latencyMs: last.latencyMs,
    activeUsers: last.activeUsers,
    bandwidthMbps: +rnd(180, 640).toFixed(1),
    series,
  }
}

// Occasionally flip into a "surge" mode for a few ticks, then back to normal.
let surgeTicks = 0

export function advanceMetrics(prev: Metrics): Metrics {
  const now = Date.now()
  if (surgeTicks > 0) {
    surgeTicks -= 1
  } else if (Math.random() < 0.04) {
    surgeTicks = Math.floor(rnd(6, 14))
  }
  const surge = surgeTicks > 0
  const next = makePoint(now, 520, surge)
  const series = [...prev.series.slice(1), next]
  return {
    ts: now,
    mode: surge ? 'surge' : 'normal',
    rps: next.rps,
    errorRate: next.errorRate,
    latencyMs: next.latencyMs,
    activeUsers: next.activeUsers,
    bandwidthMbps: +Math.max(80, (prev.bandwidthMbps ?? 300) + rnd(-40, 40)).toFixed(1),
    series,
  }
}

// ---- Topology (infra hubs, like the reference screenshot) ------------------

export function makeTopology(): Topology {
  return {
    nodes: [
      { id: 'traffic', label: 'Traffic', type: 'traffic', status: 'healthy' },
      { id: 'waf', label: 'Edge / WAF', type: 'waf', status: 'healthy' },
      { id: 'lb', label: 'Load Balancer', type: 'lb', status: 'healthy' },
      { id: 'api', label: 'API', type: 'api', status: 'healthy' },
      { id: 'auth', label: 'Auth', type: 'auth', status: 'healthy' },
      { id: 'db', label: 'Database', type: 'db', status: 'healthy' },
      { id: 'cache', label: 'Cache', type: 'cache', status: 'healthy' },
    ],
    edges: [
      { from: 'traffic', to: 'waf' },
      { from: 'waf', to: 'lb' },
      { from: 'lb', to: 'api' },
      { from: 'lb', to: 'auth' },
      { from: 'api', to: 'auth' },
      { from: 'api', to: 'db' },
      { from: 'api', to: 'cache' },
      { from: 'auth', to: 'db' },
    ],
  }
}

const TOPO_STATUSES = ['healthy', 'healthy', 'healthy', 'degraded', 'down'] as const

export function jitterTopology(topo: Topology): Topology {
  const nodes = topo.nodes.map((n) => ({ ...n }))
  const candidates = nodes.filter(
    (n) => n.type === 'api' || n.type === 'auth' || n.type === 'cache',
  )
  if (candidates.length > 0 && Math.random() < 0.4) {
    const node = pick(candidates)
    node.status = pick(TOPO_STATUSES)
  }
  return { nodes, edges: topo.edges }
}

// ---- Repo graph ------------------------------------------------------------

interface DirSpec {
  dir: string
  files: string[]
  kind: RepoNode['kind']
}

const REPO_DIRS: DirSpec[] = [
  {
    dir: 'src/api',
    kind: 'file',
    files: ['server.ts', 'router.ts', 'orders.ts', 'products.ts', 'checkout.ts', 'search.ts', 'webhooks.ts'],
  },
  {
    dir: 'src/auth',
    kind: 'file',
    files: ['login.ts', 'session.ts', 'tokens.ts', 'rbac.ts', 'oauth.ts'],
  },
  {
    dir: 'src/db',
    kind: 'file',
    files: ['pool.ts', 'queries.ts', 'migrations.ts', 'models.ts'],
  },
  {
    dir: 'src/web',
    kind: 'file',
    files: ['app.tsx', 'routes.tsx', 'store.ts', 'api-client.ts', 'components.tsx'],
  },
  {
    dir: 'tests',
    kind: 'test',
    files: ['auth.test.ts', 'orders.test.ts', 'api.test.ts'],
  },
  {
    dir: 'infra',
    kind: 'infra',
    files: ['Dockerfile', 'deploy.yaml', 'nginx.conf'],
  },
]

export function makeRepoGraph(): RepoGraph {
  const nodes: RepoNode[] = []
  const edges: GraphEdge[] = []
  const byDir: Record<string, string[]> = {}

  for (const spec of REPO_DIRS) {
    byDir[spec.dir] = []
    for (const f of spec.files) {
      const id = `${spec.dir}/${f}`
      byDir[spec.dir].push(id)
      nodes.push({
        id,
        path: id,
        dir: spec.dir,
        label: f,
        loc: Math.round(rnd(30, 480)),
        kind: f.endsWith('.conf') || f.endsWith('.yaml') || f === 'Dockerfile' ? 'config' : spec.kind,
      })
    }
    // intra-dir edges (files within a module reference each other)
    const ids = byDir[spec.dir]
    for (let i = 1; i < ids.length; i++) {
      edges.push({ from: ids[i - 1], to: ids[i] })
      if (i > 1 && Math.random() < 0.4) edges.push({ from: ids[0], to: ids[i] })
    }
  }

  // cross-module edges (imports between modules)
  const link = (a: string, b: string) => {
    const from = byDir[a]?.[Math.floor(rnd(0, byDir[a].length))]
    const to = byDir[b]?.[Math.floor(rnd(0, byDir[b].length))]
    if (from && to) edges.push({ from, to })
  }
  for (let i = 0; i < 10; i++) {
    link('src/api', 'src/auth')
    link('src/api', 'src/db')
    link('src/web', 'src/api')
    link('tests', 'src/api')
    link('tests', 'src/auth')
  }

  return { nodes, edges, scannedAt: Date.now() }
}

// ---- Agents ----------------------------------------------------------------

const AGENT_TYPES: Agent['type'][] = ['scanner', 'patcher', 'auditor', 'sentinel', 'tracer']

const AGENT_LABELS: Record<string, string> = {
  scanner: 'Scanner',
  patcher: 'Patcher',
  auditor: 'Auditor',
  sentinel: 'Sentinel',
  tracer: 'Tracer',
}

const FINDINGS = [
  { severity: 'critical', text: 'SQL injection reachable from order lookup' },
  { severity: 'critical', text: 'Unauthenticated upload handler allows RCE' },
  { severity: 'high', text: 'Broken access control on /admin/metrics' },
  { severity: 'high', text: 'Hardcoded secret in db/pool.ts' },
  { severity: 'high', text: 'SSRF in webhook validation' },
  { severity: 'medium', text: 'Missing rate limit on auth/login.ts' },
  { severity: 'medium', text: 'Reflected XSS in search param' },
  { severity: 'low', text: 'Verbose stack traces exposed' },
] as const

let agentCounter = 0

function spawnAgent(targetIds: string[]): Agent {
  agentCounter += 1
  const type = pick(AGENT_TYPES)
  return {
    id: `agent-${agentCounter}`,
    type,
    label: `${AGENT_LABELS[type] ?? type}-${agentCounter}`,
    status: 'spawning',
    targetNodeId: pick(targetIds),
    progress: 0,
    note: 'dispatched by Ari',
  }
}

export function makeAgentsSeed(targetIds: string[]): AgentsResponse {
  const agents: Agent[] = []
  const n = Math.max(3, Math.min(5, targetIds.length))
  for (let i = 0; i < n; i++) {
    const a = spawnAgent(targetIds)
    a.status = pick(['moving', 'working', 'working'])
    a.progress = a.status === 'working' ? rnd(0.1, 0.7) : 0
    agents.push(a)
  }
  return { agents, events: [] }
}

// Advance the agent swarm by one tick, producing any events generated.
export function advanceAgents(
  prev: AgentsResponse,
  targetIds: string[],
): AgentsResponse {
  const events: AgentEvent[] = []
  let agents = prev.agents.map((a) => ({ ...a }))

  for (const a of agents) {
    switch (a.status) {
      case 'spawning':
        a.status = 'moving'
        break
      case 'moving':
        a.progress = Math.min(1, a.progress + rnd(0.08, 0.2))
        if (a.progress >= 1) {
          a.status = 'working'
          a.progress = 0
        }
        break
      case 'working': {
        a.progress = Math.min(1, a.progress + rnd(0.04, 0.12))
        if (Math.random() < 0.12) {
          const f = pick(FINDINGS)
          a.note = f.text
          events.push({
            ts: Date.now(),
            agentId: a.id,
            kind: 'finding',
            text: f.text,
            nodeId: a.targetNodeId,
            severity: f.severity,
          })
        }
        if (a.progress >= 1) {
          a.status = 'reporting'
          events.push({
            ts: Date.now(),
            agentId: a.id,
            kind: 'complete',
            text: `${a.label} finished sweep of ${a.targetNodeId}`,
            nodeId: a.targetNodeId,
          })
        }
        break
      }
      case 'reporting':
        a.status = 'recalled'
        break
      case 'recalled':
        a.progress = Math.max(0, a.progress - 0.15)
        break
      default:
        break
    }
  }

  // Drop fully-recalled agents.
  agents = agents.filter((a) => !(a.status === 'recalled' && a.progress <= 0))

  // Occasionally dispatch a new agent.
  if (agents.length < 6 && Math.random() < 0.35 && targetIds.length > 0) {
    const a = spawnAgent(targetIds)
    agents.push(a)
    events.push({
      ts: Date.now(),
      agentId: a.id,
      kind: 'spawn',
      text: `Ari dispatched ${a.label} → ${a.targetNodeId}`,
      nodeId: a.targetNodeId,
    })
  }

  return { agents, events }
}

// ---- Reasoning -------------------------------------------------------------

const REASONING = [
  'Monitoring 4 connected components across the service mesh.',
  'Baseline request pattern nominal; watching error-rate derivative.',
  'Cross-referencing commit e30e896 against the auth module surface.',
  'Elevated latency on the API hub — dispatching a tracer to confirm.',
  'Correlating WAF blocks with the order lookup endpoint.',
  'Hypothesis: unvalidated filter flows into a raw SQL string.',
  'Spawning a scanner on src/db to walk the query builders.',
  'Confidence 0.82 that the upload handler skips authentication.',
  'Patching plan staged; holding for a second auditor to confirm.',
  'Traffic surge detected — scaling particle sampling, re-weighting risk.',
  'Recalling idle agents to conserve the swarm budget.',
  'Secrets scanner flagged a token literal in db/pool.ts.',
  'Rate-limit gap on auth/login.ts raises credential-stuffing risk.',
  'Narrowing blast radius: the finding is reachable from the edge.',
  'All clear on the cache tier; redirecting attention upstream.',
  'Drafting a remediation PR against the orders API router.',
] as const

let reasonCursor = 0

export function makeReasoningSeed(n = 6): ReasoningLine[] {
  const out: ReasoningLine[] = []
  for (let i = 0; i < n; i++) {
    out.push({ ts: Date.now() - (n - i) * 4000, text: REASONING[i % REASONING.length] })
  }
  return out
}

export function makeReasoningLine(): ReasoningLine {
  reasonCursor = (reasonCursor + 1 + Math.floor(Math.random() * 2)) % REASONING.length
  return { ts: Date.now(), text: REASONING[reasonCursor] }
}
