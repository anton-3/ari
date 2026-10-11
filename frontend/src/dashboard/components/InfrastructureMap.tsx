import { usePrefersReducedMotion } from '@/hooks/usePrefersReduceMotion'
import type { Topology, TopoNode } from '../types'

interface PlacedNode {
  node: TopoNode
  x: number
  y: number
}
const STATUS_COLORS: Record<string, string> = {
  healthy: 'var(--ok)',
  degraded: 'var(--warn)',
  down: 'var(--danger)',
}
const STATUS_LABELS: Record<string, string> = {
  healthy: 'healthy',
  degraded: 'strained',
  down: 'critical',
}

function tier(node: TopoNode): number {
  if (node.id === 'internet' || node.type === 'internet') return 0
  if (['firewall', 'waf', 'edge'].includes(node.type)) return 1
  if (node.type === 'lb') return 2
  if (['db', 'cache'].includes(node.type)) return 4
  return 3
}

function placeNodes(topology: Topology): PlacedNode[] {
  const columns = [16, 176, 346, 536, 746]
  return columns.flatMap((x, column) => {
    const nodes = topology.nodes.filter((node) => tier(node) === column)
    return nodes.map((node, i) => ({
      node,
      x,
      y:
        column === 3 && nodes.length === 4
          ? [184, 324, 64, 444][i]
          : column === 3 && nodes.length === 2
            ? 184 + i * 140
            : column === 4 && nodes.length === 2
              ? node.type === 'cache'
                ? 164
                : 344
              : nodes.length === 1
                ? 254
                : 64 + i * (380 / Math.max(1, nodes.length - 1)),
    }))
  })
}

export function InfrastructureMap({
  topology,
  users,
}: {
  topology: Topology | null
  users: number | undefined
}) {
  const reducedMotion = usePrefersReducedMotion()
  const displayed = topology
  const positions = displayed ? placeNodes(displayed) : []
  const lookup = new Map(
    positions.map((position) => [position.node.id, position]),
  )
  const computeCount =
    displayed?.nodes.filter((node) =>
      ['app', 'db', 'cache'].includes(node.type),
    ).length ?? 0
  const lbCount =
    displayed?.nodes.filter((node) => node.type === 'lb').length ?? 0
  const fwCount =
    displayed?.nodes.filter((node) => ['firewall', 'waf'].includes(node.type))
      .length ?? 0

  return (
    <section
      className="dash-panel infrastructure"
      id="infrastructure"
      aria-labelledby="infrastructure-title"
    >
      <div className="panel-heading">
        <h2 id="infrastructure-title">infrastructure</h2>
        <div className="health-legend">
          <span>
            <i style={{ background: 'var(--ok)' }} />
            healthy
          </span>
          <span>
            <i style={{ background: 'var(--warn)' }} />
            strained
          </span>
          <span>
            <i style={{ background: 'var(--danger)' }} />
            critical
          </span>
        </div>
      </div>
      <div className="infrastructure-canvas">
        {displayed ? (
          <svg
            viewBox="0 0 880 540"
            role="img"
            aria-label="Deployment topology with live node health and animated request and response paths"
          >
            <defs>
              <pattern
                id="dash-grid"
                width="20"
                height="20"
                patternUnits="userSpaceOnUse"
              >
                <rect width="1.5" height="1.5" fill="var(--line)" />
              </pattern>
            </defs>
            <rect
              width="880"
              height="540"
              fill="url(#dash-grid)"
              opacity="0.7"
            />
            {[
              ['internet', 70],
              ['edge', 315],
              ['compute', 590],
              ['data', 800],
            ].map(([label, x]) => (
              <text key={label} x={x} y="34" className="map-tier">
                {label}
              </text>
            ))}
            {displayed.edges.map((edge, i) => {
              const from = lookup.get(edge.from),
                to = lookup.get(edge.to)
              if (!from || !to) return null
              const startX = from.x + 108,
                startY = from.y + 26,
                endY = to.y + 26
              const mid = (startX + to.x) / 2
              const path = `M${startX} ${startY} C${mid} ${startY} ${mid} ${endY} ${to.x} ${endY}`
              const reverse = `M${to.x} ${endY + 3} C${mid} ${endY + 3} ${mid} ${startY + 3} ${startX} ${startY + 3}`
              return (
                <g key={`${edge.from}-${edge.to}`}>
                  <path d={path} className="map-edge" />
                  {!reducedMotion &&
                    from.node.status !== 'down' &&
                    to.node.status !== 'down' && (
                      <>
                        {[0, 1, 2].map((offset) => (
                          <rect
                            key={offset}
                            width="3"
                            height="3"
                            x="-1.5"
                            y="-1.5"
                            fill="var(--fg-2)"
                          >
                            <animateMotion
                              dur={`${1.3 + (i % 3) * 0.4}s`}
                              begin={`${-offset * 0.5}s`}
                              path={path}
                              repeatCount="indefinite"
                            />
                          </rect>
                        ))}
                        {[0, 1].map((offset) => (
                          <rect
                            key={offset}
                            width="3"
                            height="3"
                            x="-1.5"
                            y="-1.5"
                            fill="var(--accent)"
                          >
                            <animateMotion
                              dur={`${1.6 + (i % 3) * 0.4}s`}
                              begin={`${-offset * 0.8}s`}
                              path={reverse}
                              repeatCount="indefinite"
                            />
                          </rect>
                        ))}
                      </>
                    )}
                </g>
              )
            })}
            {positions.map(({ node, x, y }) => {
              const client = tier(node) === 0
              const color = STATUS_COLORS[node.status] || 'var(--muted)'
              const status = STATUS_LABELS[node.status] || node.status
              const label = client
                ? 'clients'
                : node.type === 'lb'
                  ? 'nodebalancer'
                  : node.type === 'firewall'
                    ? 'firewall'
                    : node.type === 'cache'
                      ? 'redis'
                      : node.type === 'db'
                        ? 'postgres'
                        : node.id.startsWith('app-')
                          ? node.id.replace('app-', 'web-')
                          : node.label
              return (
                <g key={node.id} className="map-node">
                  <title>{`${node.label} · ${client ? `${users ?? '—'} active users` : status}`}</title>
                  <rect
                    x={x}
                    y={y}
                    width="108"
                    height="52"
                    fill="var(--dash-surface)"
                  />
                  <rect
                    x={x}
                    y={y}
                    width="108"
                    height="52"
                    className={client ? 'map-client' : 'map-box'}
                    style={{ color: client ? 'var(--dim)' : color }}
                  />
                  {!client && (
                    <rect
                      x={x + 86}
                      y={y + 10}
                      width="6"
                      height="6"
                      fill={color}
                    />
                  )}
                  <text x={x + 10} y={y + 21} className="map-label">
                    {label.length > 14 ? `${label.slice(0, 13)}…` : label}
                  </text>
                  <text x={x + 10} y={y + 40} className="map-sub">
                    {client
                      ? 'live'
                      : node.type === 'app'
                        ? 'app'
                        : node.type === 'lb'
                          ? node.id
                          : node.type === 'db'
                            ? 'primary'
                            : node.type === 'cache'
                              ? 'cache'
                              : 'cloud fw'}
                  </text>
                  <text
                    x={x + 98}
                    y={y + 40}
                    className="map-value"
                    fill={client ? 'var(--fg-2)' : color}
                  >
                    {client
                      ? users === undefined
                        ? '—'
                        : new Intl.NumberFormat('en', {
                            notation: 'compact',
                            maximumFractionDigits: 1,
                          }).format(users)
                      : status}
                  </text>
                </g>
              )
            })}
          </svg>
        ) : (
          <div className="panel-empty">
            waiting for infrastructure telemetry…
          </div>
        )}
      </div>
      <footer className="infrastructure-footer">
        <span>
          {displayed
            ? `${computeCount} nodes · ${lbCount} nodebalancer${lbCount === 1 ? '' : 's'} · ${fwCount} firewall${fwCount === 1 ? '' : 's'}`
            : 'connecting to telemetry'}
        </span>
        <div className="packet-legend">
          <span>
            <i />
            request
          </span>
          <span>
            <i />
            response
          </span>
        </div>
      </footer>
    </section>
  )
}
