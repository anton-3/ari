import { useEffect, useState } from 'react'
import type { FeedSource } from '../types'
import { fmtClock } from '../helpers'

const FEED_LABEL: Record<FeedSource, string> = {
  live: 'Live · WebSocket',
  polling: 'Live · Polling',
  mock: 'Demo · Mock data',
  connecting: 'Connecting…',
}

function AriMark() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 2.5 3.5 6v6c0 5 3.6 8.3 8.5 9.6 4.9-1.3 8.5-4.6 8.5-9.6V6L12 2.5Z" stroke="#bfe9ff" strokeWidth="1.6" strokeLinejoin="round" />
      <circle cx="12" cy="11" r="2.4" fill="#38bdf8" />
      <path d="M12 13.4V17M8.3 8.6 6.6 7M15.7 8.6 17.4 7" stroke="#8fd6f5" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

export function TopBar({ source }: { source: FeedSource }) {
  const [now, setNow] = useState<number>(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])

  return (
    <header className="ari__topbar">
      <div className="ari__brand">
        <div className="ari__logo">
          <AriMark />
        </div>
        <div>
          <h1 className="ari__title">ARI · SECURITY OPS</h1>
          <div className="ari__subtitle">Autonomous Infrastructure Defense</div>
        </div>
      </div>

      <div className="ari__topbar-spacer" />

      <span className="ari__chip ari__chip--ari">
        <span className="ari__dot ari__dot--live" />
        Ari — online, monitoring
      </span>

      <span className="ari__chip">
        <span className={`ari__dot ari__dot--${source}`} />
        <span className="ari__feed">{FEED_LABEL[source]}</span>
      </span>

      <span className="ari__clock ari__mono">{fmtClock(now)}</span>
    </header>
  )
}
