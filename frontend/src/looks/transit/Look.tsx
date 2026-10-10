import { Component, useEffect, useMemo, useRef, useState } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { ACTIVE_AGENT, codeFor, fileIssues, fmtMem, fmtRate } from '../../graph/GraphView'
import { forgetPos } from '../../graph/positions'
import { toMs, useFleet } from '../../graph/useFleet'
import { useTelemetry } from '../../graph/useTelemetry'
import type { FleetIssue, FleetLogLine, FleetNode } from '../../graph/types'
import TransitView, { LINES, lineKey } from './TransitView'
import type { Sel } from './TransitView'
import './transit.css'

export const meta = {
  title: 'Transit',
  inspiration: "Harry Beck's 1933 London Underground diagram and Massimo Vignelli's 1972 NYC subway map: octilinear lines, interchange capsules, trains for traffic, a service-status board and a departures board.",
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
const ROLE_CODE: Record<string, string> = { lb: 'LB', app: 'APP', db: 'PG', cache: 'RDS', worker: 'WRK', traffic: 'TRF', controller: 'CTL', internet: 'NET' }

function hhmm(ts: number | string | undefined, sec = true): string {
  const d = new Date(toMs(ts))
  const p = (x: number) => String(x).padStart(2, '0')
  return sec ? `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` : `${p(d.getHours())}:${p(d.getMinutes())}`
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

class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ari transit] render error', error, info.componentStack)
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="tr-nofeed" role="alert">
        <div className="tr-nofeed-h">MAP UNAVAILABLE</div>
        <div className="tr-nofeed-sub">{this.state.error.message}</div>
        <button type="button" className="tr-btn" onClick={() => this.setState({ error: null })}>RELOAD MAP</button>
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
  const focusN = useRef(0)

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])

  const byId = useMemo(() => new Map((fleet?.nodes ?? []).map((n) => [n.id, n])), [fleet])

  // Running check jobs → announcements (start + finish). Real jobs on real nodes only.
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

  // Deep link: &node=<label> selects (and, for code-running roles, expands) a station once it appears.
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

  // ---- service status numbers (all from the feed) --------------------------
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

  // per-line totals for the legend (real bytes/s both directions)
  const perLine = useMemo(() => {
    const r: Record<string, { n: number; bps: number }> = {}
    for (const l of links) {
      const k = lineKey(l.protocol)
      const v = r[k] ?? { n: 0, bps: 0 }
      v.n += 1
      v.bps += Math.max(0, l.bytesPerSec) + Math.max(0, l.bytesPerSecReverse)
      r[k] = v
    }
    return r
  }, [links])

  // ---- announcements: reasoning + fleet API + check jobs, by time ----------
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
  const service = !m ? '—' : surge ? 'SURGE' : m.errorRate > 4 ? 'DELAYS' : 'GOOD SERVICE'

  return (
    <div className="look-transit">
      <Boundary>
        <TransitView
          fleet={fleet}
          agents={agents}
          metrics={m}
          codemap={fl.codemap}
          live={live}
          reduced={reduced}
          rightInset={selNode || selLink || shownAlerts.length > 0 ? 340 : 40}
          showControl={showControl}
          selected={selected}
          focus={focus}
          onSelect={setSelected}
          onDropRole={(role, x, y) => fl.addNode(role, { x, y })}
        />
      </Boundary>

      <header className="tr-bar">
        <div className="tr-id">
          <span className="tr-id-mark" aria-hidden><i /></span>
          <span className="tr-id-name">Ari</span>
          <span className="tr-id-title">Network Map</span>
          <span className="tr-id-sub">drag stations · wheel zoom · double-click to fit · Del closes a station</span>
        </div>
        <div className="tr-bar-right">
          <div className={`tr-feed tr-feed--${fl.source}`}>
            <span className="tr-feed-dot" />
            {fl.source === 'live' ? 'Fleet live' : fl.source === 'sim' ? 'SIM · simulated fleet' : fl.source === 'offline' ? 'No feed' : 'Linking…'}
          </div>
          {!SIM && (
            <div className={`tr-feed tr-feed--${tel.source === 'live' || tel.source === 'polling' ? 'live' : 'offline'}`}>
              <span className="tr-feed-dot" />
              {tel.source === 'live' ? 'Metrics WS' : tel.source === 'polling' ? 'Metrics poll' : 'Metrics —'}
            </div>
          )}
          <div className="tr-clock">{hhmm(now, false)}</div>
        </div>
      </header>

      <section className="tr-hud" aria-label="service status">
        <div className="tr-hud-h">Service status</div>
        <Readout label="Throughput" value={fmtRate(thru)} />
        <Readout label="Stations" value={`${counts.run} open · ${counts.boot} opening · ${counts.off} closed${counts.del ? ` · ${counts.del} closing` : ''}`} warn={counts.off > 0} />
        <Readout label="Disruptions" value={String(openIssues)} warn={openIssues > 0} />
        {m && <Readout label="Req/s" value={Math.round(m.rps).toLocaleString()} />}
        {m && <Readout label="Errors" value={`${m.errorRate.toFixed(2)}%`} warn={m.errorRate > 4} />}
        <Readout label="Mode" value={service} warn={surge || (!!m && m.errorRate > 4)} good={service === 'GOOD SERVICE'} />
      </section>

      <aside className="tr-rail" aria-label="add station and legend">
        <div className="tr-rail-h">Open a new station</div>
        {addable.length === 0 && <div className="tr-rail-empty">{feedUp ? 'no addable roles' : 'no feed'}</div>}
        {addable.map((r) => (
          <button
            key={r.role}
            type="button"
            className="tr-role"
            draggable={feedUp}
            disabled={!feedUp}
            title={`${r.description} — click to add, or drag onto the map`}
            onClick={() => fl.addNode(r.role)}
            onDragStart={(e) => {
              e.dataTransfer.setData('text/ari-role', r.role)
              e.dataTransfer.effectAllowed = 'copy'
            }}
          >
            <span className="tr-role-glyph">{ROLE_CODE[r.role] ?? r.role.slice(0, 3).toUpperCase()}</span>
            <span className="tr-role-label">{r.label}</span>
            <span className="tr-role-plus" aria-hidden>+</span>
          </button>
        ))}

        <button type="button" className="tr-legend-h" onClick={() => {
          setLegendOpen((v) => {
            try { window.localStorage.setItem('ari.legend', v ? '0' : '1') } catch { /* ignore */ }
            return !v
          })
        }}>
          Key {legendOpen ? '▾' : '▸'}
        </button>
        {legendOpen && (
          <div className="tr-legend">
            <div className="tr-lg-sec">Lines</div>
            {(['http', 'postgres', 'redis', 'ssh', 'control'] as const).map((k) => (
              <div className="tr-lg-line" key={k}>
                <i className={`tr-ln ${k === 'control' ? 'is-hollow' : ''}`} style={{ background: LINES[k].color }} />
                <span className="tr-lg-name">{LINES[k].name}</span>
                <span className="tr-lg-v">{perLine[k] ? fmtRate(perLine[k].bps) : '—'}</span>
              </div>
            ))}
            <label className="tr-lg-check">
              <input
                type="checkbox"
                checked={showControl}
                onChange={(e) => {
                  const v = e.target.checked
                  setShowControl(v)
                  try { window.localStorage.setItem('ari.showControl', v ? '1' : '0') } catch { /* ignore */ }
                }}
              />
              show control lines
            </label>
            <div className="tr-lg-sec">Stations</div>
            <div className="tr-lg-row"><i className="tr-sym-pill" />interchange (hub)</div>
            <div className="tr-lg-row"><i className="tr-sym-dot" />station</div>
            <div className="tr-lg-row"><i className="tr-sym-tick" />terminus</div>
            <div className="tr-lg-row"><i className="tr-sym-works" />works: check job running</div>
            <div className="tr-lg-sec">Status</div>
            <div className="tr-lg-row"><b className="tr-lg-badge is-red">!3</b>severe: critical / high</div>
            <div className="tr-lg-row"><b className="tr-lg-badge is-amber">!</b>minor: medium / low</div>
            <div className="tr-lg-note">Trains are real bytes/s in each direction (log scale). Shorter headway = more traffic. No trains = no traffic.</div>
            <div className="tr-lg-note">Control lines are hidden unless a station is hovered, selected or under works.</div>
          </div>
        )}
      </aside>

      <div className="tr-side">
        {shownAlerts.length > 0 && (
          <section className="tr-alerts" aria-label="disruptions">
            <div className="tr-alerts-h"><span>Disruptions</span><span className="tr-alerts-n">{openAlerts} open</span></div>
            {shownAlerts.map((a) => (
              <button
                key={a.id}
                type="button"
                className={`tr-alert ${sevClass(a.severity)} ${a.state === 'cleared' ? 'is-cleared' : ''}`}
                onClick={() => {
                  if (!byId.has(a.nodeId)) return
                  setSelected({ kind: 'node', id: a.nodeId })
                  focusN.current += 1
                  setFocus({ id: a.nodeId, n: focusN.current })
                }}
              >
                <span className="tr-alert-l1">
                  <span className="tr-alert-sev">{a.state === 'cleared' ? 'Resolved' : (SEV_RANK[a.severity] ?? 0) >= 3 ? `Severe · ${a.severity}` : `Minor · ${a.severity}`}</span>
                  <span className="tr-alert-ts">{hhmm(a.ts)}</span>
                </span>
                <span className="tr-alert-node">{a.label}</span>
                <span className="tr-alert-title">{a.title}</span>
              </button>
            ))}
          </section>
        )}

        {selNode && (
          <section className="tr-panel" aria-label="station detail">
            <div className="tr-panel-h">
              <span className="tr-panel-title">{selNode.label}</span>
              <span className="tr-panel-sub">{selNode.role} · {selNode.status}</span>
            </div>
            <dl className="tr-kv">
              <dt>private</dt><dd>{selNode.privateIp}</dd>
              <dt>public</dt><dd>{selNode.publicIp}</dd>
              <dt>linode</dt><dd>{selNode.region} · {selNode.type}</dd>
              {selNode.status === 'running' && (<>
                <dt>cpu</dt><dd className={selNode.cpu > 0.9 ? 'is-red' : ''}>{Math.round(selNode.cpu * 100)}%</dd>
                <dt>mem</dt><dd>{fmtMem(selNode.memUsed, selNode.memTotal)}</dd>
                <dt>load1</dt><dd>{selNode.load1}</dd>
              </>)}
            </dl>

            <div className="tr-sec">Disruptions · {(selNode.issues ?? []).length}</div>
            {(selNode.issues ?? []).length === 0 && <div className="tr-none">Good service — none reported</div>}
            {sortedIssues(selNode).map((i) => (
              <div key={i.id} className={`tr-issue ${sevClass(i.severity)}`}>
                <div className="tr-issue-l1"><span className="tr-issue-sev">{i.severity}</span>{i.title}</div>
                <div className="tr-issue-d" title={i.detail}>{i.detail}</div>
                <div className="tr-issue-m">held {held(i.since, now)} · {i.source}{i.file ? ` · ${i.file}` : ''}</div>
              </div>
            ))}

            <div className="tr-sec">Processes</div>
            {selNode.processes.length === 0 && <div className="tr-none">—</div>}
            {selNode.processes.map((p) => (
              <div key={`${p.pid}-${p.name}`} className="tr-proc">
                <span>{p.name}</span><span className="tr-dim">{p.pid}</span><span>{p.ports.length ? ':' + p.ports.join(',') : ''}</span>
              </div>
            ))}

            {code && (<>
              <div className="tr-sec">Platforms · {code.root}</div>
              {code.files.slice().sort((a, b) => b.loc - a.loc).map((f) => {
                const fi = fileIssues(selNode, f.path)
                const port = code.ports.filter((q) => q.file === f.path).map((q) => `${q.dir}:${q.port}`).join(' ')
                const isSel = selected?.kind === 'node' && selected.file === f.path
                return (
                  <button key={f.path} type="button" className={`tr-file ${isSel ? 'is-sel' : ''}`} title={f.path}
                    onClick={() => setSelected({ kind: 'node', id: selNode.id, file: f.path })}>
                    <span className="tr-file-p">{f.path}</span>
                    <span className="tr-dim">{f.loc}</span>
                    <span className="tr-file-port">{port}</span>
                    {fi.length > 0 && <span className={`tr-file-badge ${sevClass(fi[0].severity)}`}>{fi.length > 1 ? `!${fi.length}` : '!'}</span>}
                  </button>
                )
              })}
            </>)}

            {canDelete(selNode) && (
              <button type="button" className="tr-destroy" onClick={() => { setTyped(''); setConfirm(selNode) }}>
                DESTROY SERVER
              </button>
            )}
          </section>
        )}

        {selLink && (
          <section className="tr-panel" aria-label="line detail">
            <div className="tr-panel-h" style={{ borderTopColor: LINES[lineKey(selLink.protocol)].color }}>
              <span className="tr-panel-title">{LINES[lineKey(selLink.protocol)].name} line · {selLink.protocol} :{selLink.port}</span>
              <span className="tr-panel-sub">{byId.get(selLink.source)?.label ?? selLink.source} → {byId.get(selLink.target)?.label ?? selLink.target}</span>
            </div>
            <dl className="tr-kv">
              <dt>conns</dt><dd>{selLink.conns}</dd>
              <dt>fwd</dt><dd>{fmtRate(selLink.bytesPerSec)}</dd>
              <dt>rev</dt><dd>{fmtRate(selLink.bytesPerSecReverse)}</dd>
              <dt>id</dt><dd className="tr-dim">{selLink.id}</dd>
            </dl>
          </section>
        )}
      </div>

      {(fl.source === 'offline' || fl.source === 'connecting') && !fleet && (
        <div className="tr-nofeed" role="status">
          <div className="tr-nofeed-h">{fl.source === 'offline' ? 'No service — telemetry offline at :8090' : 'Linking — waiting for :8090'}</div>
          <div className="tr-nofeed-sub">nothing is drawn without real data · retrying every 2.5s</div>
          <button type="button" className="tr-btn" onClick={fl.retry}>RETRY NOW</button>
          <div className="tr-nofeed-sub">offline demo: open with <code>&amp;sim=1</code></div>
        </div>
      )}

      {confirm && (
        <div className="tr-modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) setConfirm(null) }}>
          <div className="tr-modal" role="dialog" aria-modal="true" aria-label="destroy server">
            <div className="tr-modal-h">DESTROY SERVER</div>
            <p className="tr-modal-p">
              This permanently deletes the Linode server <b>{confirm.label}</b> ({confirm.publicIp}, {confirm.region}, {confirm.type}).
              Its disk and everything on it is destroyed. This cannot be undone.
            </p>
            {fl.source === 'sim' && <p className="tr-modal-p tr-dim">SIM mode: simulated, no real server is touched.</p>}
            <label className="tr-modal-l" htmlFor="tr-confirm">type <b>{confirm.label}</b> to confirm</label>
            <input
              id="tr-confirm"
              className="tr-input"
              autoFocus
              autoComplete="off"
              spellCheck={false}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void destroy() }}
            />
            <div className="tr-modal-a">
              <button type="button" className="tr-btn" onClick={() => setConfirm(null)}>CANCEL</button>
              <button type="button" className="tr-btn tr-btn-red" disabled={typed !== confirm.label} onClick={() => void destroy()}>
                DESTROY {confirm.label}
              </button>
            </div>
          </div>
        </div>
      )}

      <footer className="tr-board" aria-label="announcements">
        <div className="tr-board-h">
          <span>Announcements</span>
          <span className="tr-board-clock">{hhmm(now)}</span>
        </div>
        <div className="tr-board-rows">
          {logLines.length === 0 && (
            <div className="tr-board-row is-head">
              <span className="tr-board-ts">{hhmm(now)}</span>
              <span className="tr-board-src">ari</span>
              <span className="tr-board-msg">{feedUp ? 'fleet feed linked' : 'waiting for telemetry at :8090…'}</span>
            </div>
          )}
          {logLines.map((l, i) => (
            <div className={`tr-board-row ${i === logLines.length - 1 ? 'is-head' : ''} ${l.err ? 'is-err' : ''}`} key={`${l.ts}-${i}`}>
              <span className="tr-board-ts">{hhmm(l.ts)}</span>
              <span className="tr-board-src">{l.src}</span>
              <span className="tr-board-msg" title={l.text}>{l.text}</span>
            </div>
          ))}
        </div>
      </footer>
    </div>
  )
}

function Readout({ label, value, warn, good }: { label: string; value: string; warn?: boolean; good?: boolean }) {
  return (
    <div className={`tr-read ${warn ? 'is-warn' : ''} ${good ? 'is-good' : ''}`}>
      <span className="tr-read-k">{label}</span>
      <span className="tr-read-v">{value}</span>
    </div>
  )
}
