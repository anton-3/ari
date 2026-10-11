import { ARI_PHONE } from '../config'
import type { FeedSource, LogEntry } from '../types'

function Equalizer() {
  return (
    <span className="equalizer" aria-hidden="true">
      <span />
      <span />
      <span />
      <span />
    </span>
  )
}

export function AriConsole({
  logs,
  source,
}: {
  logs: LogEntry[]
  source: FeedSource
}) {
  // Prefer actual Ari tool events, then fill the remaining lines from telemetry.
  const ari = logs.filter((log) => /ari|security|agent/i.test(log.source))
  const others = logs.filter((log) => !ari.includes(log))
  const rows = [...ari.slice(0, 3), ...others].slice(0, 3)
  return (
    <section
      className="dash-panel ari-console"
      id="ari-activity"
      aria-label="Ari activity and voice controls"
    >
      <div className="ari-controls">
        <span className="ari-presence">
          <i
            className={`status-square ${source === 'offline' ? 'offline' : ''}`}
          />
          ari activity
        </span>
        <button
          className="push-to-talk"
          type="button"
          onClick={() => window.alert('not implemented yet')}
          aria-label="push to talk to ari"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
            <rect
              x="8.5"
              y="2"
              width="7"
              height="12"
              rx="3.5"
              fill="currentColor"
            />
            <path
              d="M5 11a7 7 0 0 0 14 0M12 18v4M8 22h8"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            />
          </svg>
          push to talk
        </button>
      </div>
      <div className="ari-events" aria-label="Latest telemetry activity">
        {rows.length === 0 && (
          <span className="muted">waiting for activity…</span>
        )}
        {rows.map((log, i) => (
          <div className="ari-event" key={`${log.ts}-${log.msg}-${i}`}>
            <time className="mono" dateTime={new Date(log.ts).toISOString()}>
              {new Date(log.ts).toLocaleTimeString('en-GB', {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </time>
            <span
              className={
                /ari|security|agent/i.test(log.source)
                  ? 'event-ari'
                  : 'event-source'
              }
              title={log.source}
            >
              {/ari|security|agent/i.test(log.source) ? 'ari' : log.source}
            </span>
            <span className="event-message">
              <span className="ell" title={log.msg}>
                {log.msg}
              </span>
              {i === 0 && source === 'live' && <Equalizer />}
            </span>
          </div>
        ))}
      </div>
      <div className="ari-contact">
        <span>text or call</span>
        {ARI_PHONE ? (
          <a href={`tel:${ARI_PHONE}`}>{ARI_PHONE}</a>
        ) : (
          <span className="contact-unset">number not configured</span>
        )}
      </div>
    </section>
  )
}
