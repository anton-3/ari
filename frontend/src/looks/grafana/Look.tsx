import { Component, useEffect, useMemo, useRef, useState } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { ACTIVE_AGENT, codeFor, fileIssues, fmtMem, fmtRate } from '../../graph/GraphView'
import type { Sel } from '../../graph/GraphView'
import { forgetPos } from '../../graph/positions'
import { toMs, useFleet } from '../../graph/useFleet'
import { useTelemetry } from '../../graph/useTelemetry'
import type { FleetIssue, FleetLogLine, FleetNode, SeriesPoint } from '../../graph/types'
import NodeGraph, { G, PROTO, SEV_COLOR } from './NodeGraph'
import type { GraphCmd } from './NodeGraph'
import './grafana.css'

export const meta = {
  title: 'Grafana',
  inspiration: 'Grafana dashboard with the Node graph panel (Tempo service-graph style): arc-ring nodes, stat panels, logs panel, dark theme',
}

const params = (() => {
  try { return new URLSearchParams(window.location.search) } catch { return new URLSearchParams() }
})()
const SIM = params.get('sim') === '1'

const SEV_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 }
const UNDELETABLE_ROLES = new Set(['controller', 'internet'])

function hhmmss(ts: number | string | undefined): string {
  const d = new Date(toMs(ts))
  const p = (x: number) => String(x).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
function logTs(ts: number): string {
  const d = new Date(ts)
  const p = (x: number, n = 2) => String(x).padStart(n, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
}
function held(since: number | string, now: number): string {
  const s = Math.max(0, Math.round((now - toMs(since)) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}
function canDelete(n: FleetNode | undefined): boolean {
  return !!n && n.deletable && !UNDELETABLE_ROLES.has(n.role) && n.status !== 'deleting' && !n.id.startsWith('pending-')
}
const sevClass = (s: string) => ((SEV_RANK[s] ?? 0) >= 3 ? 'is-red' : 'is-amber')

// ---- Error boundary rendered as a Grafana panel error -------------------------
class PanelErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('[ari grafana look] render error', error, info.componentStack) }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="gf-nodata" role="alert">
        <div className="gf-nodata-h is-err">Panel render error</div>
        <div className="gf-nodata-sub">{this.state.error.message}</div>
        <button type="button" className="gf-btn gf-btn--secondary" onClick={() => this.setState({ error: null })}>Reload panel</button>
      </div>
    )
  }
}

// ---- small building blocks -----------------------------------------------------
function Panel({ title, right, className, children, info }: { title: ReactNode; right?: ReactNode; className?: string; children: ReactNode; info?: string }) {
  return (
    <section className={`gf-panel ${className ?? ''}`}>
      <header className="gf-panel-h">
        <h2 className="gf-panel-t">{title}</h2>
        {info && <span className="gf-panel-info" title={info}>i</span>}
        <span className="gf-panel-r">{right}</span>
      </header>
      <div className="gf-panel-b">{children}</div>
    </section>
  )
}

function Spark({ values, color }: { values: number[]; color: string }) {
  if (values.length < 2) return null
  const max = Math.max(...values)
  const min = Math.min(...values)
  const span = max - min || 1
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${38 - ((v - min) / span) * 30}`)
  return (
    <svg className="gf-spark" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden>
      <polygon points={`0,40 ${pts.join(' ')} 100,40`} fill={color} opacity={0.18} />
      <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function Stat({ title, value, unit, sub, color, spark, bg }: { title: string; value: string; unit?: string; sub?: string; color: string; spark?: number[]; bg?: boolean }) {
  return (
    <section className={`gf-panel gf-stat ${bg ? 'is-bg' : ''}`} style={bg ? { background: `linear-gradient(120deg, ${color}, ${color}cc)` } : undefined}>
      <header className="gf-panel-h"><h2 className="gf-panel-t">{title}</h2></header>
      <div className="gf-stat-b">
        {spark && <Spark values={spark} color={color} />}
        <div className="gf-stat-v" style={bg ? undefined : { color }}>
          {value}{unit && <span className="gf-stat-u">{unit}</span>}
        </div>
        {sub && <div className="gf-stat-sub">{sub}</div>}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------------
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
  const cmdRef = useRef<GraphCmd | null>(null)

  const [selected, setSelected] = useState<Sel | null>(null)
  const [focus, setFocus] = useState<{ id: string; n: number } | null>(null)
  const [confirm, setConfirm] = useState<FleetNode | null>(null)
  const [typed, setTyped] = useState('')
  const [legendOpen, setLegendOpen] = useState(() => {
    try { return window.localStorage.getItem('ari.legend') !== '0' } catch { return true }
  })
  const [showControl, setShowControl] = useState(() => {
    try { return window.localStorage.getItem('ari.showControl') === '1' } catch { return false }
  })
  const [now, setNow] = useState(Date.now())
  const [jobLog, setJobLog] = useState<FleetLogLine[]>([])
  const [thruHist, setThruHist] = useState<number[]>([])
  const jobSeen = useRef(new Map<string, string>())
  const logRef = useRef<HTMLDivElement | null>(null)
  const focusN = useRef(0)

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])

  const byId = useMemo(() => new Map((fleet?.nodes ?? []).map((n) => [n.id, n])), [fleet])
  const thru = (fleet?.links ?? []).reduce((s, l) => s + Math.max(0, l.bytesPerSec) + Math.max(0, l.bytesPerSecReverse), 0)

  // real throughput history (one sample per fleet frame) for the stat sparkline
  useEffect(() => {
    if (!fleet) return
    const v = fleet.links.reduce((s, l) => s + Math.max(0, l.bytesPerSec) + Math.max(0, l.bytesPerSecReverse), 0)
    setThruHist((h) => [...h, v].slice(-60))
  }, [fleet])

  // check jobs → log lines
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

  // deep link: &node=<label> selects (and for code roles expands) once it appears
  const deepLink = useRef<string | null>(params.get('node'))
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        if (e.key === 'Escape') setConfirm(null)
        return
      }
      if (e.key === 'Escape') {
        if (confirm) setConfirm(null)
        else setSelected(null)
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && !confirm && canDelete(selNode)) {
        e.preventDefault()
        setTyped('')
        setConfirm(selNode!)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirm, selNode])

  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  })

  const counts = { run: 0, boot: 0, off: 0, del: 0 }
  for (const n of fleet?.nodes ?? []) {
    if (n.status === 'running') counts.run++
    else if (n.status === 'provisioning' || n.status === 'booting') counts.boot++
    else if (n.status === 'offline') counts.off++
    else if (n.status === 'deleting') counts.del++
  }
  const allIssues = (fleet?.nodes ?? []).flatMap((n) => n.issues ?? [])
  const openIssues = allIssues.length
  const critHigh = allIssues.filter((i) => (SEV_RANK[i.severity] ?? 0) >= 3).length
  const m = tel.metrics
  const series: SeriesPoint[] = m?.series ?? []

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
  const toggleLegend = () => setLegendOpen((v) => {
    try { window.localStorage.setItem('ari.legend', v ? '0' : '1') } catch { /* ignore */ }
    return !v
  })

  const feedLabel = fl.source === 'live' ? 'Live' : fl.source === 'sim' ? 'Simulated (?sim=1)' : fl.source === 'offline' ? 'No feed' : 'Connecting…'

  return (
    <div className="look-grafana">
      {/* ---- top nav ---- */}
      <nav className="gf-top">
        <span className="gf-mark" aria-hidden>
          <svg viewBox="0 0 16 16" width="16" height="16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="28 10" /><circle cx="8" cy="8" r="2" fill="currentColor" /></svg>
        </span>
        <span className="gf-crumb">Home</span><span className="gf-sep">›</span>
        <span className="gf-crumb">Dashboards</span><span className="gf-sep">›</span>
        <span className="gf-crumb">Ari</span><span className="gf-sep">›</span>
        <span className="gf-crumb is-cur">Fleet topology</span>
        <span className="gf-top-hint">drag nodes to pin · wheel / pinch zoom · double-click fits · Del destroys</span>
      </nav>

      {/* ---- dashboard controls (variables row) ---- */}
      <div className="gf-controls">
        <div className="gf-var">
          <span className="gf-var-l">Control links</span>
          <button type="button" role="switch" aria-checked={showControl} className={`gf-switch ${showControl ? 'is-on' : ''}`}
            onClick={() => setShowControl((v) => {
              try { window.localStorage.setItem('ari.showControl', v ? '0' : '1') } catch { /* ignore */ }
              return !v
            })}>
            <span />
          </button>
        </div>
        <div className="gf-var">
          <span className="gf-var-l">Legend</span>
          <button type="button" role="switch" aria-checked={legendOpen} className={`gf-switch ${legendOpen ? 'is-on' : ''}`} onClick={toggleLegend}><span /></button>
        </div>
        <div className="gf-controls-r">
          <span className={`gf-feed gf-feed--${fl.source}`} title="fleet feed (/api/fleet + WS)"><i />Fleet: {feedLabel}</span>
          {!SIM && (
            <span className={`gf-feed gf-feed--${tel.source === 'live' || tel.source === 'polling' ? 'live' : 'offline'}`} title="metrics feed">
              <i />Metrics: {tel.source === 'live' ? 'WebSocket' : tel.source === 'polling' ? 'polling' : '—'}
            </span>
          )}
          <button type="button" className="gf-btn gf-btn--secondary" onClick={() => cmdRef.current?.fit()}>Fit graph</button>
        </div>
      </div>

      <main className="gf-grid">
        {/* ---- stat row ---- */}
        <div className="gf-stats">
          <Stat title="Throughput" value={fmtRate(thru)} color={G.green} spark={thruHist} sub="sum of link bytes/s, both directions" />
          <Stat title="Nodes running" value={String(counts.run)} color={counts.off ? G.orange : G.green}
            sub={`${counts.boot} booting · ${counts.off} offline${counts.del ? ` · ${counts.del} deleting` : ''}`} />
          <Stat title="Open issues" value={String(openIssues)} color={critHigh ? '#C4162A' : openIssues ? '#FF780A' : '#37872D'} bg
            sub={`${critHigh} critical/high · ${openIssues - critHigh} medium/low`} />
          <Stat title="Requests / s" value={m ? Math.round(m.rps).toLocaleString() : 'No data'} color={G.blue} spark={series.map((s) => s.rps)} />
          <Stat title="Error rate" value={m ? m.errorRate.toFixed(2) : 'No data'} unit={m ? '%' : undefined} color={m && m.errorRate > 4 ? G.red : G.green} spark={series.map((s) => s.errorRate)} />
          <Stat title="Mode" value={m ? (surge ? 'Surge' : 'Nominal') : 'No data'} color={surge ? G.orange : m ? G.green : G.text2} sub={m ? `${m.latencyMs} ms latency` : undefined} />
        </div>

        {/* ---- add node ---- */}
        <Panel title="Add node" className="gf-add" info="Roles from /api/fleet/roles. Click to add, or drag onto the graph to place.">
          {addable.length === 0 && <div className="gf-empty">{feedUp ? 'No addable roles' : 'No data'}</div>}
          {addable.map((r) => (
            <button key={r.role} type="button" className="gf-role" draggable={feedUp} disabled={!feedUp}
              title={`${r.description} — click to add, or drag onto the graph`}
              onClick={() => fl.addNode(r.role)}
              onDragStart={(e) => { e.dataTransfer.setData('text/ari-role', r.role); e.dataTransfer.effectAllowed = 'copy' }}>
              <span className="gf-role-plus">+</span>
              <span className="gf-role-txt"><b>{r.label}</b><small>{r.role}</small></span>
            </button>
          ))}
        </Panel>

        {/* ---- node graph ---- */}
        <Panel title="Fleet topology" className="gf-graph" info="Node graph. Arc = issue severity mix (green = no open issues). Inside: cpu, mem. Edges: protocol colour, arrow source→target, label = bytes/s both ways; moving dashes = real bytes/s per direction (log scale), none when idle. Outer blue arc = running check job."
          right={<span className="gf-panel-meta">{fleet ? `${fleet.nodes.length} nodes · ${fleet.links.length} edges` : ''}</span>}>
          <div className="gf-graph-host">
            <PanelErrorBoundary>
              <NodeGraph fleet={fleet} agents={agents} metrics={m} codemap={fl.codemap} live={live} reduced={reduced}
                showControl={showControl} selected={selected} focus={focus} onSelect={setSelected}
                onDropRole={(role, x, y) => fl.addNode(role, { x, y })} cmdRef={cmdRef} />
            </PanelErrorBoundary>
            {(fl.source === 'offline' || fl.source === 'connecting') && !fleet && (
              <div className="gf-nodata" role="status">
                <div className="gf-nodata-h">No data</div>
                <div className="gf-nodata-sub">{fl.source === 'offline' ? 'Telemetry offline at :8090 — retrying every 2.5s' : 'Waiting for :8090…'}</div>
                <button type="button" className="gf-btn gf-btn--primary" onClick={fl.retry}>Retry now</button>
                <div className="gf-nodata-sub">Offline demo: open with <code>&amp;sim=1</code></div>
              </div>
            )}
            {legendOpen && (
              <div className="gf-legend" aria-label="legend">
                <span className="gf-lg-group">Arc</span>
                <span className="gf-lg"><i style={{ background: SEV_COLOR.critical }} />critical</span>
                <span className="gf-lg"><i style={{ background: SEV_COLOR.high }} />high</span>
                <span className="gf-lg"><i style={{ background: SEV_COLOR.medium }} />medium</span>
                <span className="gf-lg"><i style={{ background: SEV_COLOR.low }} />low</span>
                <span className="gf-lg"><i style={{ background: G.green }} />no issues</span>
                <span className="gf-lg"><b className="gf-lg-badge">!3</b>open issues</span>
                <span className="gf-lg-group">Edge</span>
                <span className="gf-lg"><i className="ln" style={{ background: PROTO.http }} />http</span>
                <span className="gf-lg"><i className="ln" style={{ background: PROTO.postgres }} />postgres</span>
                <span className="gf-lg"><i className="ln" style={{ background: PROTO.redis }} />redis</span>
                <span className="gf-lg"><i className="ln dash" />ssh / control</span>
                <span className="gf-lg"><i className="ln job" />check job</span>
              </div>
            )}
            <div className="gf-zoom">
              <button type="button" title="Zoom in" onClick={() => cmdRef.current?.zoom(1.25)}>+</button>
              <button type="button" title="Zoom out" onClick={() => cmdRef.current?.zoom(0.8)}>−</button>
            </div>
          </div>
        </Panel>

        {/* ---- right column ---- */}
        <div className={`gf-side ${selNode || selLink ? 'has-detail' : ''}`}>
          <Panel title="Alerts" className="gf-alerts" right={<span className="gf-panel-meta">{openAlerts} firing</span>}>
            {shownAlerts.length === 0 && <div className="gf-empty">{feedUp ? 'No firing alerts' : 'No data'}</div>}
            {shownAlerts.map((a) => (
              <button key={a.id} type="button" className={`gf-alert ${a.state === 'cleared' ? 'is-ok' : sevClass(a.severity)}`}
                onClick={() => {
                  if (!byId.has(a.nodeId)) return
                  setSelected({ kind: 'node', id: a.nodeId })
                  focusN.current += 1
                  setFocus({ id: a.nodeId, n: focusN.current })
                }}>
                <span className="gf-alert-ic" aria-hidden>{a.state === 'cleared' ? '✓' : '!'}</span>
                <span className="gf-alert-txt">
                  <span className="gf-alert-t">{a.title}</span>
                  <span className="gf-alert-m">
                    <b>{a.state === 'cleared' ? 'Normal' : a.severity}</b> · {a.label} · {hhmmss(a.ts)}
                  </span>
                </span>
              </button>
            ))}
          </Panel>

          {selNode && (
            <Panel title={selNode.label} className="gf-detail" right={<button type="button" className="gf-x" title="Close (Esc)" onClick={() => setSelected(null)}>×</button>}>
              <div className="gf-detail-sub">
                <span className="gf-tag">{selNode.role}</span>
                <span className={`gf-tag ${selNode.status === 'running' ? 'is-ok' : selNode.status === 'offline' ? 'is-red' : 'is-blue'}`}>{selNode.status}</span>
              </div>
              <table className="gf-table">
                <tbody>
                  <tr><th>private</th><td>{selNode.privateIp}</td></tr>
                  <tr><th>public</th><td>{selNode.publicIp}</td></tr>
                  <tr><th>linode</th><td>{selNode.region} · {selNode.type}</td></tr>
                  {selNode.status === 'running' && (<>
                    <tr><th>cpu</th><td><Gauge v={selNode.cpu} label={`${(selNode.cpu * 100).toFixed(1)}%`} /></td></tr>
                    <tr><th>mem</th><td><Gauge v={selNode.memTotal ? selNode.memUsed / selNode.memTotal : 0} label={fmtMem(selNode.memUsed, selNode.memTotal)} /></td></tr>
                    <tr><th>load1</th><td>{selNode.load1}</td></tr>
                  </>)}
                </tbody>
              </table>

              <div className="gf-sec">Issues <span>{(selNode.issues ?? []).length}</span></div>
              {(selNode.issues ?? []).length === 0 && <div className="gf-empty">None reported</div>}
              {sortedIssues(selNode).map((i) => (
                <div key={i.id} className={`gf-issue ${sevClass(i.severity)}`}>
                  <div className="gf-issue-l1"><span className="gf-sev" style={{ color: SEV_COLOR[i.severity] ?? SEV_COLOR.low }}>{i.severity}</span>{i.title}</div>
                  <div className="gf-issue-d" title={i.detail}>{i.detail}</div>
                  <div className="gf-issue-m">for {held(i.since, now)} · {i.source}{i.file ? ` · ${i.file}` : ''}</div>
                </div>
              ))}

              <div className="gf-sec">Processes <span>{selNode.processes.length}</span></div>
              {selNode.processes.length === 0 ? <div className="gf-empty">—</div> : (
                <table className="gf-table gf-table--grid">
                  <thead><tr><th>name</th><th>pid</th><th>ports</th></tr></thead>
                  <tbody>
                    {selNode.processes.map((p) => (
                      <tr key={`${p.pid}-${p.name}`}><td>{p.name}</td><td className="dim">{p.pid}</td><td>{p.ports.length ? ':' + p.ports.join(', :') : ''}</td></tr>
                    ))}
                  </tbody>
                </table>
              )}

              {code && (<>
                <div className="gf-sec">Files <span>{code.root}</span></div>
                <table className="gf-table gf-table--grid gf-files">
                  <thead><tr><th>path</th><th>loc</th><th>ports</th><th /></tr></thead>
                  <tbody>
                    {code.files.slice().sort((a, b) => b.loc - a.loc).map((f) => {
                      const fi = fileIssues(selNode, f.path)
                      const port = code.ports.filter((q) => q.file === f.path).map((q) => `${q.dir}:${q.port}`).join(' ')
                      const isSel = selected?.kind === 'node' && selected.file === f.path
                      return (
                        <tr key={f.path} className={isSel ? 'is-sel' : ''} title={f.path} onClick={() => setSelected({ kind: 'node', id: selNode.id, file: f.path })}>
                          <td className="gf-file-p">{f.path.split('/').pop()}</td>
                          <td className="dim">{f.loc}</td>
                          <td>{port}</td>
                          <td>{fi.length > 0 && <span className={`gf-badge ${sevClass(fi[0].severity)}`}>{fi.length > 1 ? `!${fi.length}` : '!'}</span>}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </>)}

              {canDelete(selNode) && (
                <button type="button" className="gf-btn gf-btn--destructive gf-destroy" onClick={() => { setTyped(''); setConfirm(selNode) }}>
                  Destroy server
                </button>
              )}
            </Panel>
          )}

          {selLink && (
            <Panel title={`${selLink.protocol} :${selLink.port}`} className="gf-detail" right={<button type="button" className="gf-x" title="Close (Esc)" onClick={() => setSelected(null)}>×</button>}>
              <div className="gf-detail-sub">{byId.get(selLink.source)?.label ?? selLink.source} → {byId.get(selLink.target)?.label ?? selLink.target}</div>
              <table className="gf-table">
                <tbody>
                  <tr><th>connections</th><td>{selLink.conns}</td></tr>
                  <tr><th>forward</th><td>{fmtRate(selLink.bytesPerSec)}</td></tr>
                  <tr><th>reverse</th><td>{fmtRate(selLink.bytesPerSecReverse)}</td></tr>
                  <tr><th>id</th><td className="dim">{selLink.id}</td></tr>
                </tbody>
              </table>
            </Panel>
          )}
        </div>

        {/* ---- logs panel ---- */}
        <Panel title="Logs" className="gf-logs" right={<span className="gf-panel-meta">ari · fleet · check</span>}>
          <div className="gf-log-body" ref={logRef}>
            {logLines.length === 0 && (
              <div className="gf-log-row"><i className="lv" /><span className="ts">{logTs(now)}</span><span className="msg">{feedUp ? 'fleet feed linked' : 'waiting for telemetry at :8090…'}</span></div>
            )}
            {logLines.map((l, i) => (
              <div className={`gf-log-row ${l.err ? 'is-err' : ''}`} key={`${l.ts}-${i}`}>
                <i className={`lv lv--${l.err ? 'error' : l.src}`} />
                <span className="ts">{logTs(l.ts)}</span>
                <span className="lvl">{l.err ? 'error' : 'info'}</span>
                <span className="src">{l.src}</span>
                <span className="msg" title={l.text}>{l.text}</span>
              </div>
            ))}
          </div>
        </Panel>
      </main>

      {/* ---- destroy confirmation (Grafana ConfirmModal with typed confirmation) ---- */}
      {confirm && (
        <div className="gf-modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) setConfirm(null) }}>
          <div className="gf-modal" role="dialog" aria-modal="true" aria-label="destroy server">
            <div className="gf-modal-h"><span className="gf-modal-ic">!</span>Destroy server</div>
            <div className="gf-modal-b">
              <p>This permanently deletes the Linode server <b>{confirm.label}</b> ({confirm.publicIp}, {confirm.region}, {confirm.type}). Its disk and everything on it is destroyed. This cannot be undone.</p>
              {fl.source === 'sim' && <p className="dim">SIM mode: simulated, no real server is touched.</p>}
              <label htmlFor="gf-confirm">Type <b>{confirm.label}</b> to confirm</label>
              <input id="gf-confirm" className="gf-input" autoFocus autoComplete="off" spellCheck={false} value={typed}
                onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void destroy() }} />
            </div>
            <div className="gf-modal-a">
              <button type="button" className="gf-btn gf-btn--secondary" onClick={() => setConfirm(null)}>Cancel</button>
              <button type="button" className="gf-btn gf-btn--destructive" disabled={typed !== confirm.label} onClick={() => void destroy()}>
                Destroy {confirm.label}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Gauge({ v, label }: { v: number; label: string }) {
  const c = v > 0.9 ? G.red : v > 0.75 ? G.orange : G.green
  return (
    <span className="gf-gauge">
      <span className="gf-gauge-bar"><span style={{ width: `${Math.round(Math.min(1, Math.max(0, v)) * 100)}%`, background: c }} /></span>
      <span>{label}</span>
    </span>
  )
}
