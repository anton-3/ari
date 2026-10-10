import { useMemo } from 'react'
import GraphCanvas from './GraphCanvas'
import { useTelemetry } from './useTelemetry'
import './graph.css'

const SOURCE_LABEL: Record<string, string> = {
  live: 'LIVE · websocket',
  polling: 'LIVE · polling',
  mock: 'SIMULATED',
  connecting: 'connecting…',
}

export default function Graph() {
  const { repoGraph, topology, metrics, agents, events, reasoning, source } =
    useTelemetry()

  const activeAgents = useMemo(
    () => agents.filter((a) => a.status !== 'recalled' && a.status !== 'idle').length,
    [agents],
  )

  const openFindings = useMemo(
    () => events.filter((e) => e.kind === 'finding').length,
    [events],
  )

  const nodeCount = (repoGraph?.nodes.length ?? 0) + (topology?.nodes.length ?? 0)
  const rps = metrics ? Math.round(metrics.rps) : 0
  const errorRate = metrics ? metrics.errorRate.toFixed(2) : '0.00'
  const mode = metrics?.mode ?? 'normal'

  // Most recent reasoning lines, newest last; the caption animates the tail.
  const captionLines = reasoning.slice(-3)

  return (
    <div className="graph-page">
      <GraphCanvas
        repoGraph={repoGraph}
        topology={topology}
        metrics={metrics}
        agents={agents}
        events={events}
      />

      <header className="graph-topbar">
        <div className="graph-brand">
          <span className="graph-brand-dot" />
          <span className="graph-brand-name">Ari</span>
          <span className="graph-brand-sub">swarm map</span>
        </div>
        <div className={`graph-source graph-source--${source}`}>
          <span className="graph-source-dot" />
          {SOURCE_LABEL[source] ?? source}
        </div>
      </header>

      <div className="graph-hud">
        <Stat label="requests / s" value={rps.toLocaleString()} accent="cyan" />
        <Stat label="error rate" value={`${errorRate}%`} accent={Number(errorRate) > 4 ? 'red' : 'teal'} />
        <Stat label="active agents" value={String(activeAgents)} accent="violet" />
        <Stat label="findings" value={String(openFindings)} accent="amber" />
        <Stat label="graph nodes" value={String(nodeCount)} accent="teal" />
        <Stat label="mode" value={mode} accent={mode === 'surge' ? 'red' : 'teal'} />
      </div>

      <footer className="graph-caption">
        <div className="graph-caption-label">Ari · reasoning</div>
        <div className="graph-caption-stream">
          {captionLines.map((line, i) => (
            <p
              key={`${line.ts}-${i}`}
              className={`graph-caption-line ${
                i === captionLines.length - 1 ? 'is-current' : 'is-faded'
              }`}
            >
              {line.text}
            </p>
          ))}
          {captionLines.length === 0 && (
            <p className="graph-caption-line is-current">Booting swarm telemetry…</p>
          )}
        </div>
      </footer>
    </div>
  )
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string
  value: string
  accent: 'cyan' | 'teal' | 'violet' | 'amber' | 'red'
}) {
  return (
    <div className={`graph-stat graph-stat--${accent}`}>
      <div className="graph-stat-value">{value}</div>
      <div className="graph-stat-label">{label}</div>
    </div>
  )
}
