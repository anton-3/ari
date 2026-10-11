import { ARI_PHONE } from '../config'
import type { ActivityLine, FeedSource, LogEntry } from '../types'

const MAX_LINES = 5
const NOTABLE = new Set(['warn', 'error', 'critical'])

interface Line {
  key: string
  ts: number
  source: string
  text: string
  detail: string
  tone: 'ari' | 'alert' | 'plain'
}

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

function fromLog(log: LogEntry): Line {
  return {
    key: `log|${log.ts}|${log.ip}|${log.msg}`,
    ts: log.ts,
    source: log.source,
    text: log.msg,
    detail: [log.level, log.status, log.ip].filter(Boolean).join(' · '),
    tone: NOTABLE.has(log.level) ? 'alert' : 'plain',
  }
}

export function AriConsole({
  activity,
  logs,
  source,
}: {
  activity: ActivityLine[]
  logs: LogEntry[]
  source: FeedSource
}) {
  // Ari's own narration and anything worth attention come first; ordinary
  // traffic only fills the card while there is nothing else to show.
  const lines: Line[] = [
    ...activity.map(
      (line): Line => ({
        key: `${line.source}|${line.ts}|${line.text}`,
        ts: line.ts,
        source: line.source,
        text: line.text,
        detail: line.severity ?? '',
        tone: 'ari',
      }),
    ),
    ...logs.filter((log) => NOTABLE.has(log.level)).map(fromLog),
  ]
  if (lines.length < MAX_LINES)
    lines.push(
      ...logs
        .filter((log) => !NOTABLE.has(log.level))
        .slice(0, MAX_LINES - lines.length)
        .map(fromLog),
    )
  // Teletype order: oldest at the top, the newest line enters at the bottom.
  const rows = lines.sort((a, b) => a.ts - b.ts).slice(-MAX_LINES)
  const feeding = source === 'live' || source === 'polling'

  return (
    <section
      className="dash-panel ari-console"
      id="ari-activity"
      aria-label="Ari activity"
    >
      <span className="ari-presence">
        <i
          className={`status-square ${source === 'offline' ? 'offline' : ''}`}
        />
        ari activity
      </span>
      <div className="ari-events" aria-live="off">
        {rows.length === 0 && (
          <span className="muted">waiting for activity…</span>
        )}
        {rows.map((line, i) => {
          const head = i === rows.length - 1
          return (
            <div
              className={`ari-event tone-${line.tone}${head ? ' is-head' : ''}`}
              key={line.key}
              style={{ opacity: head ? 1 : 0.4 + (0.45 * (i + 1)) / rows.length }}
            >
              <time className="mono" dateTime={new Date(line.ts).toISOString()}>
                {new Date(line.ts).toLocaleTimeString('en-GB')}
              </time>
              <span className="event-source" title={line.source}>
                {line.source}
              </span>
              <span className="event-message">
                <span className="ell" title={line.text}>
                  {line.text}
                </span>
                {head && feeding && <Equalizer />}
              </span>
              <span className="event-detail mono">{line.detail}</span>
            </div>
          )
        })}
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
