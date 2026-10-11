import type { Metrics } from '../types'

const compact = (value: number) =>
  new Intl.NumberFormat('en', {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value)

export function UsersPanel({ metrics }: { metrics: Metrics | null }) {
  const now = metrics?.ts ?? 0
  const series = (metrics?.series ?? []).filter(
    (point) => point.t >= now - 180000,
  )
  const values = series.map((point) => point.activeUsers)
  const first = values[0]
  const last = metrics?.activeUsers
  const seconds =
    series.length > 1
      ? Math.round((series[series.length - 1].t - series[0].t) / 1000)
      : 0
  const duration =
    seconds >= 175
      ? '3 min'
      : seconds >= 60
        ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
        : `${seconds}s`
  const delta =
    first && last !== undefined ? Math.round((last / first - 1) * 100) : null
  const min = Math.max(0, Math.min(...values, last ?? 0) * 0.8)
  const max = Math.max(min + 100, Math.max(...values, last ?? 0) * 1.15)
  const points = series.map((point) => ({
    x: 400 * (1 - (now - point.t) / 180000),
    y: 140 * (1 - (point.activeUsers - min) / (max - min)),
  }))
  const path = points
    .map(
      (point, i) =>
        `${i ? 'L' : 'M'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`,
    )
    .join(' ')
  const area = points.length
    ? `${path} L${points[points.length - 1].x.toFixed(1)} 140 L${points[0].x.toFixed(1)} 140 Z`
    : ''

  return (
    <section className="dash-panel users-panel" aria-labelledby="users-title">
      <div className="panel-heading">
        <h2 id="users-title">live users</h2>
        <span>last 3 min</span>
      </div>
      <div className="users-value">
        <strong>
          {last === undefined ? '—' : Math.round(last).toLocaleString('en-US')}
        </strong>
        <span>
          {delta !== null && seconds > 0
            ? `${delta >= 0 ? '+' : ''}${delta}% in ${duration}`
            : 'collecting history'}
        </span>
      </div>
      <div
        className="users-chart"
        role="img"
        aria-label={
          last === undefined
            ? 'Waiting for active user data'
            : `Active users over the last three minutes, currently ${last}`
        }
      >
        <div className="users-plot">
          <svg
            viewBox="0 0 400 140"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path
              d="M0 28 L400 28 M0 84 L400 84 M0 140 L400 140"
              className="chart-grid"
            />
            <path d={area} className="chart-area" />
            <path d={path} className="chart-line" />
          </svg>
          {points.length > 0 && (
            <i
              className="chart-dot"
              style={{ top: `${points[points.length - 1].y / 1.4}%` }}
            />
          )}
          {[0.2, 0.6, 1].map((fraction) => (
            <span
              className="chart-tick"
              key={fraction}
              style={{ top: `${fraction * 100}%` }}
            >
              {compact(Math.round(max - (max - min) * fraction))}
            </span>
          ))}
        </div>
        <div className="chart-times">
          <span>3m ago</span>
          <span>2m</span>
          <span>1m</span>
          <span>now</span>
        </div>
      </div>
    </section>
  )
}
