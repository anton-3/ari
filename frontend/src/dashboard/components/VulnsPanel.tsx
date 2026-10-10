import type { Vuln, VulnStatus } from '../types'
import { relTime } from '../helpers'

const SEV_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 }

function StatusPill({ status }: { status: VulnStatus }) {
  const cls = `ari__status ari__status--${status}`
  if (status === 'remediated') {
    return (
      <span className={cls}>
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M20 6 9 17l-5-5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Remediated
      </span>
    )
  }
  if (status === 'investigating') {
    return (
      <span className={cls}>
        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2.5" />
          <path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
        Investigating
      </span>
    )
  }
  return (
    <span className={cls}>
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 2 2 20h20L12 2Z" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" />
        <path d="M12 9v5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        <circle cx="12" cy="17" r="1" fill="currentColor" />
      </svg>
      Discovered
    </span>
  )
}

export function VulnsPanel({ vulns }: { vulns: Vuln[] }) {
  const sorted = [...vulns].sort((a, b) => {
    // open items first, then by severity, then newest.
    const aOpen = a.status === 'remediated' ? 1 : 0
    const bOpen = b.status === 'remediated' ? 1 : 0
    if (aOpen !== bOpen) return aOpen - bOpen
    const sev = (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9)
    if (sev !== 0) return sev
    return b.discoveredAt - a.discoveredAt
  })

  const open = vulns.filter((v) => v.status !== 'remediated').length
  const crit = vulns.filter((v) => v.severity === 'critical' && v.status !== 'remediated').length

  return (
    <section className="ari__panel ari__vulns" aria-label="Vulnerabilities">
      <div className="ari__panel-head">
        <h2 className="ari__panel-title">Vulnerabilities</h2>
        <span className="ari__panel-sub ari__mono">
          {open} open · {crit} critical · {vulns.length} tracked
        </span>
      </div>
      <div className="ari__vuln-list">
        {sorted.length === 0 && (
          <div className="ari__vuln-meta" style={{ padding: '8px 2px' }}>No findings yet — Ari is scanning…</div>
        )}
        {sorted.map((v) => (
          <article className="ari__vuln" key={v.id}>
            <span className={`ari__sev ari__sev--${v.severity}`}>{v.severity}</span>
            <div className="ari__vuln-main">
              <div className="ari__vuln-title">{v.title}</div>
              <div className="ari__vuln-meta ari__mono">
                {v.id} · {v.project} · {v.endpoint} · {relTime(v.discoveredAt)}
              </div>
            </div>
            <StatusPill status={v.status} />
          </article>
        ))}
      </div>
    </section>
  )
}
