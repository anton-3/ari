export type NodeId = 'traffic' | 'api' | 'auth' | 'storage' | 'database' | 'egress'

export type EdgeId =
  | 'traffic-api'
  | 'traffic-auth'
  | 'api-database'
  | 'auth-database'
  | 'api-storage'
  | 'api-egress'

export type NodeKind = 'endpoint' | 'service' | 'external'

export type NodeState = 'ok' | 'warn' | 'hot' | 'isolated' | 'blocked' | 'hidden'

export type EdgeState = 'ok' | 'risk' | 'attack' | 'cut' | 'hidden'

// Status chip color: steel is neutral, ok is healthy, warn is a lead, hot is an attack.
export type Tone = 'steel' | 'ok' | 'warn' | 'hot'

export type CallState = 'none' | 'ringing' | 'approved'

export type TopologyNode = {
  id: NodeId
  label: string
  x: number
  y: number
  kind: NodeKind
  stats: string[]
}

export type TopologyEdge = {
  id: EdgeId
  from: NodeId
  to: NodeId
}

export type NodeScene = {
  state: NodeState
  sub?: string
}

export type Scene = {
  nodes: Record<NodeId, NodeScene>
  edges: Record<EdgeId, EdgeState>
  focus: NodeId | null
  status: { label: string; tone: Tone }
  call: CallState
  thought: string
  summary: string
}

export type Phase = {
  number: string
  name: string
  copy: string
}
