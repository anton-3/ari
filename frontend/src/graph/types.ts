// Shapes mirror the telemetry service API contract for the graph page.

// ---- Metrics (shared with /api/metrics) -----------------------------------
export interface SeriesPoint {
  t: number
  rps: number
  errorRate: number
  latencyMs: number
  activeUsers: number
}

export interface Metrics {
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
}

export interface AgentEvent {
  ts: number
  agentId: string
  kind: 'finding' | 'spawn' | 'recall' | 'complete' | string
  text: string
  nodeId?: string
  severity?: 'critical' | 'high' | 'medium' | 'low' | string
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
