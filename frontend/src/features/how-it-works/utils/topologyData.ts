import type { EdgeId, NodeId, Phase, TopologyEdge, TopologyNode } from '@/features/how-it-works/types/topology'

export const VIEW = { width: 640, height: 380 }

// Radius of a node's ring; edges run from ring edge to ring edge.
export const NODE_RADIUS = 30

export const STEPS_PER_PHASE = 3

// Each thought finishes typing this far through its scroll step.
export const TYPING_SHARE = 0.6

export const NODES: Record<NodeId, TopologyNode> = {
  traffic: {
    id: 'traffic',
    label: 'Traffic',
    x: 84,
    y: 200,
    kind: 'endpoint',
    stats: ['4.1k req/s', 'edge: 2 load balancers'],
  },
  api: {
    id: 'api',
    label: 'API',
    x: 262,
    y: 104,
    kind: 'service',
    stats: ['1.2k req/s', '10 pods', '2 clusters', 'image api:2026.10.08'],
  },
  auth: {
    id: 'auth',
    label: 'Auth',
    x: 262,
    y: 300,
    kind: 'service',
    stats: ['640 sign-ins/min', '4 pods', 'MFA enforced'],
  },
  storage: {
    id: 'storage',
    label: 'Storage',
    x: 462,
    y: 34,
    kind: 'endpoint',
    stats: ['3 buckets', 'versioning on'],
  },
  database: {
    id: 'database',
    label: 'Database',
    x: 452,
    y: 224,
    kind: 'endpoint',
    stats: ['Postgres 16', '38 MB/hr egress', 'read replicas: 2'],
  },
  egress: {
    id: 'egress',
    label: '203.0.113.47',
    x: 578,
    y: 146,
    kind: 'external',
    stats: ['unknown host', 'first seen 03:12'],
  },
}

// Traffic flows from the first node to the second.
export const EDGES: TopologyEdge[] = [
  { id: 'traffic-api', from: 'traffic', to: 'api' },
  { id: 'traffic-auth', from: 'traffic', to: 'auth' },
  { id: 'api-database', from: 'api', to: 'database' },
  { id: 'auth-database', from: 'auth', to: 'database' },
  { id: 'api-storage', from: 'api', to: 'storage' },
  { id: 'api-egress', from: 'api', to: 'egress' },
]

export const NODE_IDS = Object.keys(NODES) as NodeId[]
export const EDGE_IDS = EDGES.map((edge) => edge.id) satisfies EdgeId[]

export const PHASES: Phase[] = [
  {
    number: '01',
    name: 'Connect',
    copy: 'Read-only access to code, cloud, identity, and runtime. Ari maps your infrastructure in an afternoon.',
  },
  {
    number: '02',
    name: 'Hunt',
    copy: 'It writes scans for your exact stack, runs them around the clock, and follows every lead.',
  },
  {
    number: '03',
    name: 'Prove',
    copy: "Every finding is replayed in a sandbox. If it can't be exploited, it doesn't page anyone.",
  },
  {
    number: '04',
    name: 'Respond',
    copy: 'Containment runs on your policy. Anything destructive waits for a human, and Ari will phone you for it.',
  },
  {
    number: '05',
    name: 'Learn',
    copy: 'Each incident ends with a fix, a regression test, and a new detection rule.',
  },
]
