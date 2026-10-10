import type { CSSProperties } from 'react'
import type { Metrics, SeriesPoint } from '../types'
import { fmtNum, sparkPath } from '../helpers'

interface TileProps {
  label: string
  value: string
  unit?: string
  accent: string
  spark: number[]
  foot?: string
}

function Spark({ values, accent }: { values: number[]; accent: string }) {
  const w = 120
  const h = 28
  const d = sparkPath(values, w, h)
  const area = d ? `${d} L${w - 2},${h - 2} L2,${h - 2} Z` : ''
  const gid = `spark-${accent.replace('#', '')}`
  return (
    <svg className="ari__spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={accent} stopOpacity="0.35" />
          <stop offset="100%" stopColor={accent} stopOpacity="0" />
        </linearGradient>
      </defs>
      {area && <path d={area} fill={`url(#${gid})`} />}
      <path d={d} fill="none" stroke={accent} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

function Tile({ label, value, unit, accent, spark, foot }: TileProps) {
  return (
    <div className="ari__tile" style={{ '--tile-accent': accent } as CSSProperties}>
      <div className="ari__tile-label">{label}</div>
      <div className="ari__tile-value ari__mono">
        {value}
        {unit && <span className="ari__tile-unit">{unit}</span>}
      </div>
      <Spark values={spark} accent={accent} />
      {foot && <div className="ari__tile-foot">{foot}</div>}
    </div>
  )
}

export function StatTiles({ metrics }: { metrics: Metrics | null }) {
  const series: SeriesPoint[] = metrics?.series ?? []
  const tail = series.slice(-40)
  const errPct = metrics ? metrics.errorRate : 0
  const errAccent = errPct >= 3 ? '#d03b3b' : errPct >= 1.5 ? '#fab219' : '#0ca30c'

  return (
    <div className="ari__tiles">
      <Tile
        label="Active Users"
        value={metrics ? fmtNum(metrics.activeUsers) : '—'}
        accent="#199e70"
        spark={tail.map((p) => p.activeUsers)}
        foot="concurrent sessions"
      />
      <Tile
        label="Error Rate"
        value={metrics ? errPct.toFixed(2) : '—'}
        unit="%"
        accent={errAccent}
        spark={tail.map((p) => p.errorRate)}
        foot={errPct >= 3 ? 'elevated' : errPct >= 1.5 ? 'watch' : 'nominal'}
      />
      <Tile
        label="Latency p50"
        value={metrics ? `${metrics.latencyMs}` : '—'}
        unit="ms"
        accent="#d95926"
        spark={tail.map((p) => p.latencyMs)}
        foot="edge → app"
      />
      <Tile
        label="Bandwidth"
        value={metrics ? metrics.bandwidthMbps.toFixed(0) : '—'}
        unit="Mbps"
        accent="#3987e5"
        spark={tail.map((p) => p.rps)}
        foot="aggregate egress"
      />
    </div>
  )
}
