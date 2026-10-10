import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { Metrics } from '../types'
import { fmtTime } from '../helpers'

interface TooltipEntry {
  name?: string
  value?: number | string
  color?: string
  dataKey?: string | number
}

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean
  payload?: TooltipEntry[]
  label?: number
}) {
  if (!active || !payload || payload.length === 0) return null
  return (
    <div className="ari__tooltip ari__mono">
      <div className="ari__tooltip-t">{typeof label === 'number' ? fmtTime(label) : ''}</div>
      {payload.map((p) => (
        <div className="ari__tooltip-row" key={String(p.dataKey)}>
          <span className="ari__swatch" style={{ background: p.color }} />
          <span className="ari__tooltip-key">{p.name}</span>
          <span className="ari__tooltip-val">
            {p.dataKey === 'errorRate'
              ? `${Number(p.value).toFixed(2)}%`
              : p.dataKey === 'latencyMs'
                ? `${Math.round(Number(p.value))} ms`
                : Math.round(Number(p.value))}
          </span>
        </div>
      ))}
    </div>
  )
}

export function TrafficPanel({ metrics }: { metrics: Metrics | null }) {
  const data = metrics?.series ?? []
  const peak = data.reduce((m, p) => Math.max(m, p.rps), 0)

  return (
    <section className="ari__panel ari__traffic" aria-label="Live traffic">
      <div className="ari__panel-head">
        <h2 className="ari__panel-title">Live Traffic</h2>
        <span className="ari__panel-sub ari__mono">
          {metrics ? `${Math.round(metrics.rps)} req/s` : '—'} · peak {Math.round(peak)} · last 5 min
        </span>
      </div>
      <div style={{ width: '100%', height: 300 }}>
        <ResponsiveContainer>
          <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
            <defs>
              <linearGradient id="ari-rps-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#3987e5" stopOpacity="0.45" />
                <stop offset="100%" stopColor="#3987e5" stopOpacity="0.02" />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="#24262b" vertical={false} />
            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={['dataMin', 'dataMax']}
              tickFormatter={(v: number) => fmtTime(v)}
              tick={{ fill: '#8b8f98', fontSize: 11 }}
              stroke="#383835"
              minTickGap={60}
            />
            <YAxis
              yAxisId="rps"
              tick={{ fill: '#8b8f98', fontSize: 11 }}
              stroke="#383835"
              width={44}
            />
            <Tooltip
              content={<ChartTooltip />}
              cursor={{ stroke: '#8b8f98', strokeDasharray: '3 3' }}
            />
            <Area
              yAxisId="rps"
              type="monotone"
              dataKey="rps"
              name="Requests/s"
              stroke="#3987e5"
              strokeWidth={2}
              fill="url(#ari-rps-fill)"
              isAnimationActive={false}
              dot={false}
            />
            <Line
              yAxisId="rps"
              type="monotone"
              dataKey="activeUsers"
              name="Active users"
              stroke="#199e70"
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
              opacity={0.55}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="ari__topo-legend" aria-hidden="true">
        <span><i className="ari__swatch" style={{ background: '#3987e5' }} /> Requests/s</span>
        <span><i className="ari__swatch" style={{ background: '#199e70' }} /> Active users</span>
      </div>
    </section>
  )
}
