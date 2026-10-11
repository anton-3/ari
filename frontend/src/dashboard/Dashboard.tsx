import { useEffect, useRef, useState } from 'react'
import { Logo } from '@/components/ui/Logo'
import './dashboard.css'
import { useTelemetry } from './useTelemetry'
import { ARI_PHONE, TELEMETRY_BASE_URL, WS_URL } from './config'
import { InfrastructureMap } from './components/InfrastructureMap'
import { UsersPanel } from './components/UsersPanel'
import { FindingsPanel, FindingRows } from './components/FindingsPanel'
import { AriConsole } from './components/AriConsole'
import type { FeedSource, Vuln } from './types'

type View = 'incidents' | 'findings' | 'agents' | 'integrations' | 'finding'
const FEED_LABELS: Record<FeedSource, string> = {
  live: 'live',
  polling: 'polling',
  mock: 'demo data',
  connecting: 'connecting',
  offline: 'offline · last snapshot',
}

export default function Dashboard() {
  const { metrics, logs, vulns, agents, source } = useTelemetry()
  const [now, setNow] = useState(() => Date.now())
  const [view, setView] = useState<View | null>(null)
  const [selected, setSelected] = useState<Vuln | null>(null)
  const [filter, setFilter] = useState('')
  const dialog = useRef<HTMLDialogElement>(null)
  const currentFinding =
    vulns.find((finding) => finding.id === selected?.id) ?? selected
  const project = vulns[0]?.project ?? 'MyFiat'
  const issues = logs.filter((log) =>
    ['warn', 'error', 'critical'].includes(log.level),
  )

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  useEffect(() => {
    if (view) dialog.current?.showModal()
    else dialog.current?.close()
  }, [view])

  function openView(next: View) {
    setFilter('')
    setView(next)
  }
  function selectFinding(finding: Vuln) {
    setSelected(finding)
    setView('finding')
  }
  const titles: Record<View, string> = {
    incidents: 'incidents',
    findings: 'all findings',
    agents: 'agents',
    integrations: 'integrations',
    finding: 'finding details',
  }

  return (
    <div className="dashboard-shell">
      <header className="dashboard-header">
        <div className="dashboard-header-left">
          <div className="dashboard-brand">
            <a href="/" aria-label="Ari home">
              <Logo size={24} />
              <span>ari</span>
            </a>
            <span className="dashboard-project">
              {project.toLowerCase()} / local
            </span>
          </div>
          <nav className="dashboard-nav" aria-label="Dashboard navigation">
            <button
              className={view === null ? 'is-active' : ''}
              onClick={() => setView(null)}
            >
              overview
            </button>
            {(['incidents', 'findings', 'agents', 'integrations'] as const).map(
              (item) => (
                <button
                  key={item}
                  className={view === item ? 'is-active' : ''}
                  onClick={() => openView(item)}
                >
                  {item}
                </button>
              ),
            )}
          </nav>
        </div>
        <div className="dashboard-header-right">
          <span className="deployment-label">
            local telemetry{metrics?.mode ? ` · ${metrics.mode}` : ''}
          </span>
          <span
            className="feed-status"
            title={
              source === 'live'
                ? 'Connected to telemetry over WebSocket; the service generates demo traffic'
                : source === 'mock'
                  ? 'Telemetry is unavailable; showing built-in demo data and retrying'
                  : source === 'offline'
                    ? 'Connection lost; showing the last telemetry snapshot'
                    : 'Telemetry connection status'
            }
          >
            <i className={`status-square ${source}`} />
            {FEED_LABELS[source]}
          </span>
          <time
            className="mono dashboard-clock"
            dateTime={new Date(now).toISOString()}
          >
            {new Date(now).toLocaleTimeString('en-GB')}
          </time>
        </div>
      </header>
      <main className="dashboard-main">
        <div className="dashboard-left">
          <InfrastructureMap metrics={metrics} agents={agents} />
          <AriConsole logs={logs} source={source} />
        </div>
        <div className="dashboard-right">
          <UsersPanel metrics={metrics} />
          <FindingsPanel
            findings={vulns}
            onViewAll={() => openView('findings')}
            onSelect={selectFinding}
          />
        </div>
      </main>
      <dialog
        ref={dialog}
        className="dashboard-dialog"
        onCancel={() => setView(null)}
        onClose={() => setView(null)}
        onClick={(event) => {
          if (event.target === event.currentTarget) {
            const rect = event.currentTarget.getBoundingClientRect()
            if (
              event.clientX < rect.left ||
              event.clientX > rect.right ||
              event.clientY < rect.top ||
              event.clientY > rect.bottom
            )
              setView(null)
          }
        }}
        aria-labelledby="dialog-title"
      >
        <div className="dialog-heading">
          <h2 id="dialog-title">{view ? titles[view] : ''}</h2>
          <button
            className="dialog-close"
            onClick={() => setView(null)}
            aria-label="Close dialog"
          >
            ×
          </button>
        </div>
        {view === 'findings' && (
          <>
            <input
              className="finding-search"
              aria-label="Search findings"
              placeholder="search findings, projects, endpoints…"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
            <FindingRows
              findings={vulns.filter((finding) =>
                `${finding.title} ${finding.project} ${finding.endpoint} ${finding.severity} ${finding.status}`
                  .toLowerCase()
                  .includes(filter.toLowerCase()),
              )}
              onSelect={selectFinding}
            />
          </>
        )}
        {view === 'finding' && currentFinding && (
          <div className="finding-detail">
            <h3>{currentFinding.title}</h3>
            <dl>
              <dt>project</dt>
              <dd>{currentFinding.project}</dd>
              <dt>endpoint</dt>
              <dd className="mono">{currentFinding.endpoint}</dd>
              <dt>severity</dt>
              <dd>{currentFinding.severity}</dd>
              <dt>status</dt>
              <dd>{currentFinding.status}</dd>
              <dt>discovered</dt>
              <dd>{new Date(currentFinding.discoveredAt).toLocaleString()}</dd>
              <dt>id</dt>
              <dd className="mono">{currentFinding.id}</dd>
            </dl>
            <button className="text-button" onClick={() => setView('findings')}>
              ← all findings
            </button>
          </div>
        )}
        {view === 'incidents' && (
          <>
            <p className="dialog-note">
              Recent warnings and errors from the telemetry feed.
            </p>
            <div className="incident-list">
              {issues.length === 0 && (
                <p className="muted">no warning or error events reported</p>
              )}
              {issues.map((log, i) => (
                <article key={`${log.ts}-${i}`}>
                  <div>
                    <time className="mono">
                      {new Date(log.ts).toLocaleTimeString('en-GB')}
                    </time>
                    <span className={`incident-level ${log.level}`}>
                      {log.level}
                    </span>
                    <span>{log.source}</span>
                  </div>
                  <p>{log.msg}</p>
                  <span className="mono muted">
                    {log.ip} · {log.method} {log.path} · {log.status}
                  </span>
                </article>
              ))}
            </div>
          </>
        )}
        {view === 'agents' && (
          <>
            <p className="dialog-note">
              Agent status and scan progress are unavailable. Configure a
              contact number to reach Ari by phone.
            </p>
            <div className="integration-row">
              <span>push to talk</span>
              <span>not implemented yet</span>
            </div>
            <div className="integration-row">
              <span>phone</span>
              <span>{ARI_PHONE || 'not configured'}</span>
            </div>
          </>
        )}
        {view === 'integrations' && (
          <>
            <div className="integration-row">
              <span>telemetry</span>
              <span>{FEED_LABELS[source]}</span>
            </div>
            <p className="mono endpoint">{TELEMETRY_BASE_URL}</p>
            <div className="integration-row">
              <span>WebSocket</span>
              <span>{source === 'live' ? 'connected' : 'not connected'}</span>
            </div>
            <p className="mono endpoint">{WS_URL}</p>
            <div className="integration-row">
              <span>data</span>
              <span>
                {source === 'mock'
                  ? 'browser demo fallback'
                  : 'telemetry service'}
              </span>
            </div>
            <p className="dialog-note">
              The local telemetry service simulates traffic and samples MyFiat
              latency. Findings and node health come from its API.
            </p>
          </>
        )}
      </dialog>
    </div>
  )
}
