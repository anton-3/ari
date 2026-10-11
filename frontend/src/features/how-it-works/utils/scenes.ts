import { EDGE_IDS, NODE_IDS, STEPS_PER_PHASE } from '@/features/how-it-works/utils/topologyData'
import type {
  CallState,
  EdgeId,
  EdgeState,
  NodeId,
  NodeScene,
  Scene,
  Tone,
} from '@/features/how-it-works/types/topology'

type Patch = {
  nodes?: Partial<Record<NodeId, NodeScene>>
  edges?: Partial<Record<EdgeId, EdgeState>>
  focus: NodeId | null
  status: [label: string, tone: Tone]
  call?: CallState
  thought: string
  summary: string
}

// Every scene starts from: all nodes ok, all edges ok, egress and its edge hidden.
function scene({ nodes, edges, focus, status, call = 'none', thought, summary }: Patch): Scene {
  const base = {
    nodes: Object.fromEntries(NODE_IDS.map((id) => [id, { state: 'ok' }])) as Scene['nodes'],
    edges: Object.fromEntries(EDGE_IDS.map((id) => [id, 'ok'])) as Scene['edges'],
  }
  base.nodes.egress = { state: 'hidden' }
  base.edges['api-egress'] = 'hidden'

  return {
    nodes: { ...base.nodes, ...nodes },
    edges: { ...base.edges, ...edges },
    focus,
    status: { label: status[0], tone: status[1] },
    call,
    thought,
    summary,
  }
}

const MONITORING = 'Monitoring 5 connected components'
const LEAD = '1 lead out of 1,204 candidates'
const INCIDENT = 'Live exfiltration · 1 service affected'
const CONTAINED = 'Contained 3m 33s after the first bad byte'

// Prove steps 2 and 3, reused by Respond.
const exfiltrating: Pick<Patch, 'nodes' | 'edges'> = {
  nodes: {
    api: { state: 'hot', sub: 'RCE confirmed' },
    egress: { state: 'hot', sub: '2.3 GB out' },
  },
  edges: { 'api-egress': 'attack' },
}
const blastRadius: Pick<Patch, 'nodes' | 'edges'> = {
  nodes: exfiltrating.nodes,
  edges: { ...exfiltrating.edges, 'api-database': 'risk', 'api-storage': 'risk' },
}
const contained: Pick<Patch, 'nodes' | 'edges'> = {
  nodes: {
    api: { state: 'isolated', sub: 'isolated · token revoked' },
    egress: { state: 'hot', sub: '2.3 GB out' },
  },
  edges: {
    'traffic-api': 'cut',
    'api-database': 'cut',
    'api-storage': 'cut',
    'api-egress': 'cut',
  },
}

// One scene per reasoning step: phase-major, STEPS_PER_PHASE steps each.
const SCENES: Scene[] = [
  // Connect
  scene({
    nodes: {
      auth: { state: 'hidden' },
      database: { state: 'hidden' },
      storage: { state: 'hidden' },
    },
    edges: {
      'traffic-auth': 'hidden',
      'api-database': 'hidden',
      'auth-database': 'hidden',
      'api-storage': 'hidden',
    },
    focus: 'traffic',
    status: ['CONNECTING', 'steel'],
    thought: 'Reading the cloud control plane',
    summary: 'Mapping your infrastructure',
  }),
  scene({
    focus: 'auth',
    status: ['CONNECTING', 'steel'],
    thought: 'Found 5 services and 5 connections in VPC flow logs',
    summary: MONITORING,
  }),
  scene({
    focus: 'database',
    status: ['CONNECTING', 'steel'],
    thought: 'Baseline learned: api → database at 1.2k req/s',
    summary: MONITORING,
  }),

  // Hunt
  scene({
    focus: 'auth',
    status: ['HUNTING', 'warn'],
    thought: 'Scanning auth: 96 dependencies, nothing reachable',
    summary: LEAD,
  }),
  scene({
    nodes: { api: { state: 'warn', sub: 'resize-kit 2.1.4' } },
    focus: 'api',
    status: ['HUNTING', 'warn'],
    thought: 'Scanning api: resize-kit 2.1.4 has a known RCE',
    summary: LEAD,
  }),
  scene({
    nodes: { api: { state: 'warn', sub: 'resize-kit 2.1.4' } },
    edges: { 'traffic-api': 'risk' },
    focus: 'traffic',
    status: ['HUNTING', 'warn'],
    thought: 'Traffic reaches api from the internet. Worth proving.',
    summary: LEAD,
  }),

  // Prove
  scene({
    nodes: { api: { state: 'warn', sub: 'sandbox replay…' } },
    edges: { 'traffic-api': 'risk' },
    focus: 'api',
    status: ['SEV-1', 'hot'],
    thought: 'Replaying the exploit against a sandbox copy of api',
    summary: INCIDENT,
  }),
  scene({
    ...exfiltrating,
    focus: 'egress',
    status: ['SEV-1', 'hot'],
    thought: 'RCE confirmed. api is sending 2.3 GB to 203.0.113.47',
    summary: INCIDENT,
  }),
  scene({
    ...blastRadius,
    focus: 'database',
    status: ['SEV-1', 'hot'],
    thought: 'Blast radius: database and storage are reachable from api',
    summary: INCIDENT,
  }),

  // Respond
  scene({
    ...blastRadius,
    focus: 'api',
    status: ['ON CALL', 'hot'],
    call: 'ringing',
    thought: 'Calling Thomas Waller, primary on-call',
    summary: 'Waiting for a human yes',
  }),
  scene({
    ...contained,
    focus: 'api',
    status: ['CONTAINED', 'ok'],
    call: 'approved',
    thought: 'Approved by voice. Isolating api, revoking its token',
    summary: CONTAINED,
  }),
  scene({
    nodes: { ...contained.nodes, egress: { state: 'blocked', sub: 'blocked at edge' } },
    edges: contained.edges,
    focus: 'egress',
    status: ['CONTAINED', 'ok'],
    call: 'approved',
    thought: 'Egress to 203.0.113.47 blocked at the edge',
    summary: CONTAINED,
  }),

  // Learn
  scene({
    nodes: { api: { state: 'ok', sub: 'resize-kit 2.1.6' } },
    focus: 'api',
    status: ['MONITORING', 'ok'],
    thought: 'Fix PR #4821 merged: resize-kit 2.1.6, tests pass',
    summary: MONITORING,
  }),
  scene({
    nodes: {
      api: { state: 'ok', sub: 'resize-kit 2.1.6' },
      traffic: { state: 'ok', sub: 'rule: egress-burst' },
    },
    focus: 'traffic',
    status: ['MONITORING', 'ok'],
    thought: 'New detection rule for egress bursts from any service',
    summary: MONITORING,
  }),
  scene({
    nodes: { api: { state: 'ok', sub: 'resize-kit 2.1.6' } },
    focus: null,
    status: ['MONITORING', 'ok'],
    thought: 'Baseline stable · no anomalies detected',
    summary: MONITORING,
  }),
]

// phase: 0 to 4 (Connect to Learn). step: 0 to 2. Out-of-range values are clamped.
export function sceneFor(phase: number, step: number): Scene {
  const p = Math.min(Math.max(phase, 0), SCENES.length / STEPS_PER_PHASE - 1)
  const s = Math.min(Math.max(step, 0), STEPS_PER_PHASE - 1)
  return SCENES[p * STEPS_PER_PHASE + s]
}
