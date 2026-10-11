import { useEffect, useMemo, useRef, useState } from 'react'
import ErrorBoundary from './ErrorBoundary'
import IsoView, { KIND_COLOR, PROTO_COLOR, ROLE } from './IsoView'
import type { IsoSel } from './IsoView'
import { ACTIVE_AGENT, codeFor, fileIssues, fmtMem, fmtRate } from './helpers'
import { chainOf, errFrac, issuesUnder, itemsOf, resolveSegments, routeOf, treeFor } from './codetree'
import type { TItem } from './codetree'
import { forgetPos } from './positions'
import { toMs, useFleet } from './useFleet'
import { useTelemetry } from './useTelemetry'
import type { FleetIssue, FleetLogLine, FleetNode } from './types'
import './graph.css'

type Sel = IsoSel

const SIM = (() => {
  try {
    return new URLSearchParams(window.location.search).get('sim') === '1'
  } catch {
    return false
  }
})()

// ?node=<label>&path=<seg>/<seg>… — split the RAW value on "/" so encoded slashes stay inside a segment
const DEEP_LINK: { node: string; segs: string[] } | null = (() => {
  try {
    const q = new URLSearchParams(window.location.search)
    const node = q.get('node')
    if (!node) return null
    const raw = /[?&]path=([^&]*)/.exec(window.location.search)?.[1] ?? ''
    const segs = raw ? raw.split('/').filter(Boolean).map((x) => decodeURIComponent(x.replace(/\+/g, ' '))) : []
    return { node, segs }
  } catch {
    return null
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

export default function Graph() {
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

  // Running check jobs → teletype lines (start + finish). Real jobs on real nodes only.
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

  // Deep link: ?node=<label>[&path=file/symbol/child] selects a server once it appears and
  // opens down the given path (segments split on raw "/", each URI-decoded, so
  // "GET%20%2Fapi%2Ftransactions" stays one segment).
  // Stops as soon as the path fully resolves, the user selects something, or after 30s.
  const deepLink = useRef<{ node: string; segs: string[]; applied: number; t0: number } | null>(
    DEEP_LINK ? { ...DEEP_LINK, applied: -1, t0: 0 } : null,
  )
  useEffect(() => {
    const want = deepLink.current
    if (!want || !fleet) return
    if (!want.t0) want.t0 = Date.now()
    if (Date.now() - want.t0 > 30000) { deepLink.current = null; return }
    const n = fleet.nodes.find((x) => x.label === want.node || x.id === want.node)
    if (!n) return
    const r = resolveSegments(treeFor(fl.codemap, n.role), want.segs)
    if (r.keys.length > want.applied) {
      want.applied = r.keys.length
      setSelected({ kind: 'node', id: n.id, path: r.keys })
    }
    if (r.complete) deepLink.current = null
  }, [fleet, fl.codemap])
  const select = (s: Sel | null) => {
    deepLink.current = null
    setSelected(s)
  }

  // Drop selection when its node/link disappears.
  useEffect(() => {
    if (!selected) return
    if (selected.kind === 'node' && !byId.has(selected.id)) setSelected(null)
    if (selected.kind === 'link' && !(fleet?.links ?? []).some((l) => l.id === selected.id)) setSelected(null)
  }, [byId, fleet, selected])

  const selNode = selected?.kind === 'node' ? byId.get(selected.id) : undefined
  const selLink = selected?.kind === 'link' ? fleet?.links.find((l) => l.id === selected.id) : undefined


  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  })

  // ---- HUD numbers (all from the feed) -------------------------------------
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

  // ---- log: reasoning + fleet API + check jobs, by time --------------------
  const logLines = useMemo(() => {
    const all: { ts: number; src: string; text: string; err: boolean }[] = [
      ...tel.reasoning.map((r) => ({ ts: toMs(r.ts), src: 'ari', text: r.text, err: false })),
      ...fl.log.map((l) => ({ ts: l.ts, src: 'fleet', text: l.text, err: l.level === 'error' })),
      ...jobLog.map((l) => ({ ts: l.ts, src: 'check', text: l.text, err: false })),
    ]
    return all.sort((a, b) => a.ts - b.ts).slice(-6)
  }, [tel.reasoning, fl.log, jobLog])

  // ---- alerts: open ones + recently cleared (8s) ---------------------------
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
  const tree = selNode ? treeFor(fl.codemap, selNode.role) : null
  const selPath = selected?.kind === 'node' ? selected.path ?? [] : []
  const selItems = itemsOf(tree, selPath)
  const selItem: TItem | undefined = selItems[selItems.length - 1]
  const escUp = (cur: Sel | null): Sel | null => {
    if (!cur || cur.kind !== 'node') return null
    const items = itemsOf(treeFor(fl.codemap, byId.get(cur.id)?.role ?? ''), cur.path ?? [])
    if (!items.length) return null
    // a selected leaf closes the level it sits on; an open item closes itself
    const drop = items[items.length - 1].children.length ? 1 : 2
    return { kind: 'node', id: cur.id, path: items.slice(0, Math.max(0, items.length - drop)).map((i) => i.key) }
  }
  const goPath = (keys: string[]) => { if (selNode) select({ kind: 'node', id: selNode.id, path: keys }) }

  // Keyboard: Delete/Backspace opens the destroy dialog, Esc collapses/deselects.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        if (e.key === 'Escape') setConfirm(null)
        return
      }
      if (e.key === 'Escape') {
        if (confirm) setConfirm(null)
        else setSelected((cur) => escUp(cur))
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && !confirm && canDelete(selNode)) {
        e.preventDefault()
        setTyped('')
        setConfirm(selNode!)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirm, selNode, escUp])

  return (
    <div className="iso-map">
      <ErrorBoundary>
      <IsoView
        fleet={fleet}
        agents={agents}
        metrics={m}
        codemap={fl.codemap}
        live={live}
        reduced={reduced}
        rightInset={selNode || selLink || shownAlerts.length > 0 ? 332 : 40}
        showControl={showControl}
        selected={selected}
        focus={focus}
        onSelect={select}
        onDropRole={(role, x, y) => fl.addNode(role, { x, y })}
      />
      </ErrorBoundary>

      <header className="iso-bar">
        <div className="iso-id">
          <IsoGlyph role="app" size={18} />
          <span className="iso-id-name">ARI</span>
          {selNode ? (
            <nav className="iso-crumbs" aria-label="open path">
              <button type="button" className={`iso-crumb ${selItems.length === 0 ? 'is-cur' : ''}`} onClick={() => goPath([])}>{selNode.label}</button>
              {selItems.map((it, i) => (
                <span key={it.key} className="iso-crumb-wrap">
                  <span className="iso-crumb-sep" aria-hidden>›</span>
                  <button type="button" className={`iso-crumb ${i === selItems.length - 1 ? 'is-cur' : ''}`} title={it.kind === 'file' ? it.key : `${it.kind} · ${it.label}`}
                    onClick={() => goPath(selItems.slice(0, i + 1).map((x) => x.key))}>{it.label}</button>
                </span>
              ))}
              <span className="iso-crumb-hint">esc steps out</span>
            </nav>
          ) : (
            <span className="iso-id-sub">isometric fleet map · click to open · drag to move on grid · wheel zoom · dbl-click fit · del destroys</span>
          )}
        </div>
        <div className="iso-bar-right">
          <div className={`iso-feed iso-feed--${fl.source}`}>
            <span className="iso-feed-dot" />
            {fl.source === 'live' ? 'FLEET LIVE' : fl.source === 'sim' ? 'SIM · simulated fleet' : fl.source === 'offline' ? 'NO FEED' : 'LINKING…'}
          </div>
          {!SIM && (
            <div className={`iso-feed iso-feed--${tel.source === 'live' || tel.source === 'polling' ? 'live' : 'offline'}`}>
              <span className="iso-feed-dot" />
              {tel.source === 'live' ? 'METRICS WS' : tel.source === 'polling' ? 'METRICS POLL' : 'METRICS —'}
            </div>
          )}
        </div>
      </header>

      <section className="iso-hud" aria-label="fleet readout">
        <Readout label="THRU" value={fmtRate(thru)} />
        <Readout label="NODES" value={`${counts.run} run · ${counts.boot} boot · ${counts.off} off${counts.del ? ` · ${counts.del} del` : ''}`} warn={counts.off > 0} />
        <Readout label="ISSUES" value={String(openIssues)} warn={openIssues > 0} />
        {m && <Readout label="REQ/S" value={Math.round(m.rps).toLocaleString()} />}
        {m && <Readout label="ERR" value={`${m.errorRate.toFixed(2)}%`} warn={m.errorRate > 4} />}
        <Readout label="MODE" value={m ? (surge ? 'SURGE' : 'NOMINAL') : '—'} warn={surge} />
      </section>

      {/* ---- left rail: add node + legend ---- */}
      <aside className="iso-rail" aria-label="add node">
        <div className="iso-rail-h">+ NODE</div>
        {addable.length === 0 && <div className="iso-rail-empty">{feedUp ? 'no addable roles' : 'no feed'}</div>}
        {addable.map((r) => (
          <button
            key={r.role}
            type="button"
            className="iso-role"
            draggable={feedUp}
            disabled={!feedUp}
            title={`${r.description} — click to add, or drag onto the map`}
            onClick={() => fl.addNode(r.role)}
            onDragStart={(e) => {
              e.dataTransfer.setData('text/ari-role', r.role)
              e.dataTransfer.effectAllowed = 'copy'
            }}
          >
            <IsoGlyph role={r.role} size={22} />
            <span className="iso-role-label">{r.label}</span>
          </button>
        ))}

        <button type="button" className="iso-legend-h" onClick={() => {
          setLegendOpen((v) => {
            try { window.localStorage.setItem('ari.legend', v ? '0' : '1') } catch { /* ignore */ }
            return !v
          })
        }}>
          LEGEND {legendOpen ? '▾' : '▸'}
        </button>
        {legendOpen && (
          <div className="iso-legend">
            {(['traffic', 'lb', 'app', 'worker', 'db', 'cache', 'controller'] as const).map((r) => (
              <div key={r} className="iso-lg-row"><IsoGlyph role={r} size={16} />{LEGEND_NAME[r]}</div>
            ))}
            <div className="iso-lg-sep" />
            <div className="iso-lg-row"><i className="iso-sw is-red" />critical / high issue</div>
            <div className="iso-lg-row"><i className="iso-sw is-amber" />medium / low issue</div>
            <div className="iso-lg-row"><b className="iso-lg-badge">!3</b>open issues from the backend</div>
            <div className="iso-lg-sep" />
            <div className="iso-lg-row"><i className="iso-ln" style={{ background: PROTO_COLOR.http }} />http</div>
            <div className="iso-lg-row"><i className="iso-ln" style={{ background: PROTO_COLOR.postgres }} />postgres :5432</div>
            <div className="iso-lg-row"><i className="iso-ln" style={{ background: PROTO_COLOR.redis }} />redis :6379</div>
            <div className="iso-lg-row"><i className="iso-ln is-dash" />ssh / control</div>
            <label className="iso-lg-row iso-lg-check">
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
            <div className="iso-lg-note">hidden by default; shown for the hovered/selected node or one with a running check</div>
            <div className="iso-lg-note">moving dashes = real bytes/s per direction (log scale); no dashes = no traffic</div>
            <div className="iso-lg-note">ring on the ground = running check job · click app/worker/traffic to open into files</div>
          </div>
        )}
      </aside>

      {/* ---- right column: alerts + detail panel ---- */}
      <div className="iso-side">
        {shownAlerts.length > 0 && (
          <section className="iso-alerts" aria-label="alerts">
            <div className="iso-alerts-h">ALERTS · {openAlerts} open</div>
            {shownAlerts.map((a) => (
              <button
                key={a.id}
                type="button"
                className={`iso-alert ${sevClass(a.severity)} ${a.state === 'cleared' ? 'is-cleared' : ''}`}
                onClick={() => {
                  if (!byId.has(a.nodeId)) return
                  setSelected({ kind: 'node', id: a.nodeId })
                  focusN.current += 1
                  setFocus({ id: a.nodeId, n: focusN.current })
                }}
              >
                <span className="iso-alert-l1">
                  <span className="iso-alert-ts">{hhmmss(a.ts)}</span>
                  <span className="iso-alert-sev">{a.state === 'cleared' ? 'CLEARED' : a.severity.toUpperCase()}</span>
                  <span className="iso-alert-node">{a.label}</span>
                </span>
                <span className="iso-alert-title">{a.title}</span>
              </button>
            ))}
          </section>
        )}

        {selNode && (
          <section className="iso-panel" aria-label="node detail">
            <div className="iso-panel-h">
              <span className="iso-panel-title">{selNode.label}</span>
              <span className="iso-panel-sub">{selNode.role} · {selNode.status}</span>
            </div>
            {selItem && tree && (
              <ItemDetail item={selItem} node={selNode} tree={tree} onGo={(keys) => goPath(keys)} />
            )}
            <dl className="iso-kv">
              <dt>private</dt><dd>{selNode.privateIp}</dd>
              <dt>public</dt><dd>{selNode.publicIp}</dd>
              <dt>linode</dt><dd>{selNode.region} · {selNode.type}</dd>
              {selNode.status === 'running' && (<>
                <dt>cpu</dt><dd className={selNode.cpu > 0.9 ? 'is-red' : ''}>{Math.round(selNode.cpu * 100)}%</dd>
                <dt>mem</dt><dd>{fmtMem(selNode.memUsed, selNode.memTotal)}</dd>
                <dt>load1</dt><dd>{selNode.load1}</dd>
              </>)}
            </dl>

            <div className="iso-sec">ISSUES · {(selNode.issues ?? []).length}</div>
            {(selNode.issues ?? []).length === 0 && <div className="iso-none">none reported</div>}
            {sortedIssues(selNode).map((i) => (
              <div key={i.id} className={`iso-issue ${sevClass(i.severity)}`}>
                <div className="iso-issue-l1"><span className="iso-issue-sev">{i.severity.toUpperCase()}</span>{i.title}</div>
                <div className="iso-issue-d" title={i.detail}>{i.detail}</div>
                <div className="iso-issue-m">held {held(i.since, now)} · {i.source}{i.file ? ` · ${i.file}` : ''}</div>
              </div>
            ))}

            <div className="iso-sec">PROCESSES</div>
            {selNode.processes.length === 0 && <div className="iso-none">—</div>}
            {selNode.processes.map((p) => (
              <div key={`${p.pid}-${p.name}`} className="iso-proc">
                <span>{p.name}</span><span className="iso-dim">{p.pid}</span><span>{p.ports.length ? ':' + p.ports.join(',') : ''}</span>
              </div>
            ))}

            {code && (<>
              <div className="iso-sec">FILES · {code.root}</div>
              {code.files.slice().sort((a, b) => b.loc - a.loc).map((f) => {
                const fi = fileIssues(selNode, f.path)
                const port = code.ports.filter((q) => q.file === f.path).map((q) => `${q.dir}:${q.port}`).join(' ')
                const isSel = selPath[0] === f.path
                return (
                  <button key={f.path} type="button" className={`iso-file ${isSel ? 'is-sel' : ''}`} title={f.path}
                    onClick={() => goPath([f.path])}>
                    <span className="iso-file-p">{f.path}</span>
                    <span className="iso-dim">{f.loc}</span>
                    <span className="iso-file-port">{port}</span>
                    {fi.length > 0 && <span className={`iso-file-badge ${sevClass(fi[0].severity)}`}>{fi.length > 1 ? `!${fi.length}` : '!'}</span>}
                  </button>
                )
              })}
            </>)}

            {canDelete(selNode) && (
              <button type="button" className="iso-destroy" onClick={() => { setTyped(''); setConfirm(selNode) }}>
                DESTROY SERVER
              </button>
            )}
          </section>
        )}

        {selLink && (
          <section className="iso-panel" aria-label="link detail">
            <div className="iso-panel-h">
              <span className="iso-panel-title">{selLink.protocol} :{selLink.port}</span>
              <span className="iso-panel-sub">{byId.get(selLink.source)?.label ?? selLink.source} → {byId.get(selLink.target)?.label ?? selLink.target}</span>
            </div>
            <dl className="iso-kv">
              <dt>conns</dt><dd>{selLink.conns}</dd>
              <dt>fwd</dt><dd>{fmtRate(selLink.bytesPerSec)}</dd>
              <dt>rev</dt><dd>{fmtRate(selLink.bytesPerSecReverse)}</dd>
              <dt>id</dt><dd className="iso-dim">{selLink.id}</dd>
            </dl>
          </section>
        )}
      </div>

      {/* ---- no feed ---- */}
      {(fl.source === 'offline' || fl.source === 'connecting') && !fleet && (
        <div className="iso-nofeed" role="status">
          <div className="iso-nofeed-h">{fl.source === 'offline' ? 'NO FEED — telemetry offline at :8090' : 'LINKING — waiting for :8090'}</div>
          <div className="iso-nofeed-sub">nothing is drawn without real data · retrying every 2.5s</div>
          <button type="button" className="iso-btn" onClick={fl.retry}>RETRY NOW</button>
          <div className="iso-nofeed-sub">offline demo: open with <code>?sim=1</code></div>
        </div>
      )}

      {/* ---- destroy confirmation ---- */}
      {confirm && (
        <div className="iso-modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) setConfirm(null) }}>
          <div className="iso-modal" role="dialog" aria-modal="true" aria-label="destroy server">
            <div className="iso-modal-h">DESTROY SERVER</div>
            <p className="iso-modal-p">
              This permanently deletes the Linode server <b>{confirm.label}</b> ({confirm.publicIp}, {confirm.region}, {confirm.type}).
              Its disk and everything on it is destroyed. This cannot be undone.
            </p>
            {fl.source === 'sim' && <p className="iso-modal-p iso-dim">SIM mode: simulated, no real server is touched.</p>}
            <label className="iso-modal-l" htmlFor="iso-confirm">type <b>{confirm.label}</b> to confirm</label>
            <input
              id="iso-confirm"
              className="iso-input"
              autoFocus
              autoComplete="off"
              spellCheck={false}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void destroy() }}
            />
            <div className="iso-modal-a">
              <button type="button" className="iso-btn" onClick={() => setConfirm(null)}>CANCEL</button>
              <button type="button" className="iso-btn iso-btn-red" disabled={typed !== confirm.label} onClick={() => void destroy()}>
                DESTROY {confirm.label}
              </button>
            </div>
          </div>
        </div>
      )}

      <footer className="iso-log" ref={logRef} aria-label="log">
        {logLines.length === 0 && (
          <div className="iso-log-line">
            <span className="iso-log-ts">{hhmmss(now)}</span>
            <span className="iso-log-src">ari</span>
            <span className="iso-log-msg">{feedUp ? 'fleet feed linked' : 'waiting for telemetry at :8090…'}</span>
          </div>
        )}
        {logLines.map((l, i) => (
          <div className={`iso-log-line ${i === logLines.length - 1 ? 'is-head' : ''} ${l.err ? 'is-err' : ''}`} key={`${l.ts}-${i}`}>
            <span className="iso-log-ts">{hhmmss(l.ts)}</span>
            <span className="iso-log-src">{l.src}</span>
            <span className="iso-log-msg" title={l.text}>{l.text}</span>
          </div>
        ))}
      </footer>
    </div>
  )
}

const LEGEND_NAME: Record<string, string> = {
  traffic: 'traffic client', lb: 'load balancer', app: 'app server', worker: 'worker',
  db: 'postgres', cache: 'redis', controller: 'controller',
}

// Tiny isometric block (SVG) in the role's accent, for palette + legend.
function IsoGlyph({ role, size }: { role: string; size: number }) {
  const c = ROLE[role]?.color ?? '#738096'
  const cyl = ROLE[role]?.kind === 'cyl'
  return (
    <svg className="iso-glyph" width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      {cyl ? (<>
        <path d="M4 7 v10 a8 4 0 0 0 16 0 v-10" fill="#d4dbe6" stroke="rgba(40,56,84,.35)" strokeWidth=".8" />
        <ellipse cx="12" cy="7" rx="8" ry="4" fill="#fbfcfe" stroke="rgba(40,56,84,.35)" strokeWidth=".8" />
        <ellipse cx="12" cy="7" rx="4.6" ry="2.3" fill={c} />
      </>) : (<>
        <path d="M12 3 L21 8 L12 13 L3 8 Z" fill="#fbfcfe" stroke="rgba(40,56,84,.35)" strokeWidth=".8" />
        <path d="M3 8 L12 13 L12 21 L3 16 Z" fill="#e1e7ef" stroke="rgba(40,56,84,.35)" strokeWidth=".8" />
        <path d="M21 8 L12 13 L12 21 L21 16 Z" fill="#c6d0dd" stroke="rgba(40,56,84,.35)" strokeWidth=".8" />
        <path d="M12 5.6 L16.5 8 L12 10.4 L7.5 8 Z" fill={c} />
      </>)}
    </svg>
  )
}

function ItemDetail({ item, node, tree, onGo }: { item: TItem; node: FleetNode; tree: NonNullable<ReturnType<typeof treeFor>>; onGo: (keys: string[]) => void }) {
  const keys = chainOf(item)
  const iss = issuesUnder(tree, node.issues ?? [], keys).slice().sort((a, b) => (SEV_RANK[b.severity] ?? 0) - (SEV_RANK[a.severity] ?? 0))
  const stat = routeOf(tree, item)
  const sym = item.sym
  const fileName = item.file.split('/').pop()
  const calls = (sym?.calls ?? []).map((id) => ({ id, it: tree.byKey.get(id) }))
  const callers = sym ? [...tree.byKey.values()].filter((x) => x.sym?.calls?.includes(sym.id)) : []
  const ports = item.kind === 'file' ? tree.role.ports.filter((p) => p.file === item.key) : []
  const col = item.kind === 'file' ? ROLE[node.role]?.color : KIND_COLOR[item.kind]
  return (
    <div className="iso-item">
      <div className="iso-item-h">
        <span className="iso-item-kind" style={{ background: col ?? '#738096' }}>{item.kind}</span>
        <span className="iso-item-name" title={item.label}>{sym?.secret && <LockIcon />}{item.label}</span>
      </div>
      <dl className="iso-kv">
        {item.kind === 'file' ? (<>
          <dt>path</dt><dd>{item.key}</dd>
          <dt>loc</dt><dd>{item.fileInfo?.loc ?? '—'}</dd>
          {ports.length > 0 && (<><dt>ports</dt><dd>{ports.map((p) => `${p.dir} :${p.port}`).join(' · ')}</dd></>)}
          <dt>symbols</dt><dd>{item.children.length || 'none in codemap'}</dd>
        </>) : sym && (<>
          <dt>where</dt><dd>{fileName}:{sym.line}–{sym.endLine}</dd>
          {sym.route && (<><dt>route</dt><dd>{sym.route.method} {sym.route.path}</dd></>)}
          {sym.secret && (<><dt>value</dt><dd className="is-amber">secret · never shown</dd></>)}
          {item.children.length > 0 && (<><dt>inside</dt><dd>{item.children.length} symbols</dd></>)}
        </>)}
        {stat && (<>
          <dt>req/s</dt><dd>{stat.rps.toFixed(stat.rps >= 10 ? 0 : 2)}</dd>
          <dt>errors</dt><dd className={errFrac(stat.errorRate) > 0 ? 'is-red' : ''}>{(errFrac(stat.errorRate) * 100).toFixed(2)}%</dd>
          <dt>p95</dt><dd>{stat.p95ms == null ? '—' : `${stat.p95ms} ms`}</dd>
        </>)}
      </dl>
      {calls.length > 0 && (<>
        <div className="iso-sec">CALLS · {calls.length}</div>
        {calls.map(({ id, it }) => (
          <button key={id} type="button" className="iso-file iso-symrow" disabled={!it} onClick={() => it && onGo(chainOf(it))} title={id}>
            <span className="iso-file-p">{it ? it.label : id}</span>
            <span className="iso-dim">{it ? it.kind : ''}</span>
            <span className="iso-file-port">{it && it.file !== item.file ? it.file.split('/').pop() : ''}</span>
          </button>
        ))}
      </>)}
      {callers.length > 0 && (<>
        <div className="iso-sec">CALLED BY · {callers.length}</div>
        {callers.slice(0, 12).map((it) => (
          <button key={it.key} type="button" className="iso-file iso-symrow" onClick={() => onGo(chainOf(it))} title={it.key}>
            <span className="iso-file-p">{it.label}</span>
            <span className="iso-dim">{it.kind}</span>
            <span className="iso-file-port">{it.file !== item.file ? it.file.split('/').pop() : ''}</span>
          </button>
        ))}
      </>)}
      {item.children.length > 0 && (<>
        <div className="iso-sec">INSIDE · {item.children.length}</div>
        {item.children.map((c) => {
          const ci = issuesUnder(tree, node.issues ?? [], chainOf(c))
          const cs = routeOf(tree, c)
          return (
            <button key={c.key} type="button" className="iso-file iso-symrow" onClick={() => onGo(chainOf(c))} title={c.label}>
              <span className="iso-file-p">{c.sym?.secret && <LockIcon />}{c.label}</span>
              <span className="iso-dim">{c.kind}</span>
              <span className="iso-file-port">{cs ? `${cs.rps.toFixed(cs.rps >= 10 ? 0 : 1)} r/s` : c.children.length ? `${c.children.length} ›` : ''}</span>
              {ci.length > 0 && <span className={`iso-file-badge ${sevClass(ci[0].severity)}`}>{ci.length > 1 ? `!${ci.length}` : '!'}</span>}
            </button>
          )
        })}
      </>)}
      <div className="iso-sec">ISSUES HERE · {iss.length}</div>
      {iss.length === 0 && <div className="iso-none">none reported</div>}
      {iss.map((i) => (
        <div key={i.id} className={`iso-issue ${sevClass(i.severity)}`}>
          <div className="iso-issue-l1"><span className="iso-issue-sev">{i.severity.toUpperCase()}</span>{i.title}</div>
          <div className="iso-issue-d" title={i.detail}>{i.detail}</div>
        </div>
      ))}
      <div className="iso-item-sep">SERVER</div>
    </div>
  )
}

function LockIcon() {
  return (
    <svg className="iso-lock" width="10" height="11" viewBox="0 0 10 11" aria-label="secret">
      <path d="M2.5 5V3.5a2.5 2.5 0 0 1 5 0V5" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <rect x="1" y="5" width="8" height="5.5" rx="1" fill="currentColor" />
    </svg>
  )
}

function Readout({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className={`iso-read ${warn ? 'is-warn' : ''}`}>
      <span className="iso-read-k">{label}</span>
      <span className="iso-read-v">{value}</span>
    </div>
  )
}

