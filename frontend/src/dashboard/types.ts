// Shapes mirror the telemetry service API exactly.

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
  bandwidthMbps: number
  series: SeriesPoint[]
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'critical' | string

export interface LogEntry {
  ts: number
  level: LogLevel
  source: string
  ip: string
  method: string
  path: string
  status: number
  msg: string
}

export interface LogsResponse {
  logs: LogEntry[]
}

export type NodeStatus = 'healthy' | 'degraded' | 'down' | string
export type NodeType =
  'internet' | 'edge' | 'waf' | 'lb' | 'app' | 'db' | 'cache' | string

export interface TopoNode {
  id: string
  label: string
  type: NodeType
  status: NodeStatus
}

export interface TopoEdge {
  from: string
  to: string
}

export interface Topology {
  nodes: TopoNode[]
  edges: TopoEdge[]
}

export type Severity = 'critical' | 'high' | 'medium' | 'low' | string
export type VulnStatus = 'discovered' | 'investigating' | 'remediated' | string

export interface Vuln {
  id: string
  severity: Severity
  title: string
  project: string
  endpoint: string
  status: VulnStatus
  discoveredAt: number
}

export interface VulnsResponse {
  vulns: Vuln[]
}

// WebSocket envelope.
export type WsMessage =
  { type: 'metrics'; data: Metrics } | { type: 'log'; data: LogEntry }

// Connection state surfaced to the UI.
export type FeedSource = 'live' | 'polling' | 'mock' | 'connecting' | 'offline'
