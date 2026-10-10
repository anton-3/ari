import { Component, useEffect, useMemo, useRef, useState } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import PcbView, { NET_COLOR, PART } from './PcbView'
import type { Sel } from './PcbView'
import { ACTIVE_AGENT, codeFor, fileIssues, fmtMem, fmtRate } from '../../graph/GraphView'
import { forgetPos } from '../../graph/positions'
import { toMs, useFleet } from '../../graph/useFleet'
import { useTelemetry } from '../../graph/useTelemetry'
import type { FleetIssue, FleetLogLine, FleetNode } from '../../graph/types'
import './pcb.css'

export const meta = {
  title: 'PCB',
  inspiration:
    'The fleet as a printed circuit board: black FR-4 with clear mask (OSH Park "After Dark"), ENIG pads, white silkscreen and a KiCad-style dot grid. Servers are IC packages with a pin per real port, links are copper differential pairs carrying current pulses, expanding a node decaps the chip.',
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

const sevClass = (s: string) => ((SEV_RANK[s] ?? 0) >= 3 ? 'is-red' : 'is-amber')

// split a byte rate into an LCD value + unit
function rateParts(bps: number): [string, string] {
  if (bps < 1024) return [String(Math.round(bps)), 'B/s']
  if (bps < 1024 * 1024) return [(bps / 1024).toFixed(1), 'KB/s']
  return [(bps / 1024 / 1024).toFixed(2), 'MB/s']
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ari pcb] render error', error, info.componentStack)
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="pcb-nofeed" role="alert">
        <div className="pcb-nofeed-h">BOARD RENDER FAULT</div>
        <div className="pcb-nofeed-sub">{this.state.error.message}</div>
        <button type="button" className="pcb-btn" onClick={() => this.setState({ error: null })}>REDRAW BOARD</button>
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

  // Deep link: &node=<label> selects (and, for code-running roles, decaps) a part once it appears.
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

  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  })

  // ---- HUD numbers (all from the feed) ---------------------------------------
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
  const [thruV, thruU] = rateParts(thru)

  const logLines = useMemo(() => {
    const all: { ts: number; src: string; text: string; err: boolean }[] = [
      ...tel.reasoning.map((r) => ({ ts: toMs(r.ts), src: 'ari', text: r.text, err: false })),
      ...fl.log.map((l) => ({ ts: l.ts, src: 'fleet', text: l.text, err: l.level === 'error' })),
      ...jobLog.map((l) => ({ ts: l.ts, src: 'check', text: l.text, err: false })),
    ]
    return all.sort((a, b) => a.ts - b.ts).slice(-8)
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
  const feedLabel = fl.source === 'live' ? 'FLEET LIVE' : fl.source === 'sim' ? 'SIM · simulated fleet' : fl.source === 'offline' ? 'NO FEED' : 'LINKING…'

  return (
    <div className={`look-pcb ${reduced ? 'is-reduced' : ''}`}>
      <ErrorBoundary>
        <PcbView
          fleet={fleet}
          agents={agents}
          metrics={m}
          codemap={fl.codemap}
          live={live}
          reduced={reduced}
          rightInset={selNode || selLink || shownAlerts.length > 0 ? 336 : 40}
          showControl={showControl}
          selected={selected}
          focus={focus}
          onSelect={setSelected}
          onDropRole={(role, x, y) => fl.addNode(role, { x, y })}
        />
      </ErrorBoundary>

      <header className="pcb-bar">
        <div className="pcb-id">
          <span className="pcb-id-chip" aria-hidden><i /><i /><i /></span>
          <span className="pcb-id-name">ARI</span>
          <span className="pcb-id-file">ari-net-fleet.kicad_pcb</span>
          <span className="pcb-id-sub">drag parts · wheel zoom · dbl-click fit · del destroys</span>
        </div>
        <div className="pcb-bar-right">
          <div className={`pcb-feed pcb-feed--${fl.source}`}>
            <span className="pcb-led" />
            {feedLabel}
          </div>
          {!SIM && (
            <div className={`pcb-feed pcb-feed--${tel.source === 'live' || tel.source === 'polling' ? 'live' : 'offline'}`}>
              <span className="pcb-led" />
              {tel.source === 'live' ? 'METRICS WS' : tel.source === 'polling' ? 'METRICS POLL' : 'METRICS —'}
            </div>
          )}
        </div>
      </header>

      {/* ---- multimeter readout strip ---- */}
      <section className="pcb-hud" aria-label="fleet readout">
        <Meter label="THRU" value={thruV} unit={thruU} />
        <Meter label="NODES" value={`${counts.run}`} unit={`RUN · ${counts.boot} BOOT · ${counts.off} OFF${counts.del ? ` · ${counts.del} DEL` : ''}`} warn={counts.off > 0} />
        <Meter label="ISSUES" value={String(openIssues)} unit="OPEN" warn={openIssues > 0} />
        {m && <Meter label="REQ/S" value={Math.round(m.rps).toLocaleString()} unit="Hz" />}
        {m && <Meter label="ERR" value={m.errorRate.toFixed(2)} unit="%" warn={m.errorRate > 4} />}
        <Meter label="MODE" value={m ? (surge ? 'SURGE' : 'NOM') : '—'} unit={m ? (surge ? 'OVLD' : 'AUTO') : ''} warn={surge} />
      </section>

      {/* ---- left rail: parts bin + legend ---- */}
      <aside className="pcb-rail" aria-label="add node">
        <div className="pcb-rail-h">PARTS BIN <span>+ place</span></div>
        {addable.length === 0 && <div className="pcb-rail-empty">{feedUp ? 'no addable roles' : 'no feed'}</div>}
        {addable.map((r) => (
          <button
            key={r.role}
            type="button"
            className="pcb-role"
            draggable={feedUp}
            disabled={!feedUp}
            title={`${r.description} — click to add, or drag onto the board`}
            onClick={() => fl.addNode(r.role)}
            onDragStart={(e) => {
              e.dataTransfer.setData('text/ari-role', r.role)
              e.dataTransfer.effectAllowed = 'copy'
            }}
          >
            <span className="pcb-role-ic" aria-hidden><b>{PART[r.role]?.glyph ?? r.role.slice(0, 3).toUpperCase()}</b></span>
            <span className="pcb-role-label">{r.label}</span>
          </button>
        ))}

        <button type="button" className="pcb-legend-h" onClick={() => {
          setLegendOpen((v) => {
            try { window.localStorage.setItem('ari.legend', v ? '0' : '1') } catch { /* ignore */ }
            return !v
          })
        }}>
          LEGEND {legendOpen ? '▾' : '▸'}
        </button>
        {legendOpen && (
          <div className="pcb-legend">
            <div className="pcb-lg-row"><i className="pcb-lg-ic" />IC = server · Uₙ designator</div>
            <div className="pcb-lg-row"><i className="pcb-lg-pad" />pin = real port (◂ listen, ▸ dials)</div>
            <div className="pcb-lg-row"><i className="pcb-lg-pair" />copper pair = link (fwd / rev)</div>
            <div className="pcb-lg-sep" />
            <div className="pcb-lg-row"><i className="pcb-lg-dot" style={{ background: NET_COLOR.http }} />current · http</div>
            <div className="pcb-lg-row"><i className="pcb-lg-dot" style={{ background: NET_COLOR.postgres }} />current · postgres :5432</div>
            <div className="pcb-lg-row"><i className="pcb-lg-dot" style={{ background: NET_COLOR.redis }} />current · redis :6379</div>
            <div className="pcb-lg-row"><i className="pcb-lg-rats" />ratsnest · ssh / control</div>
            <div className="pcb-lg-sep" />
            <div className="pcb-lg-row"><i className="pcb-lg-led is-green" />PWR led · running</div>
            <div className="pcb-lg-row"><i className="pcb-lg-led is-red" />FLT led · critical / high</div>
            <div className="pcb-lg-row"><i className="pcb-lg-led is-amber" />FLT led · medium / low</div>
            <div className="pcb-lg-row"><b className="pcb-lg-badge">▲!3</b>open issues (backend)</div>
            <div className="pcb-lg-row"><i className="pcb-lg-tp" />TP = running check job</div>
            <label className="pcb-lg-row pcb-lg-check">
              <input
                type="checkbox"
                checked={showControl}
                onChange={(e) => {
                  const v = e.target.checked
                  setShowControl(v)
                  try { window.localStorage.setItem('ari.showControl', v ? '1' : '0') } catch { /* ignore */ }
                }}
              />
              show control ratsnest
            </label>
            <div className="pcb-lg-note">pulses = real bytes/s per direction (log); dark copper = no traffic; http trace reddens with error rate</div>
            <div className="pcb-lg-note">click app / worker / traffic to decap: die blocks = files, bond wires = imports</div>
          </div>
        )}
      </aside>

      {/* ---- right column: fault log + datasheet ---- */}
      <div className="pcb-side">
        {shownAlerts.length > 0 && (
          <section className="pcb-alerts" aria-label="alerts">
            <div className="pcb-sec-h">FAULT LOG <span>{openAlerts} open</span></div>
            {shownAlerts.map((a) => (
              <button
                key={a.id}
                type="button"
                className={`pcb-alert ${sevClass(a.severity)} ${a.state === 'cleared' ? 'is-cleared' : ''}`}
                onClick={() => {
                  if (!byId.has(a.nodeId)) return
                  setSelected({ kind: 'node', id: a.nodeId })
                  focusN.current += 1
                  setFocus({ id: a.nodeId, n: focusN.current })
                }}
              >
                <span className="pcb-alert-l1">
                  <span className="pcb-alert-ts">{hhmmss(a.ts)}</span>
                  <span className="pcb-alert-sev">{a.state === 'cleared' ? 'CLEARED' : a.severity.toUpperCase()}</span>
                  <span className="pcb-alert-node">{a.label}</span>
                </span>
                <span className="pcb-alert-title">{a.title}</span>
              </button>
            ))}
          </section>
        )}

        {selNode && (
          <section className="pcb-panel" aria-label="node detail">
            <div className="pcb-panel-h">
              <span className="pcb-panel-k">DATASHEET</span>
              <span className="pcb-panel-title">{selNode.label}</span>
              <span className="pcb-panel-sub">{selNode.role} · {selNode.status}</span>
            </div>
            <dl className="pcb-kv">
              <dt>private</dt><dd>{selNode.privateIp}</dd>
              <dt>public</dt><dd>{selNode.publicIp}</dd>
              <dt>linode</dt><dd>{selNode.region} · {selNode.type}</dd>
              {selNode.status === 'running' && (<>
                <dt>cpu</dt><dd className={selNode.cpu > 0.9 ? 'is-red' : ''}>{Math.round(selNode.cpu * 100)}%</dd>
                <dt>mem</dt><dd>{fmtMem(selNode.memUsed, selNode.memTotal)}</dd>
                <dt>load1</dt><dd>{selNode.load1}</dd>
              </>)}
            </dl>

            <div className="pcb-sec-h">ISSUES <span>{(selNode.issues ?? []).length}</span></div>
            {(selNode.issues ?? []).length === 0 && <div className="pcb-none">none reported</div>}
            {sortedIssues(selNode).map((i) => (
              <div key={i.id} className={`pcb-issue ${sevClass(i.severity)}`}>
                <div className="pcb-issue-l1"><span className="pcb-issue-sev">{i.severity.toUpperCase()}</span>{i.title}</div>
                <div className="pcb-issue-d" title={i.detail}>{i.detail}</div>
                <div className="pcb-issue-m">held {held(i.since, now)} · {i.source}{i.file ? ` · ${i.file}` : ''}</div>
              </div>
            ))}

            <div className="pcb-sec-h">PIN TABLE · PROCESSES</div>
            {selNode.processes.length === 0 && <div className="pcb-none">—</div>}
            {selNode.processes.map((p) => (
              <div key={`${p.pid}-${p.name}`} className="pcb-proc">
                <span>{p.name}</span><span className="pcb-dim">{p.pid}</span><span className="pcb-port">{p.ports.length ? ':' + p.ports.join(',') : ''}</span>
              </div>
            ))}

            {code && (<>
              <div className="pcb-sec-h">DIE · {code.root}</div>
              {code.files.slice().sort((a, b) => b.loc - a.loc).map((f) => {
                const fi = fileIssues(selNode, f.path)
                const port = code.ports.filter((q) => q.file === f.path).map((q) => `${q.dir}:${q.port}`).join(' ')
                const isSel = selected?.kind === 'node' && selected.file === f.path
                return (
                  <button key={f.path} type="button" className={`pcb-file ${isSel ? 'is-sel' : ''}`} title={f.path}
                    onClick={() => setSelected({ kind: 'node', id: selNode.id, file: f.path })}>
                    <span className="pcb-file-p">{f.path}</span>
                    <span className="pcb-dim">{f.loc}</span>
                    <span className="pcb-port">{port}</span>
                    {fi.length > 0 && <span className={`pcb-file-badge ${sevClass(fi[0].severity)}`}>{fi.length > 1 ? `!${fi.length}` : '!'}</span>}
                  </button>
                )
              })}
            </>)}

            {canDelete(selNode) && (
              <button type="button" className="pcb-destroy" onClick={() => { setTyped(''); setConfirm(selNode) }}>
                DESTROY SERVER
              </button>
            )}
          </section>
        )}

        {selLink && (
          <section className="pcb-panel" aria-label="link detail">
            <div className="pcb-panel-h">
              <span className="pcb-panel-k">NET</span>
              <span className="pcb-panel-title">{selLink.protocol} :{selLink.port}</span>
              <span className="pcb-panel-sub">{byId.get(selLink.source)?.label ?? selLink.source} → {byId.get(selLink.target)?.label ?? selLink.target}</span>
            </div>
            <dl className="pcb-kv">
              <dt>conns</dt><dd>{selLink.conns}</dd>
              <dt>fwd</dt><dd>{fmtRate(selLink.bytesPerSec)}</dd>
              <dt>rev</dt><dd>{fmtRate(selLink.bytesPerSecReverse)}</dd>
              <dt>id</dt><dd className="pcb-dim">{selLink.id}</dd>
            </dl>
          </section>
        )}
      </div>

      {(fl.source === 'offline' || fl.source === 'connecting') && !fleet && (
        <div className="pcb-nofeed" role="status">
          <div className="pcb-nofeed-h">{fl.source === 'offline' ? 'NO FEED — telemetry offline at :8090' : 'LINKING — waiting for :8090'}</div>
          <div className="pcb-nofeed-sub">no parts are placed without real data · retrying every 2.5s</div>
          <button type="button" className="pcb-btn" onClick={fl.retry}>RETRY NOW</button>
          <div className="pcb-nofeed-sub">offline demo: open with <code>&amp;sim=1</code></div>
        </div>
      )}

      {confirm && (
        <div className="pcb-modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) setConfirm(null) }}>
          <div className="pcb-modal" role="dialog" aria-modal="true" aria-label="destroy server">
            <div className="pcb-modal-h">DESTROY SERVER</div>
            <p className="pcb-modal-p">
              This permanently deletes the Linode server <b>{confirm.label}</b> ({confirm.publicIp}, {confirm.region}, {confirm.type}).
              Its disk and everything on it is destroyed. This cannot be undone.
            </p>
            {fl.source === 'sim' && <p className="pcb-modal-p pcb-dim">SIM mode: simulated, no real server is touched.</p>}
            <label className="pcb-modal-l" htmlFor="pcb-confirm">type <b>{confirm.label}</b> to confirm</label>
            <input
              id="pcb-confirm"
              className="pcb-input"
              autoFocus
              autoComplete="off"
              spellCheck={false}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void destroy() }}
            />
            <div className="pcb-modal-a">
              <button type="button" className="pcb-btn" onClick={() => setConfirm(null)}>CANCEL</button>
              <button type="button" className="pcb-btn pcb-btn-red" disabled={typed !== confirm.label} onClick={() => void destroy()}>
                DESTROY {confirm.label}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---- serial console ---- */}
      <footer className="pcb-console" aria-label="log">
        <div className="pcb-console-h">
          <span><i className={`pcb-led ${feedUp ? 'is-on' : ''}`} /> SERIAL · ttyARI0</span>
          <span>115200 8N1</span>
          <span>{fl.source === 'sim' ? 'SIM' : feedUp ? 'RX' : 'NO CARRIER'}</span>
        </div>
        <div className="pcb-console-body" ref={logRef}>
          {logLines.length === 0 && (
            <div className="pcb-log-line is-head">
              <span className="pcb-log-ts">[{hhmmss(now)}]</span>
              <span className="pcb-log-src">ari&gt;</span>
              <span className="pcb-log-msg">{feedUp ? 'fleet feed linked' : 'waiting for telemetry at :8090…'}</span>
            </div>
          )}
          {logLines.map((l, i) => (
            <div className={`pcb-log-line ${i === logLines.length - 1 ? 'is-head' : ''} ${l.err ? 'is-err' : ''}`} key={`${l.ts}-${i}`}>
              <span className="pcb-log-ts">[{hhmmss(l.ts)}]</span>
              <span className="pcb-log-src">{l.src}&gt;</span>
              <span className="pcb-log-msg" title={l.text}>{l.text}</span>
            </div>
          ))}
        </div>
      </footer>
    </div>
  )
}

function Meter({ label, value, unit, warn }: { label: string; value: string; unit: string; warn?: boolean }) {
  return (
    <div className={`pcb-meter ${warn ? 'is-warn' : ''}`}>
      <span className="pcb-meter-k">{label}</span>
      <span className="pcb-meter-lcd">
        <span className="pcb-meter-v">{value}</span>
        <span className="pcb-meter-u">{unit}</span>
      </span>
    </div>
  )
}
