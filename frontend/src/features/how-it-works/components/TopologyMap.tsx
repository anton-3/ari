import { useState } from 'react'
import { usePrefersReducedMotion } from '@/hooks/usePrefersReduceMotion'
import { CallPill } from '@/features/how-it-works/components/CallPill'
import { TopologyTooltip } from '@/features/how-it-works/components/TopologyTooltip'
import { edgeSegment } from '@/features/how-it-works/utils/geometry'
import {
  EDGES,
  NODE_IDS,
  NODE_RADIUS,
  NODES,
  VIEW,
} from '@/features/how-it-works/utils/topologyData'
import type { EdgeState, NodeId, Scene } from '@/features/how-it-works/types/topology'

type TopologyMapProps = {
  scene: Scene
}

// Moving packets per edge state: how many, seconds per trip, and dot size.
const PACKETS: Partial<Record<EdgeState, { count: number; duration: number; radius: number }>> = {
  ok: { count: 2, duration: 2.8, radius: 4 },
  risk: { count: 2, duration: 2.2, radius: 4 },
  attack: { count: 4, duration: 0.9, radius: 4.5 },
}

const BRACKETS = 'M-46 -30v-16h16 M30 -46h16v16 M46 30v16h-16 M-30 46h-16v-16'

export function TopologyMap({ scene }: TopologyMapProps) {
  const reducedMotion = usePrefersReducedMotion()
  const [active, setActive] = useState<NodeId | null>(null)
  // The reticle fades out when nothing is focused, but stays where it was.
  const [reticleAt, setReticleAt] = useState<NodeId>(scene.focus ?? 'traffic')
  if (scene.focus && scene.focus !== reticleAt) setReticleAt(scene.focus)

  const tooltipNode = active && scene.nodes[active].state !== 'hidden' ? NODES[active] : null
  const reticle = NODES[reticleAt]

  return (
    <div className="topo">
      <svg
        className="topo__svg"
        viewBox={`0 0 ${VIEW.width} ${VIEW.height}`}
        role="img"
        aria-label="Infrastructure map of five services: Traffic, API, Auth, Storage and Database."
      >
        {EDGES.map((edge) => {
          const state = scene.edges[edge.id]
          const seg = edgeSegment(edge)
          const packets = PACKETS[state]
          const path = `M${seg.x1} ${seg.y1}L${seg.x2} ${seg.y2}`

          return (
            <g key={edge.id} className={`edge edge--${state}`}>
              <line className="edge__line" x1={seg.x1} y1={seg.y1} x2={seg.x2} y2={seg.y2} />
              {packets &&
                (reducedMotion ? (
                  <circle className="edge__packet" cx={seg.mx} cy={seg.my} r={packets.radius} />
                ) : (
                  Array.from({ length: packets.count }, (_, i) => (
                    <circle key={i} className="edge__packet" r={packets.radius}>
                      <animateMotion
                        path={path}
                        dur={`${packets.duration}s`}
                        begin={`${-packets.duration * (i / packets.count + 0.25)}s`}
                        repeatCount="indefinite"
                      />
                    </circle>
                  ))
                ))}
              {edge.id === 'api-egress' && state === 'cut' && (
                <path
                  className="edge__cross"
                  d="M-7 -7L7 7M7 -7L-7 7"
                  transform={`translate(${seg.mx} ${seg.my})`}
                />
              )}
            </g>
          )
        })}

        <g
          className={`reticle${scene.focus ? '' : ' reticle--off'}`}
          style={{ transform: `translate(${reticle.x}px, ${reticle.y}px)` }}
          aria-hidden="true"
        >
          <path d={BRACKETS} />
        </g>

        {NODE_IDS.map((id) => {
          const node = NODES[id]
          const { state, sub } = scene.nodes[id]
          const hidden = state === 'hidden'

          return (
            <g
              key={id}
              className={`node node--${node.kind} node--${state}`}
              transform={`translate(${node.x} ${node.y})`}
              tabIndex={hidden ? undefined : 0}
              aria-hidden={hidden || undefined}
              aria-label={`${node.label}. ${node.stats.join(', ')}`}
              onPointerEnter={() => setActive(id)}
              onPointerLeave={() => setActive(null)}
              onFocus={() => setActive(id)}
              onBlur={() => setActive(null)}
            >
              <circle className="node__halo" r={NODE_RADIUS + 10} />
              <circle className="node__ring" r={NODE_RADIUS} />
              <circle className="node__core" r="8" />
              <text className="node__label" y={NODE_RADIUS + 26}>
                {node.label}
              </text>
              {sub && (
                <text className="node__sub" y={NODE_RADIUS + 44}>
                  {sub}
                </text>
              )}
            </g>
          )
        })}
      </svg>
      <TopologyTooltip node={tooltipNode} />
      <CallPill call={scene.call} />
    </div>
  )
}
