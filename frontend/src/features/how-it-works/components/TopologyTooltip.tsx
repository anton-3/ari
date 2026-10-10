import { VIEW } from '@/features/how-it-works/utils/topologyData'
import type { TopologyNode } from '@/features/how-it-works/types/topology'

type TopologyTooltipProps = {
  node: TopologyNode | null
}

// Positioned in percentages of the viewBox so it tracks the map as it scales.
export function TopologyTooltip({ node }: TopologyTooltipProps) {
  if (!node) return null

  return (
    <div
      className="topo-tooltip"
      role="tooltip"
      style={{ left: `${(node.x / VIEW.width) * 100}%`, top: `${((node.y - 40) / VIEW.height) * 100}%` }}
    >
      <div className="topo-tooltip__title">{node.label}</div>
      {node.stats.map((stat) => (
        <div key={stat} className="topo-tooltip__stat">
          {stat}
        </div>
      ))}
    </div>
  )
}
