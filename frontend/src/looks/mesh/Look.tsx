import { Component, useEffect, useMemo, useRef, useState } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import MeshView, { K, edgeColor, healthColor, kindOf } from './MeshView'
import type { Display, Sel, Shape, ViewApi } from './MeshView'
import { ACTIVE_AGENT, codeFor, fileIssues, fmtMem, fmtRate, isControl, issueLevel } from '../../graph/GraphView'
import { forgetPos } from '../../graph/positions'
import { toMs, useFleet } from '../../graph/useFleet'
import { useTelemetry } from '../../graph/useTelemetry'
import type { FleetIssue, FleetLink, FleetLogLine, FleetNode, Metrics } from '../../graph/types'
import './mesh.css'

export const meta = {
  title: 'Mesh',
  inspiration: 'Kiali (Istio service-mesh console) traffic graph on PatternFly, with a nod to Weave Scope',
}

const SIM = (() => {
  try {
    return new URLSearchParams(window.location.search).get('sim') === '1'
  } catch {
    return false
  }
})()

const SEV_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 }
const UNDELETABLE_ROLES = new Set(['controller', 'internet'])

function hhmmss(ts: number | string | undefined): string {
  const d = new Date(toMs(ts))
  const p = (x: number) => String(x).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
function held(since: number | string, now: number): string {
  const s = Math.max(0, Math.round((now - toMs(since)) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
}
function canDelete(n: FleetNode | undefined): boolean {
  return !!n && n.deletable && !UNDELETABLE_ROLES.has(n.role) && n.status !== 'deleting' && !n.id.startsWith('pending-')
}
const sevClass = (s: string) => ((SEV_RANK[s] ?? 0) >= 3 ? 'is-danger' : 'is-warning')

function readBool(key: string, dflt: boolean): boolean {
  try {
    const v = window.localStorage.getItem(key)
    return v === null ? dflt : v === '1'
  } catch {
    return dflt
  }
}
function writeBool(key: string, v: boolean) {
  try { window.localStorage.setItem(key, v ? '1' : '0') } catch { /* ignore */ }
}

// ---- small SVG glyphs -------------------------------------------------------
function ShapeIcon({ shape, color = '#3e8635', size = 18 }: { shape: Shape; color?: string; size?: number }) {
  const s = size
  const c = s / 2
  const r = s * 0.36
  let el: ReactNode
  if (shape === 'circle') el = <circle cx={c} cy={c} r={r} />
  else if (shape === 'square') el = <rect x={c - r * 0.9} y={c - r * 0.9} width={r * 1.8} height={r * 1.8} />
  else if (shape === 'diamond') el = <polygon points={`${c},${c - r * 1.2} ${c + r * 1.2},${c} ${c},${c + r * 1.2} ${c - r * 1.2},${c}`} />
  else if (shape === 'triangle') el = <polygon points={`${c},${c - r * 1.25} ${c + r * 1.1},${c + r * 0.8} ${c - r * 1.1},${c + r * 0.8}`} />
  else el = <rect x={c - r * 1.15} y={c - r * 0.8} width={r * 2.3} height={r * 1.6} rx={2} />
  return (
    <svg className="mx-shape" width={s} height={s} viewBox={`0 0 ${s} ${s}`} aria-hidden>
      <g fill="#fff" stroke={color} strokeWidth={1.8}>{el}</g>
    </svg>
  )
}

function StatusIcon({ level }: { level: 'ok' | 'warn' | 'danger' | 'info' }) {
  const col = level === 'ok' ? K.green : level === 'warn' ? '#f0ab00' : level === 'danger' ? K.red : K.blue
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden className="mx-sicon">
      {level === 'warn' ? (
        <>
          <polygon points="7,1 13.3,12.6 0.7,12.6" fill={col} />
          <rect x="6.25" y="5" width="1.5" height="4" fill="#151515" />
          <rect x="6.25" y="10" width="1.5" height="1.5" fill="#151515" />
        </>
      ) : (
        <>
          <circle cx="7" cy="7" r="6.5" fill={col} />
          {level === 'ok' && <polyline points="4,7.2 6.2,9.3 10,5" fill="none" stroke="#fff" strokeWidth="1.6" />}
          {level === 'danger' && <><rect x="6.25" y="3.2" width="1.5" height="4.6" fill="#fff" /><rect x="6.25" y="9" width="1.5" height="1.6" fill="#fff" /></>}
          {level === 'info' && <><rect x="6.25" y="6" width="1.5" height="4.6" fill="#fff" /><rect x="6.25" y="3.3" width="1.5" height="1.6" fill="#fff" /></>}
        </>
      )}
    </svg>
  )
}

class MeshBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ari mesh] render error', error, info.componentStack)
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="mx-empty" role="alert">
        <StatusIcon level="danger" />
        <h2 className="mx-empty-h">Graph render error</h2>
        <p className="mx-empty-p">{this.state.error.message}</p>
        <button type="button" className="mx-btn mx-btn--primary" onClick={() => this.setState({ error: null })}>Reload view</button>
      </div>
    )
  }
}

function Sparkline({ m }: { m: Metrics }) {
  const pts = m.series.slice(-60)
  if (pts.length < 2) return null
  const W = 300
  const H = 54
  const max = Math.max(1, ...pts.map((p) => p.rps))
  const xy = pts.map((p, i) => [(i / (pts.length - 1)) * W, H - 4 - (p.rps / max) * (H - 10)] as const)
  const d = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('')
  const errMax = Math.max(...pts.map((p) => p.errorRate))
  return (
    <div className="mx-spark">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-label="requests per second">
        <path d={`${d}L${W},${H}L0,${H}Z`} fill="rgba(0,102,204,0.10)" />
        <path d={d} fill="none" stroke={K.blue} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="mx-spark-axis"><span>{pts.length} samples</span><span>peak {Math.round(max)} rps · max err {errMax.toFixed(2)}%</span></div>
    </div>
  )
}

// ---------------------------------------------------------------------------
export default function Look() {
  const reduced = useMemo(
    () => typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  )
  const tel = useTelemetry(SIM)
  const surge = tel.metrics?.mode === 'surge'
  const fl = useFleet(SIM, surge)
  const live = fl.source === 'live'
  const agents = SIM ? fl.simAgents : tel.agents
  const fleet = fl.fleet

  const [selected, setSelected] = useState<Sel | null>(null)
  const [focus, setFocus] = useState<{ id: string; n: number } | null>(null)
  const [confirm, setConfirm] = useState<FleetNode | null>(null)
  const [typed, setTyped] = useState('')
  const [legendOpen, setLegendOpen] = useState(() => readBool('ari.mesh.legend', false))
  const [displayOpen, setDisplayOpen] = useState(false)
  const [display, setDisplay] = useState<Display>(() => ({
    edgeLabels: readBool('ari.mesh.edgeLabels', true),
    animation: readBool('ari.mesh.animation', true),
    showControl: readBool('ari.showControl', false),
  }))
  const [tab, setTab] = useState<'overview' | 'traffic' | 'files'>('overview')
  const [now, setNow] = useState(Date.now())
  const [jobLog, setJobLog] = useState<FleetLogLine[]>([])
  const jobSeen = useRef(new Map<string, string>())
  const logRef = useRef<HTMLDivElement | null>(null)
  const focusN = useRef(0)
  const apiRef = useRef<ViewApi | null>(null)
  const displayRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])

  useEffect(() => {
    if (!displayOpen) return
    const close = (e: MouseEvent) => {
      if (displayRef.current && !displayRef.current.contains(e.target as Node)) setDisplayOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [displayOpen])

  const setDisp = (k: keyof Display, v: boolean) => {
    setDisplay((d) => ({ ...d, [k]: v }))
    writeBool(k === 'showControl' ? 'ari.showControl' : `ari.mesh.${k}`, v)
  }

  const byId = useMemo(() => new Map((fleet?.nodes ?? []).map((n) => [n.id, n])), [fleet])

  // check jobs → log lines (real jobs on real nodes only)
  useEffect(() => {
    const add: FleetLogLine[] = []
    for (const a of agents) {
      if (live && a.simulated) continue
      const n = byId.get(a.targetNodeId)
      if (!n) continue
      const prev = jobSeen.current.get(a.id)
      if (prev === a.status) continue
      jobSeen.current.set(a.id, a.status)
      if (!prev && ACTIVE_AGENT.has(a.status)) add.push({ ts: Date.now(), level: 'info', text: `check ${a.type} → ${n.label}${a.note ? `: ${a.note}` : ''}` })
      else if (prev && (a.status === 'done' || a.status === 'idle')) add.push({ ts: Date.now(), level: 'info', text: `check ${a.type} on ${n.label} done${a.note ? ` (${a.note})` : ''}` })
    }
    if (jobSeen.current.size > 400) jobSeen.current = new Map([...jobSeen.current].slice(-200))
    if (add.length) setJobLog((p) => [...p, ...add].slice(-30))
  }, [agents, byId, live])

  // deep link: &node=<label>
  const deepLink = useRef<string | null>((() => {
    try { return new URLSearchParams(window.location.search).get('node') } catch { return null }
  })())
  useEffect(() => {
    const want = deepLink.current
    if (!want || !fleet) return
    const n = fleet.nodes.find((x) => x.label === want || x.id === want)
    if (n) {
      deepLink.current = null
      setSelected({ kind: 'node', id: n.id })
    }
  }, [fleet])

  useEffect(() => {
    if (!selected) return
    if (selected.kind === 'node' && !byId.has(selected.id)) setSelected(null)
    if (selected.kind === 'link' && !(fleet?.links ?? []).some((l) => l.id === selected.id)) setSelected(null)
  }, [byId, fleet, selected])

  const selNode = selected?.kind === 'node' ? byId.get(selected.id) : undefined
  const selLink = selected?.kind === 'link' ? fleet?.links.find((l) => l.id === selected.id) : undefined
  const selNodeId = selNode?.id
  const selFile = selected?.kind === 'node' ? selected.file : undefined
  useEffect(() => {
    setTab(selFile ? 'files' : 'overview')
  }, [selNodeId, selFile])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        if (e.key === 'Escape') setConfirm(null)
        return
      }
      if (e.key === 'Escape') {
        if (confirm) setConfirm(null)
        else if (displayOpen) setDisplayOpen(false)
        else setSelected(null)
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && !confirm && canDelete(selNode)) {
        e.preventDefault()
        setTyped('')
        setConfirm(selNode!)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirm, selNode, displayOpen])

  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  })

  // ---- HUD (all from the feed) ----------------------------------------------
  const links = fleet?.links ?? []
  const thru = links.reduce((s, l) => s + Math.max(0, l.bytesPerSec), 0)
  const counts = { run: 0, boot: 0, off: 0, del: 0 }
  for (const n of fleet?.nodes ?? []) {
    if (n.status === 'running') counts.run++
    else if (n.status === 'provisioning' || n.status === 'booting') counts.boot++
    else if (n.status === 'offline') counts.off++
    else if (n.status === 'deleting') counts.del++
  }
  const openIssues = (fleet?.nodes ?? []).reduce((s, n) => s + (n.issues?.length ?? 0), 0)
  const m = tel.metrics

  const logLines = useMemo(() => {
    const all: { ts: number; src: string; text: string; err: boolean }[] = [
      ...tel.reasoning.map((r) => ({ ts: toMs(r.ts), src: 'ari', text: r.text, err: false })),
      ...fl.log.map((l) => ({ ts: l.ts, src: 'fleet', text: l.text, err: l.level === 'error' })),
      ...jobLog.map((l) => ({ ts: l.ts, src: 'check', text: l.text, err: false })),
    ]
    return all.sort((a, b) => a.ts - b.ts).slice(-40)
  }, [tel.reasoning, fl.log, jobLog])

  const shownAlerts = fl.alerts.filter((a) => a.state === 'raised' || now - toMs(a.ts) < 8000).slice(0, 5)
  const openAlerts = fl.alerts.filter((a) => a.state === 'raised').length

  const addable = fl.roles.filter((r) => r.addable)
  const feedUp = fl.source === 'live' || fl.source === 'sim'

  const destroy = async () => {
    if (!confirm || typed !== confirm.label) return
    const node = confirm
    const ok = await fl.deleteNode(node.id, typed)
    if (ok) {
      forgetPos(node.label)
      setSelected(null)
    }
    setConfirm(null)
    setTyped('')
  }

  const sortedIssues = (n: FleetNode): FleetIssue[] =>
    (n.issues ?? []).slice().sort((a, b) => (SEV_RANK[b.severity] ?? 0) - (SEV_RANK[a.severity] ?? 0))

  const code = selNode ? codeFor(fl.codemap, selNode.role) : null
  const label = (id: string) => byId.get(id)?.label ?? id
  const errPct = m ? m.errorRate : 0

  const feedText = fl.source === 'live' ? 'Live' : fl.source === 'sim' ? 'SIM · simulated fleet' : fl.source === 'offline' ? 'No feed' : 'Connecting…'

  // summary numbers for the graph-level panel
  const kinds = { ingress: 0, workload: 0, store: 0, other: 0 }
  for (const n of fleet?.nodes ?? []) {
    const k = kindOf(n.role).kind
    if (k === 'ingress') kinds.ingress++
    else if (k === 'workload') kinds.workload++
    else if (k === 'data store') kinds.store++
    else kinds.other++
  }
  const httpLinks = links.filter((l) => l.protocol === 'http' || l.protocol === 'http-app')
  const tcpLinks = links.filter((l) => !isControl(l.protocol) && !(l.protocol === 'http' || l.protocol === 'http-app'))
  const sumRate = (ls: FleetLink[]) => ls.reduce((s, l) => s + l.bytesPerSec + l.bytesPerSecReverse, 0)

  return (
    <div className="look-mesh">
      {/* ---- PatternFly masthead ---- */}
      <header className="mx-mast">
        <div className="mx-brand">
          <span className="mx-brand-mark" aria-hidden>
            <svg width="22" height="22" viewBox="0 0 22 22"><polygon points="11,2 20,18 2,18" fill="none" stroke="#73bcf7" strokeWidth="2" /><circle cx="11" cy="13" r="3" fill="#73bcf7" /></svg>
          </span>
          <span className="mx-brand-name">Ari</span>
          <span className="mx-brand-sub">mesh console</span>
        </div>
        <div className="mx-mast-right">
          <span className={`mx-chip mx-chip--${fl.source}`}><span className="mx-chip-dot" />{feedText}</span>
          {!SIM && (
            <span className={`mx-chip mx-chip--${tel.source === 'live' || tel.source === 'polling' ? 'live' : 'offline'}`}>
              <span className="mx-chip-dot" />
              {tel.source === 'live' ? 'Metrics WS' : tel.source === 'polling' ? 'Metrics poll' : 'Metrics —'}
            </span>
          )}
        </div>
      </header>

      {/* ---- page header + toolbar ---- */}
      <section className="mx-pagehead">
        <div className="mx-title">
          <h1>Traffic Graph</h1>
          <span className="mx-title-sub">fleet · {fleet ? `${fleet.nodes.length} nodes · ${links.length} edges` : 'no data'}</span>
        </div>
        <div className="mx-toolbar">
          <div className="mx-dd" ref={displayRef}>
            <button type="button" className={`mx-dd-btn ${displayOpen ? 'is-open' : ''}`} onClick={() => setDisplayOpen((v) => !v)} aria-expanded={displayOpen}>
              Display <span className="mx-caret">▾</span>
            </button>
            {displayOpen && (
              <div className="mx-dd-menu" role="menu">
                <div className="mx-dd-group">Show edge labels</div>
                <label className="mx-check"><input type="checkbox" checked={display.edgeLabels} onChange={(e) => setDisp('edgeLabels', e.target.checked)} />Throughput (bytes/s)</label>
                <div className="mx-dd-group">Show</div>
                <label className="mx-check"><input type="checkbox" checked={display.animation} disabled={reduced} onChange={(e) => setDisp('animation', e.target.checked)} />Traffic animation{reduced ? ' (reduced motion)' : ''}</label>
                <label className="mx-check"><input type="checkbox" checked={display.showControl} onChange={(e) => setDisp('showControl', e.target.checked)} />Control links (ssh)</label>
                <div className="mx-dd-note">Control links are hidden by default; they appear for the hovered / selected node or one with a running check.</div>
              </div>
            )}
          </div>
          <div className="mx-hud" aria-label="fleet readout">
            <Readout label="Throughput" value={fmtRate(thru)} />
            <Readout label="Nodes" value={`${counts.run} run · ${counts.boot} boot · ${counts.off} off${counts.del ? ` · ${counts.del} del` : ''}`} level={counts.off > 0 ? 'danger' : undefined} />
            <Readout label="Issues" value={String(openIssues)} level={openIssues > 0 ? 'warn' : undefined} />
            {m && <Readout label="Req/s" value={Math.round(m.rps).toLocaleString()} />}
            {m && <Readout label="Err" value={`${m.errorRate.toFixed(2)}%`} level={m.errorRate > 4 ? 'danger' : undefined} />}
            <Readout label="Mode" value={m ? (surge ? 'Surge' : 'Nominal') : '—'} level={surge ? 'warn' : undefined} />
          </div>
        </div>
      </section>

      <div className="mx-body">
        {/* ---- left: add-node palette ---- */}
        <aside className="mx-side" aria-label="add node">
          <div className="mx-side-h">Add node</div>
          <div className="mx-side-sub">click, or drag onto the graph</div>
          {addable.length === 0 && <div className="mx-side-empty">{feedUp ? 'No addable roles' : 'No feed'}</div>}
          {addable.map((r) => (
            <button
              key={r.role}
              type="button"
              className="mx-role"
              draggable={feedUp}
              disabled={!feedUp}
              title={`${r.description} — click to add, or drag onto the graph`}
              onClick={() => fl.addNode(r.role)}
              onDragStart={(e) => {
                e.dataTransfer.setData('text/ari-role', r.role)
                e.dataTransfer.effectAllowed = 'copy'
              }}
            >
              <ShapeIcon shape={kindOf(r.role).shape} color="#6a6e73" />
              <span className="mx-role-l">
                <span className="mx-role-name">{r.label}</span>
                <span className="mx-role-desc">{kindOf(r.role).kind}</span>
              </span>
              <span className="mx-role-plus" aria-hidden>+</span>
            </button>
          ))}
        </aside>

        {/* ---- centre: graph card ---- */}
        <main className="mx-main">
          <div className="mx-card">
            <MeshBoundary>
              <MeshView
                fleet={fleet}
                agents={agents}
                metrics={m}
                codemap={fl.codemap}
                live={live}
                reduced={reduced}
                rightInset={24}
                leftInset={legendOpen ? 330 : 24}
                display={display}
                selected={selected}
                focus={focus}
                onSelect={setSelected}
                onDropRole={(role, x, y) => fl.addNode(role, { x, y })}
                apiRef={apiRef}
              />
            </MeshBoundary>

            {/* bottom-left graph toolbar (Kiali) */}
            <div className="mx-gtools">
              <button type="button" className="mx-gbtn" title="Zoom in" onClick={() => apiRef.current?.zoom(1.25)}>+</button>
              <button type="button" className="mx-gbtn" title="Zoom out" onClick={() => apiRef.current?.zoom(0.8)}>−</button>
              <button type="button" className="mx-gbtn" title="Fit to screen (double-click)" onClick={() => apiRef.current?.fit()}>⤢</button>
              <span className="mx-gsep" />
              <button type="button" className={`mx-gbtn mx-gbtn--txt ${legendOpen ? 'is-on' : ''}`} onClick={() => setLegendOpen((v) => { writeBool('ari.mesh.legend', !v); return !v })}>Legend</button>
              <span className="mx-ghint">drag to pin · wheel zoom · Esc collapse · Del destroys</span>
            </div>

            {legendOpen && (
              <div className="mx-legend" aria-label="legend">
                <div className="mx-legend-h">Legend<button type="button" className="mx-x" onClick={() => { setLegendOpen(false); writeBool('ari.mesh.legend', false) }} aria-label="close legend">×</button></div>
                <div className="mx-lg-sec">Node shapes</div>
                <div className="mx-lg-grid">
                  <span><ShapeIcon shape="triangle" color="#6a6e73" />lb / ingress</span>
                  <span><ShapeIcon shape="circle" color="#6a6e73" />workload</span>
                  <span><ShapeIcon shape="square" color="#6a6e73" />data store</span>
                  <span><ShapeIcon shape="diamond" color="#6a6e73" />external</span>
                  <span><ShapeIcon shape="roundrect" color="#6a6e73" />controller</span>
                </div>
                <div className="mx-lg-sec">Node health (from issues)</div>
                <div className="mx-lg-grid">
                  <span><ShapeIcon shape="circle" color={K.green} />healthy</span>
                  <span><ShapeIcon shape="circle" color={K.orange} />medium / low</span>
                  <span><ShapeIcon shape="circle" color={K.red} />critical / high</span>
                  <span><b className="mx-lg-badge">!3</b>open issues</span>
                </div>
                <div className="mx-lg-sec">Edges</div>
                <div className="mx-lg-col">
                  <span><i className="mx-lg-ln" style={{ background: K.green }} />HTTP ok (err &lt; 0.1%)</span>
                  <span><i className="mx-lg-ln" style={{ background: K.orange }} />HTTP degraded · <i className="mx-lg-ln mx-lg-ln--s" style={{ background: K.red }} />failing ≥ 20%</span>
                  <span><i className="mx-lg-ln" style={{ background: K.tcp }} />TCP (postgres, redis)</span>
                  <span><i className="mx-lg-ln" style={{ background: K.idle }} />idle (0 B/s)</span>
                  <span><i className="mx-lg-ln mx-lg-ln--dash" />ssh / control</span>
                </div>
                <div className="mx-lg-sec">Traffic animation</div>
                <div className="mx-lg-col">
                  <span><i className="mx-lg-dot" />dots = real bytes/s per direction (log)</span>
                  <span><i className="mx-lg-dia" />HTTP errors at the real error ratio</span>
                  <span><i className="mx-lg-arc" />blue arc = running check job</span>
                </div>
              </div>
            )}

            {(fl.source === 'offline' || fl.source === 'connecting') && !fleet && (
              <div className="mx-empty" role="status">
                <svg width="48" height="48" viewBox="0 0 48 48" aria-hidden>
                  <circle cx="12" cy="24" r="6" fill="none" stroke="#b8bbbe" strokeWidth="2.5" />
                  <rect x="31" y="17" width="14" height="14" fill="none" stroke="#b8bbbe" strokeWidth="2.5" />
                  <line x1="19" y1="24" x2="30" y2="24" stroke="#b8bbbe" strokeWidth="2.5" strokeDasharray="3 3" />
                </svg>
                <h2 className="mx-empty-h">{fl.source === 'offline' ? 'No feed' : 'Connecting…'}</h2>
                <p className="mx-empty-p">{fl.source === 'offline' ? 'The telemetry service at :8090 is offline.' : 'Waiting for the telemetry service at :8090.'} Nothing is drawn without real data; retrying every 2.5 s.</p>
                <button type="button" className="mx-btn mx-btn--primary" onClick={fl.retry}>Retry now</button>
                <p className="mx-empty-p mx-dim">Offline demo: open with <code>&amp;sim=1</code></p>
              </div>
            )}
          </div>

          {/* log viewer */}
          <footer className="mx-log" aria-label="log">
            <div className="mx-log-h"><span>Log</span><span className="mx-dim">Ari · fleet · check</span></div>
            <div className="mx-log-body" ref={logRef}>
              {logLines.length === 0 && (
                <div className="mx-log-line"><span className="mx-log-ts">{hhmmss(now)}</span><span className="mx-log-src">Ari</span><span className="mx-log-msg">{feedUp ? 'fleet feed linked' : 'waiting for telemetry at :8090…'}</span></div>
              )}
              {logLines.map((l, i) => (
                <div className={`mx-log-line ${l.err ? 'is-err' : ''}`} key={`${l.ts}-${i}`}>
                  <span className="mx-log-ts">{hhmmss(l.ts)}</span>
                  <span className={`mx-log-src mx-log-src--${l.src === 'ari' ? 'Ari' : l.src}`}>{l.src === 'ari' ? 'Ari' : l.src}</span>
                  <span className="mx-log-msg" title={l.text}>{l.text}</span>
                </div>
              ))}
            </div>
          </footer>
        </main>

        {/* ---- right: Kiali summary / detail panel ---- */}
        <aside className="mx-panel" aria-label="detail">
          {/* alerts: PatternFly notification list */}
          {shownAlerts.length > 0 && (
            <section className="mx-notifs" aria-label="alerts">
              <div className="mx-notifs-h"><span>Alerts</span><span className="mx-count">{openAlerts} open</span></div>
              {shownAlerts.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className={`mx-alert ${a.state === 'cleared' ? 'is-success' : sevClass(a.severity)}`}
                  onClick={() => {
                    if (!byId.has(a.nodeId)) return
                    setSelected({ kind: 'node', id: a.nodeId })
                    focusN.current += 1
                    setFocus({ id: a.nodeId, n: focusN.current })
                  }}
                >
                  <StatusIcon level={a.state === 'cleared' ? 'ok' : (SEV_RANK[a.severity] ?? 0) >= 3 ? 'danger' : 'warn'} />
                  <span className="mx-alert-body">
                    <span className="mx-alert-t">{a.state === 'cleared' ? 'Cleared: ' : `${a.severity[0].toUpperCase()}${a.severity.slice(1)}: `}{a.title}</span>
                    <span className="mx-alert-m">{a.label} · {hhmmss(a.ts)}</span>
                  </span>
                </button>
              ))}
            </section>
          )}

          {selNode && (
            <>
              <div className="mx-ph">
                <div className="mx-ph-l1">
                  <span className="mx-kpill" title={kindOf(selNode.role).kind}>{kindOf(selNode.role).kind === 'workload' ? 'W' : kindOf(selNode.role).kind === 'ingress' ? 'S' : kindOf(selNode.role).kind === 'data store' ? 'D' : kindOf(selNode.role).kind === 'external' ? 'E' : 'C'}</span>
                  <span className="mx-ph-name">{selNode.label}</span>
                  <button type="button" className="mx-x" onClick={() => setSelected(null)} aria-label="close">×</button>
                </div>
                <div className="mx-labels">
                  <span className="mx-label">role: {selNode.role}</span>
                  <span className="mx-label">status: {selNode.status}</span>
                  <span className="mx-label">region: {selNode.region}</span>
                </div>
                <div className="mx-health">
                  <StatusIcon level={selNode.status !== 'running' ? (selNode.status === 'offline' ? 'danger' : 'info') : issueLevel(selNode) === 'red' ? 'danger' : issueLevel(selNode) === 'amber' ? 'warn' : 'ok'} />
                  <span style={{ color: selNode.status === 'running' ? healthColor(selNode) : undefined }}>
                    {selNode.status !== 'running' ? selNode.status : issueLevel(selNode) === 'red' ? 'Failure' : issueLevel(selNode) === 'amber' ? 'Degraded' : 'Healthy'}
                  </span>
                  <span className="mx-dim">· {(selNode.issues ?? []).length} issue{(selNode.issues ?? []).length === 1 ? '' : 's'}</span>
                </div>
              </div>
              <div className="mx-tabs" role="tablist">
                <button type="button" role="tab" className={tab === 'overview' ? 'is-on' : ''} onClick={() => setTab('overview')}>Overview</button>
                <button type="button" role="tab" className={tab === 'traffic' ? 'is-on' : ''} onClick={() => setTab('traffic')}>Traffic</button>
                {code && <button type="button" role="tab" className={tab === 'files' ? 'is-on' : ''} onClick={() => setTab('files')}>Files <span className="mx-count">{code.files.length}</span></button>}
              </div>
              <div className="mx-pbody">
                {tab === 'overview' && (
                  <>
                    <div className="mx-sec">Linode</div>
                    <dl className="mx-dl">
                      <dt>Private IP</dt><dd className="mx-mono">{selNode.privateIp}</dd>
                      <dt>Public IP</dt><dd className="mx-mono">{selNode.publicIp}</dd>
                      <dt>Region</dt><dd>{selNode.region}</dd>
                      <dt>Type</dt><dd>{selNode.type}</dd>
                    </dl>
                    {selNode.status === 'running' && (
                      <>
                        <div className="mx-sec">Resources</div>
                        <Meter label="CPU" v={selNode.cpu} text={`${Math.round(selNode.cpu * 100)}%`} />
                        <Meter label="Memory" v={selNode.memTotal ? selNode.memUsed / selNode.memTotal : 0} text={fmtMem(selNode.memUsed, selNode.memTotal)} />
                        <dl className="mx-dl"><dt>Load (1m)</dt><dd>{selNode.load1}</dd></dl>
                      </>
                    )}
                    <div className="mx-sec">Issues <span className="mx-count">{(selNode.issues ?? []).length}</span></div>
                    {(selNode.issues ?? []).length === 0 && <div className="mx-none">None reported</div>}
                    {sortedIssues(selNode).map((i) => (
                      <div key={i.id} className={`mx-issue ${sevClass(i.severity)}`}>
                        <div className="mx-issue-l1"><StatusIcon level={(SEV_RANK[i.severity] ?? 0) >= 3 ? 'danger' : 'warn'} /><span className="mx-issue-t">{i.title}</span><span className="mx-sev">{i.severity}</span></div>
                        <div className="mx-issue-d" title={i.detail}>{i.detail}</div>
                        <div className="mx-issue-m">held {held(i.since, now)} · {i.source}{i.file ? ` · ${i.file}` : ''}</div>
                      </div>
                    ))}
                    <div className="mx-sec">Processes</div>
                    {selNode.processes.length === 0 && <div className="mx-none">—</div>}
                    {selNode.processes.length > 0 && (
                      <table className="mx-table">
                        <thead><tr><th>Name</th><th>PID</th><th>Ports</th></tr></thead>
                        <tbody>
                          {selNode.processes.map((p) => (
                            <tr key={`${p.pid}-${p.name}`}><td>{p.name}</td><td className="mx-dim mx-mono">{p.pid}</td><td className="mx-mono">{p.ports.length ? ':' + p.ports.join(', :') : '—'}</td></tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </>
                )}
                {tab === 'traffic' && (
                  <>
                    {(['in', 'out'] as const).map((dir) => {
                      const ls = links.filter((l) => (dir === 'in' ? l.target === selNode.id : l.source === selNode.id))
                      return (
                        <div key={dir}>
                          <div className="mx-sec">{dir === 'in' ? 'Inbound' : 'Outbound'} <span className="mx-count">{ls.length}</span></div>
                          {ls.length === 0 ? <div className="mx-none">No {dir === 'in' ? 'inbound' : 'outbound'} traffic</div> : (
                            <table className="mx-table">
                              <thead><tr><th>{dir === 'in' ? 'From' : 'To'}</th><th>Proto</th><th>→ / ←</th><th>Conns</th></tr></thead>
                              <tbody>
                                {ls.map((l) => (
                                  <tr key={l.id} className="is-click" onClick={() => setSelected({ kind: 'link', id: l.id })}>
                                    <td><i className="mx-swatch" style={{ background: edgeColor(l.protocol, errPct, l.bytesPerSec + l.bytesPerSecReverse) }} />{label(dir === 'in' ? l.source : l.target)}</td>
                                    <td className="mx-mono">{l.protocol}:{l.port}</td>
                                    <td className="mx-mono">{fmtRate(l.bytesPerSec)} / {fmtRate(l.bytesPerSecReverse)}</td>
                                    <td>{l.conns}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </div>
                      )
                    })}
                  </>
                )}
                {tab === 'files' && code && (
                  <>
                    <div className="mx-sec">Files · <span className="mx-mono">{code.root}</span></div>
                    {code.files.slice().sort((a, b) => b.loc - a.loc).map((f) => {
                      const fi = fileIssues(selNode, f.path)
                      const port = code.ports.filter((q) => q.file === f.path).map((q) => `${q.dir}:${q.port}`).join(' ')
                      const isSel = selected?.kind === 'node' && selected.file === f.path
                      return (
                        <button key={f.path} type="button" className={`mx-file ${isSel ? 'is-sel' : ''}`} title={f.path}
                          onClick={() => setSelected({ kind: 'node', id: selNode.id, file: f.path })}>
                          <span className="mx-file-p">{f.path}</span>
                          <span className="mx-dim">{f.loc}</span>
                          <span className="mx-file-port">{port}</span>
                          {fi.length > 0 && <span className={`mx-fbadge ${(SEV_RANK[fi[0].severity] ?? 0) >= 3 ? 'is-danger' : 'is-warning'}`}>{fi.length > 1 ? `!${fi.length}` : '!'}</span>}
                        </button>
                      )
                    })}
                    {selFile && (
                      <>
                        <div className="mx-sec">Issues in {selFile.split('/').pop()}</div>
                        {fileIssues(selNode, selFile).length === 0 && <div className="mx-none">None reported</div>}
                        {fileIssues(selNode, selFile).map((i) => (
                          <div key={i.id} className={`mx-issue ${sevClass(i.severity)}`}>
                            <div className="mx-issue-l1"><StatusIcon level={(SEV_RANK[i.severity] ?? 0) >= 3 ? 'danger' : 'warn'} /><span className="mx-issue-t">{i.title}</span><span className="mx-sev">{i.severity}</span></div>
                            <div className="mx-issue-d" title={i.detail}>{i.detail}</div>
                          </div>
                        ))}
                      </>
                    )}
                  </>
                )}
              </div>
              {canDelete(selNode) && (
                <div className="mx-pfoot">
                  <button type="button" className="mx-btn mx-btn--danger" onClick={() => { setTyped(''); setConfirm(selNode) }}>Destroy server</button>
                </div>
              )}
            </>
          )}

          {selLink && (
            <>
              <div className="mx-ph">
                <div className="mx-ph-l1">
                  <span className="mx-kpill mx-kpill--edge">E</span>
                  <span className="mx-ph-name">{label(selLink.source)} → {label(selLink.target)}</span>
                  <button type="button" className="mx-x" onClick={() => setSelected(null)} aria-label="close">×</button>
                </div>
                <div className="mx-labels">
                  <span className="mx-label">{selLink.protocol}</span>
                  <span className="mx-label">port {selLink.port}</span>
                </div>
              </div>
              <div className="mx-pbody">
                <div className="mx-sec">Traffic</div>
                <dl className="mx-dl">
                  <dt>Connections</dt><dd>{selLink.conns}</dd>
                  <dt>{label(selLink.source)} →</dt><dd className="mx-mono">{fmtRate(selLink.bytesPerSec)}</dd>
                  <dt>← {label(selLink.target)}</dt><dd className="mx-mono">{fmtRate(selLink.bytesPerSecReverse)}</dd>
                  <dt>Edge id</dt><dd className="mx-mono mx-dim">{selLink.id}</dd>
                </dl>
              </div>
            </>
          )}

          {!selNode && !selLink && (
            <>
              <div className="mx-ph">
                <div className="mx-ph-l1"><span className="mx-kpill mx-kpill--ns">G</span><span className="mx-ph-name">Current graph</span></div>
                <div className="mx-labels">
                  <span className="mx-label">{kinds.ingress} ingress</span>
                  <span className="mx-label">{kinds.workload} workloads</span>
                  <span className="mx-label">{kinds.store} data stores</span>
                  {kinds.other > 0 && <span className="mx-label">{kinds.other} other</span>}
                </div>
              </div>
              <div className="mx-pbody">
                <div className="mx-sec">HTTP requests per second</div>
                {m ? (
                  <>
                    <div className="mx-big"><b>{Math.round(m.rps).toLocaleString()}</b><span>rps</span><b className={m.errorRate >= 0.1 ? 'is-warn' : ''}>{m.errorRate.toFixed(2)}%</b><span>error</span><b>{Math.round(m.latencyMs)}</b><span>ms</span></div>
                    <Sparkline m={m} />
                  </>
                ) : <div className="mx-none">No metrics</div>}
                <div className="mx-sec">Throughput</div>
                <table className="mx-table">
                  <thead><tr><th>Traffic</th><th>Edges</th><th>Both directions</th></tr></thead>
                  <tbody>
                    <tr><td><i className="mx-swatch" style={{ background: K.green }} />HTTP</td><td>{httpLinks.length}</td><td className="mx-mono">{fmtRate(sumRate(httpLinks))}</td></tr>
                    <tr><td><i className="mx-swatch" style={{ background: K.tcp }} />TCP</td><td>{tcpLinks.length}</td><td className="mx-mono">{fmtRate(sumRate(tcpLinks))}</td></tr>
                  </tbody>
                </table>
                <div className="mx-sec">Health <span className="mx-count">{openIssues}</span></div>
                {(fleet?.nodes ?? []).filter((n) => (n.issues ?? []).length > 0).sort((a, b) => (b.issues ?? []).length - (a.issues ?? []).length).map((n) => (
                  <button key={n.id} type="button" className="mx-hrow" onClick={() => setSelected({ kind: 'node', id: n.id })}>
                    <StatusIcon level={issueLevel(n) === 'red' ? 'danger' : 'warn'} />
                    <span className="mx-hrow-n">{n.label}</span>
                    <span className="mx-dim">{(n.issues ?? []).length} issue{(n.issues ?? []).length === 1 ? '' : 's'}</span>
                  </button>
                ))}
                {openIssues === 0 && <div className="mx-none">{fleet ? 'All nodes healthy' : 'No data'}</div>}
                <div className="mx-hint">Click a node for its detail; workloads open into their files.</div>
              </div>
            </>
          )}
        </aside>
      </div>

      {/* ---- destroy confirmation (strict typed label) ---- */}
      {confirm && (
        <div className="mx-modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) setConfirm(null) }}>
          <div className="mx-modal" role="dialog" aria-modal="true" aria-label="destroy server">
            <div className="mx-modal-h"><StatusIcon level="danger" /><span>Destroy server?</span></div>
            <p className="mx-modal-p">
              This permanently deletes the Linode server <b>{confirm.label}</b> ({confirm.publicIp}, {confirm.region}, {confirm.type}).
              Its disk and everything on it is destroyed. This cannot be undone.
            </p>
            {fl.source === 'sim' && <p className="mx-modal-p mx-dim">SIM mode: simulated, no real server is touched.</p>}
            <label className="mx-modal-l" htmlFor="mx-confirm">Type <b>{confirm.label}</b> to confirm</label>
            <input
              id="mx-confirm"
              className="mx-input"
              autoFocus
              autoComplete="off"
              spellCheck={false}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void destroy() }}
            />
            <div className="mx-modal-a">
              <button type="button" className="mx-btn mx-btn--danger" disabled={typed !== confirm.label} onClick={() => void destroy()}>Destroy {confirm.label}</button>
              <button type="button" className="mx-btn mx-btn--link" onClick={() => setConfirm(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Readout({ label, value, level }: { label: string; value: string; level?: 'warn' | 'danger' }) {
  return (
    <div className={`mx-read ${level ? `is-${level}` : ''}`}>
      <span className="mx-read-k">{label}</span>
      <span className="mx-read-v">{value}</span>
    </div>
  )
}

function Meter({ label, v, text }: { label: string; v: number; text: string }) {
  const pct = Math.max(0, Math.min(1, v))
  return (
    <div className="mx-meter">
      <div className="mx-meter-l"><span>{label}</span><span className="mx-mono">{text}</span></div>
      <div className="mx-meter-t"><div className={`mx-meter-f ${pct > 0.9 ? 'is-danger' : pct > 0.75 ? 'is-warning' : ''}`} style={{ width: `${pct * 100}%` }} /></div>
    </div>
  )
}
