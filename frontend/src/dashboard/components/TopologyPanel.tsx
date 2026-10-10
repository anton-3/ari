import type { NodeStatus, TopoNode, Topology } from '../types'

const VB_W = 680
const VB_H = 340
const NODE_W = 104
const NODE_H = 46
const COLS = [62, 206, 340, 478, 612]

const STATUS_COLOR: Record<string, string> = {
  healthy: '#0ca30c',
  degraded: '#fab219',
  down: '#d03b3b',
}

function layerOf(type: string): number {
  switch (type) {
    case 'internet':
      return 0
    case 'edge':
    case 'waf':
      return 1
    case 'lb':
      return 2
    case 'app':
      return 3
    case 'db':
    case 'cache':
      return 4
    default:
      return 3
  }
}

interface Placed extends TopoNode {
  cx: number
  cy: number
}

function place(nodes: TopoNode[]): Map<string, Placed> {
  const byLayer = new Map<number, TopoNode[]>()
  for (const n of nodes) {
    const l = layerOf(n.type)
    const arr = byLayer.get(l) ?? []
    arr.push(n)
    byLayer.set(l, arr)
  }
  const out = new Map<string, Placed>()
  for (const [layer, arr] of byLayer) {
    const gap = 74
    const totalH = (arr.length - 1) * gap
    const startY = VB_H / 2 - totalH / 2
    arr.forEach((n, i) => {
      out.set(n.id, { ...n, cx: COLS[Math.min(layer, COLS.length - 1)], cy: startY + i * gap })
    })
  }
  return out
}

function edgePath(ax: number, ay: number, bx: number, by: number): string {
  const x1 = ax + NODE_W / 2
  const x2 = bx - NODE_W / 2
  const mx = (x1 + x2) / 2
  return `M${x1},${ay} C${mx},${ay} ${mx},${by} ${x2},${by}`
}

function statusColor(s: NodeStatus): string {
  return STATUS_COLOR[s] ?? '#8b8f98'
}

export function TopologyPanel({ topology }: { topology: Topology | null }) {
  const nodes = topology?.nodes ?? []
  const edges = topology?.edges ?? []
  const placed = place(nodes)

  const degraded = nodes.filter((n) => n.status === 'degraded').length
  const down = nodes.filter((n) => n.status === 'down').length

  return (
    <section className="ari__panel ari__topology" aria-label="Network topology">
      <div className="ari__panel-head">
        <h2 className="ari__panel-title">Network Topology</h2>
        <span className="ari__panel-sub ari__mono">
          {nodes.length} nodes · {down} down · {degraded} degraded
        </span>
      </div>

      <svg className="ari__topo-svg" viewBox={`0 0 ${VB_W} ${VB_H}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label="Infrastructure graph">
        {/* edges */}
        {edges.map((e, i) => {
          const a = placed.get(e.from)
          const b = placed.get(e.to)
          if (!a || !b) return null
          const d = edgePath(a.cx, a.cy, b.cx, b.cy)
          const healthy = a.status !== 'down' && b.status !== 'down'
          const flowColor = b.status === 'degraded' || a.status === 'degraded' ? '#fab219' : '#38bdf8'
          return (
            <g key={`e-${i}`}>
              <path className="ari__topo-edge" d={d} />
              {healthy && (
                <path
                  className="ari__topo-flow"
                  d={d}
                  stroke={flowColor}
                  style={{ animationDelay: `${(i % 5) * 0.12}s` }}
                />
              )}
            </g>
          )
        })}

        {/* nodes */}
        {[...placed.values()].map((n) => {
          const color = statusColor(n.status)
          const x = n.cx - NODE_W / 2
          const y = n.cy - NODE_H / 2
          return (
            <g className="ari__topo-node" key={n.id}>
              {n.status !== 'healthy' && (
                <circle className="ari__topo-halo" cx={n.cx} cy={n.cy} r={NODE_W / 2 + 4} fill="none" stroke={color} strokeOpacity={0.4} strokeWidth={1.5} />
              )}
              <rect
                className="ari__topo-node-body"
                x={x}
                y={y}
                width={NODE_W}
                height={NODE_H}
                fill="#161a21"
                stroke={color}
                rx={10}
              />
              <circle cx={x + 14} cy={n.cy} r={4} fill={color}>
                {n.status !== 'healthy' && (
                  <animate attributeName="opacity" values="1;0.3;1" dur="1.3s" repeatCount="indefinite" />
                )}
              </circle>
              <text x={x + 26} y={n.cy - 2} className="ari__topo-label">{n.label}</text>
              <text x={x + 26} y={n.cy + 11} className="ari__topo-type">{n.type}</text>
            </g>
          )
        })}
      </svg>

      <div className="ari__topo-legend">
        <span><i className="ari__swatch" style={{ background: '#0ca30c' }} /> Healthy</span>
        <span><i className="ari__swatch" style={{ background: '#fab219' }} /> Degraded</span>
        <span><i className="ari__swatch" style={{ background: '#d03b3b' }} /> Down</span>
      </div>
    </section>
  )
}
