import { useEffect, useMemo, useRef, useState } from 'react'
import ForceGraphView from './ForceGraphView'
import { useTelemetry } from './useTelemetry'
import './graph.css'

const SOURCE_LABEL: Record<string, string> = {
  live: 'LIVE/WS',
  polling: 'LIVE/POLL',
  mock: 'SIM',
  connecting: 'LINK…',
}

function toMs(ts: number | string | undefined): number {
  if (ts === undefined) return Date.now()
  if (typeof ts === 'number') return ts
  const n = Date.parse(ts)
  return Number.isNaN(n) ? Date.now() : n
}

function hhmmss(ts: number | string | undefined): string {
  const d = new Date(toMs(ts))
  const p = (x: number) => String(x).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export default function Graph() {
  const { repoGraph, topology, metrics, agents, events, reasoning, source } =
    useTelemetry()

  const [mode, setMode] = useState<'3d' | '2d'>('3d')
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight })
  const logRef = useRef<HTMLDivElement | null>(null)

  const reduced = useMemo(
    () =>
      typeof window !== 'undefined' &&
      !!window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  )

  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [reasoning])

  const activeAgents = useMemo(
    () => agents.filter((a) => a.status !== 'recalled' && a.status !== 'idle').length,
    [agents],
  )

  const findings = useMemo(() => {
    const now = Date.now()
    const ids = new Set<string>()
    for (const e of events) {
      if (e.kind !== 'finding') continue
      if (now - toMs(e.ts) > 20000) continue
      ids.add(`${e.ts}:${e.agentId}`)
    }
    return ids.size
  }, [events])

  const nodeCount = (repoGraph?.nodes.length ?? 0) + (topology?.nodes.length ?? 0)
  const rps = metrics ? Math.round(metrics.rps) : 0
  const err = metrics ? metrics.errorRate.toFixed(2) : '0.00'
  const lat = metrics ? Math.round(metrics.latencyMs) : 0
  const surge = metrics?.mode === 'surge'

  const logLines = reasoning.slice(-8)

  return (
    <div className="gx">
      <ForceGraphView
        mode={mode}
        repoGraph={repoGraph}
        topology={topology}
        metrics={metrics}
        agents={agents}
        events={events}
        width={size.w}
        height={size.h}
        reduced={reduced}
      />

      <header className="gx-bar">
        <div className="gx-id">
          <span className="gx-id-mark" aria-hidden />
          <span className="gx-id-name">ARI</span>
          <span className="gx-id-sub">swarm map / {mode.toUpperCase()}</span>
        </div>

        <div className="gx-bar-right">
          <div className={`gx-feed gx-feed--${source}`}>
            <span className="gx-feed-dot" />
            {SOURCE_LABEL[source] ?? source}
          </div>
          <div className="gx-toggle" role="group" aria-label="view mode">
            <button
              type="button"
              className={mode === '2d' ? 'is-on' : ''}
              onClick={() => setMode('2d')}
            >
              2D
            </button>
            <button
              type="button"
              className={mode === '3d' ? 'is-on' : ''}
              onClick={() => setMode('3d')}
            >
              3D
            </button>
          </div>
        </div>
      </header>

      <section className="gx-hud" aria-label="telemetry readout">
        <Readout label="REQ/S" value={rps.toLocaleString()} />
        <Readout label="ERR" value={`${err}%`} warn={Number(err) > 4} />
        <Readout label="LAT" value={`${lat}ms`} />
        <Readout label="AGENTS" value={String(activeAgents)} />
        <Readout label="FINDINGS" value={String(findings)} warn={findings > 0} />
        <Readout label="NODES" value={String(nodeCount)} />
        <Readout label="MODE" value={surge ? 'SURGE' : 'NOMINAL'} warn={surge} />
      </section>

      <footer className="gx-log" ref={logRef} aria-label="ari reasoning log">
        {logLines.length === 0 && (
          <div className="gx-log-line">
            <span className="gx-log-ts">{hhmmss(Date.now())}</span>
            <span className="gx-log-src">ari</span>
            <span className="gx-log-msg">initializing swarm telemetry link…</span>
          </div>
        )}
        {logLines.map((line, i) => (
          <div
            className={`gx-log-line ${i === logLines.length - 1 ? 'is-head' : ''}`}
            key={`${line.ts}-${i}`}
          >
            <span className="gx-log-ts">{hhmmss(line.ts)}</span>
            <span className="gx-log-src">ari</span>
            <span className="gx-log-msg">{line.text}</span>
          </div>
        ))}
      </footer>
    </div>
  )
}

function Readout({
  label,
  value,
  warn,
}: {
  label: string
  value: string
  warn?: boolean
}) {
  return (
    <div className={`gx-read ${warn ? 'is-warn' : ''}`}>
      <span className="gx-read-k">{label}</span>
      <span className="gx-read-v">{value}</span>
    </div>
  )
}
