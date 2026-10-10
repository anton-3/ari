import { NODE_RADIUS, NODES } from '@/features/how-it-works/utils/topologyData'
import type { TopologyEdge } from '@/features/how-it-works/types/topology'

export type Segment = {
  x1: number
  y1: number
  x2: number
  y2: number
  // Midpoint, used for the static packet and the cut marker.
  mx: number
  my: number
}

// A straight line between two node rings, so lines never overlap a ring.
export function edgeSegment({ from, to }: TopologyEdge, radius = NODE_RADIUS): Segment {
  const a = NODES[from]
  const b = NODES[to]
  const dx = b.x - a.x
  const dy = b.y - a.y
  const length = Math.hypot(dx, dy)
  const ux = dx / length
  const uy = dy / length

  const x1 = a.x + ux * radius
  const y1 = a.y + uy * radius
  const x2 = b.x - ux * radius
  const y2 = b.y - uy * radius
  return { x1, y1, x2, y2, mx: (x1 + x2) / 2, my: (y1 + y2) / 2 }
}
