import { LOSSES } from '@/features/losses-chart/utils/ic3Losses'

// The first 90% of the scroll track fills the bars; the last 10% holds the finished chart.
const FILL_SHARE = 0.9

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

export function easeOutCubic(t: number) {
  return 1 - (1 - t) ** 3
}

// Scroll progress (0 to 1) -> one fill (0 to 1) per bar. Each bar rises during its own
// share of the scroll, and the next one starts as it lands.
export function fills(progress: number) {
  const t = Math.min(progress / FILL_SHARE, 1) * LOSSES.length
  return LOSSES.map((_, i) => easeOutCubic(clamp(t - i, 0, 1)))
}
