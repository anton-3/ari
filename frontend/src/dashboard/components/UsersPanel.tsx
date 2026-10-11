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
  const values = series.map((point) => (point.requestsPerMinute ?? 0))
  const last = metrics?.stale ? undefined : metrics?.requestsLast180s ?? undefined
  const rate = metrics?.requestsPerMinute ?? 0
  const min = 0
  const max = Math.max(60, Math.max(...values, rate) * 1.15)
  const points = series.map((point) => ({
    x: 400 * (1 - (now - point.t) / 180000),
    y: 140 * (1 - ((point.requestsPerMinute ?? 0) - min) / (max - min)),
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
    <section className={`dash-panel users-panel${metrics?.mode === 'surge' ? ' is-surge' : ''}`} aria-labelledby="users-title">
      <div className="panel-heading">
        <h2 id="users-title">requests</h2>
        <span>last 3 min</span>
      </div>
      <div className="users-value">
        <strong>
          {last === undefined ? '—' : Math.round(last).toLocaleString('en-US')}
        </strong>
        <span>
          {metrics?.stale ? 'measurement unavailable' : `${Math.round(rate).toLocaleString('en-US')} req/min now`}
        </span>
      </div>
      <div
        className="users-chart"
        title="Rate from the last 5 seconds, expressed as requests per minute"
        role="img"
        aria-label={
          last === undefined
            ? 'Waiting for observed requests'
            : `Request rate over the last three minutes; ${last} total requests, ${Math.round(rate)} requests per minute now`
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
