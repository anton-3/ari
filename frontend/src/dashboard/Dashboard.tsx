import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import './dashboard.css'
import { useTelemetry } from './useTelemetry'
import { ARI_PHONE, TELEMETRY_BASE_URL, WS_URL } from './config'
import { InfrastructureMap } from './components/InfrastructureMap'
import { UsersPanel } from './components/UsersPanel'
import { FindingsPanel, FindingRows } from './components/FindingsPanel'
import { AriConsole } from './components/AriConsole'
import { DemoReset } from './components/DemoReset'
import type { FeedSource, Vuln } from './types'

type View = 'incidents' | 'findings' | 'agents' | 'integrations' | 'finding'
const FEED_LABELS: Record<FeedSource, string> = {
  live: 'live',
  polling: 'polling',
  mock: 'demo data',
  connecting: 'connecting',
  offline: 'offline · last snapshot',
}
const PROJECTS = ['myfiat']

function ProjectSwitcher() {
  const [project, setProject] = useState(PROJECTS[0])
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    root.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus()
    function onPointerDown(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      setOpen(false)
      trigger.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  function moveFocus(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const items = [
      ...event.currentTarget.querySelectorAll<HTMLElement>('button'),
    ]
    const step = event.key === 'ArrowDown' ? 1 : -1
    const index = items.indexOf(document.activeElement as HTMLElement)
    items[(index + step + items.length) % items.length]?.focus()
  }

  return (
    <div className="project-switcher" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="project-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? 'project-menu' : undefined}
        aria-label={`project: ${project}`}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{project}</span>
        <svg viewBox="0 0 10 6" width="10" height="6" aria-hidden="true">
          <path
            d="M1 1l4 4 4-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && (
        <div
          className="project-menu"
          id="project-menu"
          role="menu"
          aria-label="projects"
          onKeyDown={moveFocus}
        >
          {PROJECTS.map((item) => (
            <button
              key={item}
              type="button"
              role="menuitemradio"
              aria-checked={item === project}
              onClick={() => {
                setProject(item)
                setOpen(false)
                trigger.current?.focus()
              }}
            >
              <span>{item}</span>
              {item === project && (
                <svg
                  viewBox="0 0 12 10"
                  width="12"
                  height="10"
                  aria-hidden="true"
                >
                  <path
                    d="M1 5.5l3.2 3L11 1.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default function Dashboard() {
  const { metrics, logs, vulns, agents, activity, source } = useTelemetry()
  const [view, setView] = useState<View | null>(null)
  const [selected, setSelected] = useState<Vuln | null>(null)
  const [filter, setFilter] = useState('')
  const dialog = useRef<HTMLDialogElement>(null)
  const currentFinding =
    vulns.find((finding) => finding.id === selected?.id) ?? selected
  const issues = logs.filter((log) =>
    ['warn', 'error', 'critical'].includes(log.level),
  )

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
              <img src="/favicon.svg" width={30} height={30} alt="" />
              <span>Ari</span>
            </a>
            <ProjectSwitcher />
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
          <DemoReset source={source} />
        </div>
      </header>
      <main className="dashboard-main">
        <div className="dashboard-left">
          <InfrastructureMap metrics={metrics} agents={agents} />
          <AriConsole activity={activity} logs={logs} source={source} />
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
              Ari works alongside your on-call. Reach it by phone on the contact
              number below.
            </p>
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
