import { AriContact } from './AriContact'
import type { ActivityLine, FeedSource, LogEntry } from '../types'
import { useEffect, useRef, useState } from 'react'

const MAX_LINES = 4
const NOTABLE = new Set(['warn', 'error', 'critical'])

interface Line {
  key: string
  ts: number
  source: string
  text: string
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
  const [displayed, setDisplayed] = useState<Line[]>([])
  const seen = useRef(new Set<string>())
  const queue = useRef<Line[]>([])
  // Ari's own narration and anything worth attention come first; ordinary
  // traffic only fills the card while there is nothing else to show.
  const lines: Line[] = [
    ...activity.map(
      (line): Line => ({
        key: `${line.source}|${line.ts}|${line.text}`,
        ts: line.ts,
        source: line.source,
        text: line.text,
        tone: 'ari',
      }),
    ),
    ...logs.map(fromLog),
  ]
  if (lines.length < MAX_LINES)
    lines.push(
      ...logs
        .filter((log) => !NOTABLE.has(log.level))
        .slice(0, MAX_LINES - lines.length)
        .map(fromLog),
    )
  // Teletype order: oldest at the top, the newest line enters at the bottom.
  useEffect(() => {
    const fresh = lines.filter(line => !seen.current.has(line.key)).sort((a, b) => a.ts - b.ts)
    for (const line of fresh) seen.current.add(line.key)
    if (seen.current.size > 2000) seen.current = new Set(lines.map(line => line.key))
    if (displayed.length === 0) setDisplayed(fresh.slice(-MAX_LINES))
    else queue.current = [...queue.current, ...fresh].slice(-40)
  // Input identity changes as live batches and Ari events arrive.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activity, logs])
  useEffect(() => {
    const timer = window.setInterval(() => {
      const next = queue.current.shift()
      if (next) setDisplayed(previous => [...previous, next].slice(-MAX_LINES))
    }, 90)
    return () => window.clearInterval(timer)
  }, [])
  const newestAri = lines.filter(line => line.tone === 'ari').sort((a, b) => b.ts - a.ts)[0]
  const latestTs = Math.max(0, ...lines.map(line => line.ts))
  const pinned = newestAri && latestTs - newestAri.ts < 15000 && !displayed.some(line => line.key === newestAri.key)
  const rows = pinned ? [...displayed.slice(-(MAX_LINES - 1)), newestAri] : displayed
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
        Ari activity
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
              <span className="event-source" title={line.source.replace(/\bari\b/gi, 'Ari')}>
                {line.source.replace(/\bari\b/gi, 'Ari')}
              </span>
              <span className="event-message">
                <span className="ell" title={line.text}>
                  {line.text}
                </span>
                {head && feeding && <Equalizer />}
              </span>
            </div>
          )
        })}
      </div>
      <AriContact />
    </section>
  )
}
