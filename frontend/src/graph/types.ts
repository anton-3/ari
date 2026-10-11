// Shapes mirror the telemetry service API contract for the graph page.

// ---- Metrics (shared with /api/metrics) -----------------------------------
export interface SeriesPoint {
  t: number
  rps: number
  errorRate: number
  latencyMs: number
  activeUsers: number
  requestsPerMinute?: number | null
}

export interface Metrics {
  requestsLast180s?: number | null
  requestsPerMinute?: number | null
  observedAt?: number | null
  stale?: boolean
  source?: string
  windowSeconds?: number
  rateWindowSeconds?: number
  ts: number
  mode: string
  rps: number
  errorRate: number
  latencyMs: number
  activeUsers: number
  bandwidthMbps?: number
  series: SeriesPoint[]
}

// ---- Repo graph (/api/repograph) ------------------------------------------
export type RepoNodeKind =
  | 'file'
  | 'config'
  | 'test'
  | 'infra'
  | 'doc'
  | string

export interface RepoNode {
  id: string
  path: string
  dir: string
  label: string
  loc: number
  kind: RepoNodeKind
}

export interface GraphEdge {
  from: string
  to: string
}

export interface RepoGraph {
  nodes: RepoNode[]
  edges: GraphEdge[]
  scannedAt: number
}

// ---- Infra topology (/api/topology) ---------------------------------------
export type TopoStatus = 'healthy' | 'degraded' | 'down' | string
export type TopoType =
  | 'internet'
  | 'edge'
  | 'traffic'
  | 'waf'
  | 'lb'
  | 'app'
  | 'api'
  | 'auth'
  | 'db'
  | 'cache'
  | string

export interface TopoNode {
  id: string
  label: string
  type: TopoType
  status: TopoStatus
}

export interface Topology {
  nodes: TopoNode[]
  edges: GraphEdge[]
}

// ---- Agents (/api/agents) -------------------------------------------------
export type AgentStatus =
  | 'spawning'
  | 'moving'
  | 'working'
  | 'reporting'
  | 'recalled'
  | 'idle'
  | string

export type AgentType =
  | 'scanner'
  | 'patcher'
  | 'auditor'
  | 'sentinel'
  | 'tracer'
  | string

export interface Agent {
  id: string
  type: AgentType
  label: string
  status: AgentStatus
  targetNodeId: string
  progress: number // 0..1
  note?: string
  simulated?: boolean
}

export interface FindingDetail {
  id?: string
  title?: string
  file?: string
  line?: number
  severity?: 'critical' | 'high' | 'medium' | 'low' | string
  endpoint?: string
}

export interface AgentEvent {
  ts: number | string
  agentId: string
  kind: 'finding' | 'spawn' | 'recall' | 'complete' | string
  text: string
  nodeId?: string
  // The service tags the target as `targetNodeId` and nests the finding object.
  targetNodeId?: string
  finding?: FindingDetail
  severity?: 'critical' | 'high' | 'medium' | 'low' | string
}

// ---- Vulns (/api/vulns, optional) -----------------------------------------
export interface Vuln {
  id: string
  severity: 'critical' | 'high' | 'medium' | 'low' | string
  title: string
  project?: string
  endpoint?: string
  file?: string
  status: 'open' | 'investigating' | 'remediated' | string
  discoveredAt?: number | string
}

export interface VulnsResponse {
  vulns: Vuln[]
}

// A single open problem resolved onto the graph, with its severity.
export interface OpenFinding {
  key: string
  nodeId?: string
  file?: string
  severity: string
  ts: number
}

export interface AgentsResponse {
  agents: Agent[]
  events: AgentEvent[]
}

// ---- Reasoning (/api/reasoning) -------------------------------------------
export interface ReasoningLine {
  ts: number
  text: string
}

export interface ReasoningResponse {
  lines: ReasoningLine[]
}

// ---- WebSocket envelope ----------------------------------------------------
export type WsMessage =
  | { type: 'metrics'; data: Metrics }
  | { type: 'log'; data: unknown }
  | { type: 'agents'; data: AgentsResponse }
  | { type: 'reasoning'; data: ReasoningLine }
  | { type: string; data: unknown }

// Connection state surfaced to the UI.
export type FeedSource = 'live' | 'polling' | 'mock' | 'connecting'

// ---- Fleet (/api/fleet) — real servers running the example app -------------
export type FleetRole =
  | 'lb'
  | 'app'
  | 'db'
  | 'cache'
  | 'worker'
  | 'traffic'
  | 'controller'
  | 'internet'
  | string

export type FleetStatus = 'provisioning' | 'booting' | 'running' | 'offline' | 'deleting' | string

export type FleetProtocol = 'http' | 'http-app' | 'postgres' | 'redis' | 'ssh' | 'other' | string

export interface FleetProcess {
  name: string
  pid: number
  ports: number[]
}

export type IssueSeverity = 'critical' | 'high' | 'medium' | 'low' | string

export interface FleetIssue {
  id: string
  severity: IssueSeverity
  kind: string
  title: string
  detail: string
  since: number | string
  source: string
  file?: string // optional repo path when the issue is tied to a file
  symbolId?: string // optional codemap symbol the issue is tied to
}

// NOTE: on the wire, string/array/number fields below may be null (e.g. the
// synthetic controller/internet nodes have no IPs). useFleet.publish() is the
// single normalization boundary; everything downstream sees these shapes.
export interface FleetNode {
  servingState?: 'standby' | 'activating' | 'serving' | 'failed'
  inUpstream?: boolean
  activation?: { id: string; status: string; progress: number; startedAt: number; durationMs?: number; completedAt?: number; error?: string }

  id: string
  label: string
  role: FleetRole
  status: FleetStatus
  publicIp: string
  privateIp: string
  region: string
  type: string
  cpu: number // 0..1
  memUsed: number
  memTotal: number
  load1: number
  processes: FleetProcess[]
  deletable: boolean
  issues?: FleetIssue[]
}

export interface FleetLink {
  configured?: boolean

  id: string
  source: string
  target: string
  protocol: FleetProtocol
  port: number
  bytesPerSec: number
  bytesPerSecReverse: number
  conns: number
}

export interface Fleet {
  nodes: FleetNode[]
  links: FleetLink[]
  updatedAt: number | string
}

export interface FleetRoleInfo {
  role: FleetRole
  label: string
  description: string
  addable: boolean
}

export interface FleetLogLine {
  ts: number
  level: 'info' | 'error'
  text: string
}

// ---- Alerts (WS "alert" frames + GET /api/alerts) -------------------------
export interface FleetAlert {
  id: string
  issueId: string
  nodeId: string
  label: string
  role: string
  severity: IssueSeverity
  kind: string
  title: string
  detail: string
  state: 'raised' | 'cleared' | string
  ts: number | string
}

// ---- Codemap (/api/fleet/codemap) — files of our code per role --------------
export type SymKind = 'route' | 'function' | 'class' | 'method' | 'config' | 'query' | string
// Inventory items (what is inside a db / cache / lb node; see telemetry inventory.js)
// reuse the same shapes with kinds table | column | index | key | field | conf |
// block | upstream | location | member | directive | more, and describe themselves:
export interface ItemFacts {
  sub?: string // short text beside the label (row estimate, type, value)
  info?: [string, string][] // rows for the tooltip and the detail popup
  weight?: number // 0..1, drives the tile height
}
export interface Sym extends ItemFacts {
  id: string
  name: string
  kind: SymKind
  line: number
  endLine: number
  calls: string[] // ids of called symbols
  children?: Sym[]
  route?: { method: string; path: string }
  secret?: boolean // config holding a secret: never show a value
}
export interface RouteStat {
  method: string
  path: string
  symbolId: string
  rps: number
  errorRate: number
  p95ms: number | null
}
export interface CodemapFile extends ItemFacts {
  path: string
  label: string
  loc: number
  kind?: string // default 'file'
  symbols?: Sym[]
}
export interface CodemapEdge {
  from: string
  to: string
  kind: 'import' | string
}
export interface CodemapPort {
  dir: 'in' | 'out' | string
  port: number
  file: string
}
export interface CodemapRole {
  root: string
  files: CodemapFile[]
  edges: CodemapEdge[]
  ports: CodemapPort[]
  routes?: RouteStat[] // real per-route traffic (app role)
  inventory?: boolean // not source code: tables, keys, config
  title?: string // inventory: one-line summary of the server
  noun?: string // inventory: what the first level holds ("tables")
  hidden?: number // inventory: first-level items over the cap
  collectedAt?: string
}
export interface Codemap {
  roles: Record<string, CodemapRole>
}
