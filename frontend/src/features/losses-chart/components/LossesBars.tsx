import { formatChange, formatLong, formatShort } from '@/features/losses-chart/utils/formatLoss'
import { LOSSES } from '@/features/losses-chart/utils/ic3Losses'

// Chart geometry in viewBox units.
const WIDTH = 1000
const HEIGHT = 380
const BASELINE = 340
const BAND = WIDTH / LOSSES.length
const BAR_SHARE = 0.56
const TOP_RADIUS = 4
// The tallest bar takes 78% of the plot height; the rest is headroom for its label.
const TALLEST_SHARE = 0.78

const MAX = Math.max(...LOSSES.map((l) => l.usdBillions))
const LAST = LOSSES.length - 1

const percent = (value: number, total: number) => `${(value / total) * 100}%`

const bars = LOSSES.map((loss, i) => {
  const width = BAND * BAR_SHARE
  const x = BAND * i + (BAND - width) / 2
  const height = (loss.usdBillions / MAX) * TALLEST_SHARE * BASELINE
  const top = BASELINE - height
  // Square bottom, rounded top corners.
  const d =
    `M${x} ${BASELINE}V${top + TOP_RADIUS}` +
    `A${TOP_RADIUS} ${TOP_RADIUS} 0 0 1 ${x + TOP_RADIUS} ${top}` +
    `H${x + width - TOP_RADIUS}` +
    `A${TOP_RADIUS} ${TOP_RADIUS} 0 0 1 ${x + width} ${top + TOP_RADIUS}` +
    `V${BASELINE}Z`
  return { ...loss, d, top, centre: x + width / 2 }
})

const first = LOSSES[0]
const last = LOSSES[LAST]
const label =
  `Reported cybercrime losses by year, ${first.year} to ${last.year}, ` +
  `rising from ${formatLong(first.usdBillions)} to ${formatLong(last.usdBillions)}`

const easeLabel = (fill: number) => Math.min(1, fill * 3)

// A year lights up while its bar is filling; the last year stays lit once it is full.
const isActive = (fill: number, i: number) => fill > 0.01 && (fill < 1 || i === LAST)

interface LossesBarsProps {
  // One fill per bar, 0 (empty) to 1 (full).
  fills: readonly number[]
}

export function LossesBars({ fills }: LossesBarsProps) {
  return (
    <div className="bars">
      <svg
        className="bars__svg"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={label}
      >
        <line className="bars__baseline" x1="0" x2={WIDTH} y1={BASELINE} y2={BASELINE} />
        {bars.map((bar, i) => (
          <path
            key={bar.year}
            d={bar.d}
            className={`bars__bar${i === LAST ? ' bars__bar--latest' : ''}`}
            style={{ transform: `scaleY(${fills[i]})` }}
          >
            <title>{`${bar.year}: ${formatLong(bar.usdBillions)} in reported losses`}</title>
          </path>
        ))}
      </svg>

      {/* Labels are HTML over the SVG so their type stays at true pixel sizes at any width. */}
      <div className="bars__labels" aria-hidden="true">
        {bars.map((bar, i) => (
          <div
            key={bar.year}
            className={`bars__value${i === LAST ? ' bars__value--latest' : ''}`}
            style={{
              left: percent(bar.centre, WIDTH),
              top: percent(bar.top, HEIGHT),
              opacity: easeLabel(fills[i]),
            }}
          >
            <span>{formatShort(bar.usdBillions * fills[i])}</span>
            {i === LAST && (
              <span className="bars__change">
                {formatChange(LOSSES[i - 1].usdBillions, bar.usdBillions)} vs {LOSSES[i - 1].year}
              </span>
            )}
          </div>
        ))}
        {bars.map((bar, i) => (
          <div
            key={bar.year}
            className={`bars__year${isActive(fills[i], i) ? ' bars__year--active' : ''}`}
            style={{ left: percent(bar.centre, WIDTH), top: percent(BASELINE, HEIGHT) }}
          >
            {bar.year}
          </div>
        ))}
      </div>
    </div>
  )
}
