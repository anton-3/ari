import { Component, useEffect, useMemo, useRef, useState } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { ACTIVE_AGENT, codeFor, fileIssues, fmtMem, fmtRate } from '../../graph/GraphView'
import type { Sel } from '../../graph/GraphView'
import { forgetPos } from '../../graph/positions'
import { toMs, useFleet } from '../../graph/useFleet'
import { useTelemetry } from '../../graph/useTelemetry'
import type { FleetIssue, FleetLogLine, FleetNode } from '../../graph/types'
import NetView, { PROTO_COLOR } from './NetView'
import { iconFor } from './icons'
import './netdiagram.css'

export const meta = {
  title: 'Network diagram',
  inspiration: 'Cisco topology icons, Visio network stencils and the Packet Tracer logical view, drawn as a light engineering sheet with a title block',
}

const params = (() => {
  try { return new URLSearchParams(window.location.search) } catch { return new URLSearchParams() }
})()
const SIM = params.get('sim') === '1'

const SEV_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 }
const UNDELETABLE_ROLES = new Set(['controller', 'internet'])
const GLYPH: Record<string, string> = { lb: 'LB', app: 'APP', db: 'PG', cache: 'RDS', worker: 'WRK', traffic: 'TRF', controller: 'CTL', internet: 'NET' }

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
const sevClass = (s: string) => ((SEV_RANK[s] ?? 0) >= 3 ? 'is-red' : 'is-amber')

/** Device symbol as inline SVG (same geometry as the map canvas). */
function DevSym({ role, size = 34 }: { role: string; size?: number }) {
  return (
    <svg className="nd-sym" viewBox="-34 -28 68 56" width={size} height={(size * 56) / 68} aria-hidden>
      {iconFor(role).map((p, i) => (
        <path
          key={i}
          d={p.d}
          className={`nd-sym-${p.fill}`}
          stroke={p.stroke === false ? 'none' : undefined}
        />
      ))}
    </svg>
  )
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ari netdiagram] render error', error, info.componentStack)
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="nd-nofeed" role="alert">
        <div className="nd-nofeed-h">DRAWING RENDER ERROR</div>
        <div className="nd-nofeed-sub">{this.state.error.message}</div>
        <button type="button" className="nd-btn" onClick={() => this.setState({ error: null })}>REDRAW</button>
      </div>
    )
  }
}

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
  const [legendOpen, setLegendOpen] = useState(() => {
    try { return window.localStorage.getItem('ari.legend') !== '0' } catch { return true }
  })
  const [showControl, setShowControl] = useState(() => {
    try { return window.localStorage.getItem('ari.showControl') === '1' } catch { return false }
  })
  const [now, setNow] = useState(Date.now())
  const [jobLog, setJobLog] = useState<FleetLogLine[]>([])
  const jobSeen = useRef(new Map<string, string>())
  const logRef = useRef<HTMLDivElement | null>(null)
  const scaleRef = useRef<HTMLSpanElement | null>(null)
  const focusN = useRef(0)

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])

  const byId = useMemo(() => new Map((fleet?.nodes ?? []).map((n) => [n.id, n])), [fleet])

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

  // Deep link: &node=<label> (or ?node=) selects, and for code-running roles expands, once it appears.
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

  const thru = (fleet?.links ?? []).reduce((s, l) => s + Math.max(0, l.bytesPerSec), 0)
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
    return all.sort((a, b) => a.ts - b.ts).slice(-7)
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
  const regions = [...new Set((fleet?.nodes ?? []).map((n) => n.region).filter((r) => r && r !== '—'))]
  const project = fl.codemap?.roles?.app?.root ?? '—'
  const visibleLinks = (fleet?.links ?? []).length

  return (
    <div className="look-netdiagram">
      <ErrorBoundary>
        <NetView
          fleet={fleet}
          agents={agents}
          metrics={m}
          codemap={fl.codemap}
          live={live}
          reduced={reduced}
          rightInset={selNode || selLink || shownAlerts.length > 0 ? 350 : 40}
          showControl={showControl}
          selected={selected}
          focus={focus}
          onSelect={setSelected}
          onDropRole={(role, x, y) => fl.addNode(role, { x, y })}
          scaleRef={scaleRef}
        />
      </ErrorBoundary>

      {/* drawing frame with zone references */}
      <div className="nd-frame" aria-hidden>
        <div className="nd-frame-top">{[1, 2, 3, 4, 5, 6, 7, 8].map((i) => <span key={i}>{i}</span>)}</div>
        <div className="nd-frame-left">{['A', 'B', 'C', 'D', 'E'].map((c) => <span key={c}>{c}</span>)}</div>
      </div>

      <header className="nd-bar">
        <div className="nd-id">
          <span className="nd-id-name">ARI</span>
          <span className="nd-id-title">LOGICAL NETWORK TOPOLOGY</span>
          <span className="nd-id-sub">drag to re-place (snaps to grid) · wheel zoom · dbl-click fit · del destroys</span>
        </div>
        <div className="nd-bar-right">
          <div className={`nd-feed nd-feed--${fl.source}`}>
            <span className="nd-feed-dot" />
            {fl.source === 'live' ? 'FLEET LIVE' : fl.source === 'sim' ? 'SIM · simulated fleet' : fl.source === 'offline' ? 'NO FEED' : 'LINKING…'}
          </div>
          {!SIM && (
            <div className={`nd-feed nd-feed--${tel.source === 'live' || tel.source === 'polling' ? 'live' : 'offline'}`}>
              <span className="nd-feed-dot" />
              {tel.source === 'live' ? 'METRICS WS' : tel.source === 'polling' ? 'METRICS POLL' : 'METRICS —'}
            </div>
          )}
        </div>
      </header>

      <section className="nd-hud" aria-label="fleet readout">
        <Readout label="THROUGHPUT" value={fmtRate(thru)} />
        <Readout label="NODES" value={`${counts.run} run · ${counts.boot} boot · ${counts.off} off${counts.del ? ` · ${counts.del} del` : ''}`} warn={counts.off > 0} />
        <Readout label="ISSUES" value={String(openIssues)} warn={openIssues > 0} />
        {m && <Readout label="REQ/S" value={Math.round(m.rps).toLocaleString()} />}
        {m && <Readout label="ERR" value={`${m.errorRate.toFixed(2)}%`} warn={m.errorRate > 4} />}
        <Readout label="MODE" value={m ? (surge ? 'SURGE' : 'NOMINAL') : '—'} warn={surge} />
      </section>

      {/* ---- left rail: stencil (add node) + symbol legend ---- */}
      <aside className="nd-rail" aria-label="add node">
        <div className="nd-panel-h">STENCIL <span>+ node</span></div>
        {addable.length === 0 && <div className="nd-rail-empty">{feedUp ? 'no addable roles' : 'no feed'}</div>}
        <div className="nd-stencil">
          {addable.map((r) => (
            <button
              key={r.role}
              type="button"
              className="nd-shape"
              draggable={feedUp}
              disabled={!feedUp}
              title={`${r.description} — click to add, or drag onto the drawing`}
              onClick={() => fl.addNode(r.role)}
              onDragStart={(e) => {
                e.dataTransfer.setData('text/ari-role', r.role)
                e.dataTransfer.effectAllowed = 'copy'
              }}
            >
              <DevSym role={r.role} size={38} />
              <span className="nd-shape-l">{r.label}</span>
              <span className="nd-shape-g">{GLYPH[r.role] ?? r.role.slice(0, 3).toUpperCase()}</span>
            </button>
          ))}
        </div>

        <button type="button" className="nd-panel-h nd-legend-h" onClick={() => {
          setLegendOpen((v) => {
            try { window.localStorage.setItem('ari.legend', v ? '0' : '1') } catch { /* ignore */ }
            return !v
          })
        }}>
          SYMBOL LEGEND <span>{legendOpen ? '▾' : '▸'}</span>
        </button>
        {legendOpen && (
          <div className="nd-legend">
            <div className="nd-lg-syms">
              {(['internet', 'traffic', 'lb', 'app', 'worker', 'db', 'cache', 'controller'] as const).map((r) => (
                <div key={r} className="nd-lg-sym"><DevSym role={r} size={26} /><span>{r === 'db' ? 'postgres' : r === 'cache' ? 'redis' : r}</span></div>
              ))}
            </div>
            <div className="nd-lg-sep" />
            <div className="nd-lg-row"><i className="nd-ln" style={{ background: PROTO_COLOR.http }} />http :80 / :3000</div>
            <div className="nd-lg-row"><i className="nd-ln" style={{ background: PROTO_COLOR.postgres }} />postgres :5432</div>
            <div className="nd-lg-row"><i className="nd-ln" style={{ background: PROTO_COLOR.redis }} />redis :6379</div>
            <div className="nd-lg-row"><i className="nd-ln is-dash" />ssh / control</div>
            <div className="nd-lg-row"><i className="nd-pk" /><i className="nd-pk is-hollow" />packets fwd / reply</div>
            <div className="nd-lg-row"><i className="nd-zone" />zone from real addressing</div>
            <div className="nd-lg-row"><b className="nd-lg-badge is-red">!3</b>critical / high issues</div>
            <div className="nd-lg-row"><b className="nd-lg-badge is-amber">!</b>medium / low issue</div>
            <label className="nd-lg-row nd-lg-check">
              <input
                type="checkbox"
                checked={showControl}
                onChange={(e) => {
                  const v = e.target.checked
                  setShowControl(v)
                  try { window.localStorage.setItem('ari.showControl', v ? '1' : '0') } catch { /* ignore */ }
                }}
              />
              show control links
            </label>
            <div className="nd-lg-note">Packet spacing and speed follow real bytes/s per direction (log scale). No packets = no traffic.</div>
            <div className="nd-lg-note">Teal tag over a device = a running check job.</div>
          </div>
        )}
      </aside>

      {/* ---- right column: alerts + spec sheet ---- */}
      <div className="nd-side">
        {shownAlerts.length > 0 && (
          <section className="nd-alerts" aria-label="alerts">
            <div className="nd-panel-h">ALERTS <span>{openAlerts} open</span></div>
            {shownAlerts.map((a) => (
              <button
                key={a.id}
                type="button"
                className={`nd-alert ${sevClass(a.severity)} ${a.state === 'cleared' ? 'is-cleared' : ''}`}
                onClick={() => {
                  if (!byId.has(a.nodeId)) return
                  setSelected({ kind: 'node', id: a.nodeId })
                  focusN.current += 1
                  setFocus({ id: a.nodeId, n: focusN.current })
                }}
              >
                <span className="nd-alert-l1">
                  <span className="nd-alert-sev">{a.state === 'cleared' ? 'CLEARED' : a.severity.toUpperCase()}</span>
                  <span className="nd-alert-node">{a.label}</span>
                  <span className="nd-alert-ts">{hhmmss(a.ts)}</span>
                </span>
                <span className="nd-alert-title">{a.title}</span>
              </button>
            ))}
          </section>
        )}

        {selNode && (
          <section className="nd-sheet" aria-label="node detail">
            <div className="nd-sheet-h">
              <DevSym role={selNode.role} size={40} />
              <div>
                <div className="nd-sheet-title">{selNode.label}</div>
                <div className="nd-sheet-sub">{selNode.role} · {selNode.status}</div>
              </div>
            </div>
            <table className="nd-kv">
              <tbody>
                <tr><th>private</th><td>{selNode.privateIp}</td></tr>
                <tr><th>public</th><td>{selNode.publicIp}</td></tr>
                <tr><th>linode</th><td>{selNode.region} · {selNode.type}</td></tr>
                {selNode.status === 'running' && (<>
                  <tr><th>cpu</th><td className={selNode.cpu > 0.9 ? 'is-red' : ''}>{Math.round(selNode.cpu * 100)}%</td></tr>
                  <tr><th>mem</th><td>{fmtMem(selNode.memUsed, selNode.memTotal)}</td></tr>
                  <tr><th>load1</th><td>{selNode.load1}</td></tr>
                </>)}
              </tbody>
            </table>

            <div className="nd-sec">ISSUES · {(selNode.issues ?? []).length}</div>
            {(selNode.issues ?? []).length === 0 && <div className="nd-none">none reported</div>}
            {sortedIssues(selNode).map((i) => (
              <div key={i.id} className={`nd-issue ${sevClass(i.severity)}`}>
                <div className="nd-issue-l1"><span className="nd-issue-sev">{i.severity.toUpperCase()}</span>{i.title}</div>
                <div className="nd-issue-d" title={i.detail}>{i.detail}</div>
                <div className="nd-issue-m">held {held(i.since, now)} · {i.source}{i.file ? ` · ${i.file}` : ''}</div>
              </div>
            ))}

            <div className="nd-sec">PROCESSES : PORTS</div>
            {selNode.processes.length === 0 && <div className="nd-none">—</div>}
            {selNode.processes.map((p) => (
              <div key={`${p.pid}-${p.name}`} className="nd-proc">
                <span>{p.name}</span><span className="nd-dim">{p.pid}</span><span>{p.ports.length ? ':' + p.ports.join(',') : ''}</span>
              </div>
            ))}

            {code && (<>
              <div className="nd-sec">MODULES · {code.root}/</div>
              {code.files.slice().sort((a, b) => b.loc - a.loc).map((f) => {
                const fi = fileIssues(selNode, f.path)
                const port = code.ports.filter((q) => q.file === f.path).map((q) => `${q.dir}:${q.port}`).join(' ')
                const isSel = selected?.kind === 'node' && selected.file === f.path
                return (
                  <button key={f.path} type="button" className={`nd-file ${isSel ? 'is-sel' : ''}`} title={f.path}
                    onClick={() => setSelected({ kind: 'node', id: selNode.id, file: f.path })}>
                    <span className="nd-file-p">{f.path}</span>
                    <span className="nd-dim">{f.loc}</span>
                    <span className="nd-file-port">{port}</span>
                    {fi.length > 0 && <span className={`nd-file-badge ${sevClass(fi[0].severity)}`}>{fi.length > 1 ? `!${fi.length}` : '!'}</span>}
                  </button>
                )
              })}
            </>)}

            {canDelete(selNode) && (
              <button type="button" className="nd-destroy" onClick={() => { setTyped(''); setConfirm(selNode) }}>
                DESTROY SERVER
              </button>
            )}
          </section>
        )}

        {selLink && (
          <section className="nd-sheet" aria-label="link detail">
            <div className="nd-sheet-h">
              <div>
                <div className="nd-sheet-title">{selLink.protocol} :{selLink.port}</div>
                <div className="nd-sheet-sub">{byId.get(selLink.source)?.label ?? selLink.source} → {byId.get(selLink.target)?.label ?? selLink.target}</div>
              </div>
            </div>
            <table className="nd-kv">
              <tbody>
                <tr><th>conns</th><td>{selLink.conns}</td></tr>
                <tr><th>fwd</th><td>{fmtRate(selLink.bytesPerSec)}</td></tr>
                <tr><th>rev</th><td>{fmtRate(selLink.bytesPerSecReverse)}</td></tr>
                <tr><th>id</th><td className="nd-dim">{selLink.id}</td></tr>
              </tbody>
            </table>
          </section>
        )}
      </div>

      {(fl.source === 'offline' || fl.source === 'connecting') && !fleet && (
        <div className="nd-nofeed" role="status">
          <div className="nd-nofeed-h">{fl.source === 'offline' ? 'NO FEED — telemetry offline at :8090' : 'LINKING — waiting for :8090'}</div>
          <div className="nd-nofeed-sub">nothing is drawn without real data · retrying every 2.5s</div>
          <button type="button" className="nd-btn" onClick={fl.retry}>RETRY NOW</button>
          <div className="nd-nofeed-sub">offline demo: add <code>&amp;sim=1</code></div>
        </div>
      )}

      {confirm && (
        <div className="nd-modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) setConfirm(null) }}>
          <div className="nd-modal" role="dialog" aria-modal="true" aria-label="destroy server">
            <div className="nd-modal-h">DESTROY SERVER</div>
            <p className="nd-modal-p">
              This permanently deletes the Linode server <b>{confirm.label}</b> ({confirm.publicIp}, {confirm.region}, {confirm.type}).
              Its disk and everything on it is destroyed. This cannot be undone.
            </p>
            {fl.source === 'sim' && <p className="nd-modal-p nd-dim">SIM mode: simulated, no real server is touched.</p>}
            <label className="nd-modal-l" htmlFor="nd-confirm">type <b>{confirm.label}</b> to confirm</label>
            <input
              id="nd-confirm"
              className="nd-input"
              autoFocus
              autoComplete="off"
              spellCheck={false}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void destroy() }}
            />
            <div className="nd-modal-a">
              <button type="button" className="nd-btn" onClick={() => setConfirm(null)}>CANCEL</button>
              <button type="button" className="nd-btn nd-btn-red" disabled={typed !== confirm.label} onClick={() => void destroy()}>
                DESTROY {confirm.label}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---- notes (teletype) + title block ---- */}
      <footer className="nd-notes" aria-label="log">
        <div className="nd-notes-h">NOTES</div>
        <div className="nd-notes-body" ref={logRef}>
          {logLines.length === 0 && (
            <div className="nd-log-line">
              <span className="nd-log-ts">{hhmmss(now)}</span>
              <span className="nd-log-src">ari</span>
              <span className="nd-log-msg">{feedUp ? 'fleet feed linked' : 'waiting for telemetry at :8090…'}</span>
            </div>
          )}
          {logLines.map((l, i) => (
            <div className={`nd-log-line ${i === logLines.length - 1 ? 'is-head' : ''} ${l.err ? 'is-err' : ''}`} key={`${l.ts}-${i}`}>
              <span className="nd-log-ts">{hhmmss(l.ts)}</span>
              <span className="nd-log-src">{l.src}</span>
              <span className="nd-log-msg" title={l.text}>{l.text}</span>
            </div>
          ))}
        </div>
      </footer>

      <section className="nd-titleblock" aria-label="title block">
        <div className="nd-tb-row nd-tb-main">
          <div className="nd-tb-cell nd-tb-grow">
            <span className="nd-tb-k">TITLE</span>
            <span className="nd-tb-v nd-tb-big">ARI FLEET · LOGICAL TOPOLOGY</span>
          </div>
        </div>
        <div className="nd-tb-row">
          <div className="nd-tb-cell nd-tb-grow"><span className="nd-tb-k">PROJECT</span><span className="nd-tb-v">{project}</span></div>
          <div className="nd-tb-cell"><span className="nd-tb-k">REGION</span><span className="nd-tb-v">{regions.join(', ') || '—'}</span></div>
          <div className="nd-tb-cell"><span className="nd-tb-k">SOURCE</span><span className={`nd-tb-v ${fl.source === 'offline' ? 'is-red' : ''}`}>{fl.source.toUpperCase()}</span></div>
        </div>
        <div className="nd-tb-row">
          <div className="nd-tb-cell nd-tb-grow"><span className="nd-tb-k">REV (updatedAt)</span><span className="nd-tb-v">{fleet ? hhmmss(fleet.updatedAt) : '—'}</span></div>
          <div className="nd-tb-cell"><span className="nd-tb-k">SCALE</span><span className="nd-tb-v" ref={scaleRef}>—</span></div>
          <div className="nd-tb-cell"><span className="nd-tb-k">NODES/LINKS</span><span className="nd-tb-v">{fleet ? `${fleet.nodes.length} / ${visibleLinks}` : '—'}</span></div>
          <div className="nd-tb-cell"><span className="nd-tb-k">SHEET</span><span className="nd-tb-v">1 / 1</span></div>
        </div>
      </section>
    </div>
  )
}

function Readout({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className={`nd-read ${warn ? 'is-warn' : ''}`}>
      <span className="nd-read-k">{label}</span>
      <span className="nd-read-v">{value}</span>
    </div>
  )
}
