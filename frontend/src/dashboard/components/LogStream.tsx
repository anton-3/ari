import type { LogEntry } from '../types'
import { fmtTime } from '../helpers'

function statusClass(status: number): string {
  if (status >= 500) return 'ari__log-status--err'
  if (status >= 400) return 'ari__log-status--warn'
  return 'ari__log-status--ok'
}

function levelClass(level: string): string {
  switch (level) {
    case 'debug':
      return 'ari__log-level--debug'
    case 'warn':
      return 'ari__log-level--warn'
    case 'error':
      return 'ari__log-level--error'
    case 'critical':
      return 'ari__log-level--critical'
    default:
      return 'ari__log-level--info'
  }
}

export function LogStream({ logs }: { logs: LogEntry[] }) {
  const rows = logs.slice(0, 80)
  return (
    <section className="ari__panel ari__logs" aria-label="Live log stream">
      <div className="ari__panel-head">
        <h2 className="ari__panel-title">Log Stream</h2>
        <span className="ari__panel-sub ari__mono">
          <span className="ari__dot ari__dot--live" style={{ display: 'inline-block', marginRight: 6 }} />
          tailing · {logs.length} buffered
        </span>
      </div>
      <div className="ari__logstream ari__mono" role="log" aria-live="polite">
        {rows.length === 0 && <div className="ari__log-msg">waiting for events…</div>}
        {rows.map((l, i) => (
          <div className="ari__logrow" key={`${l.ts}-${i}`}>
            <span className="ari__log-ts">{fmtTime(l.ts)}</span>
            <span className={`ari__log-level ${levelClass(l.level)}`}>{l.level}</span>
            <span className="ari__log-src">{l.source}</span>
            <span className="ari__log-msg">
              {l.method} {l.path} — {l.msg} <span style={{ opacity: 0.6 }}>({l.ip})</span>
            </span>
            <span className={`ari__log-status ${statusClass(l.status)}`}>{l.status}</span>
          </div>
        ))}
      </div>
    </section>
  )
}
