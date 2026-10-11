import type { Vuln } from '../types'

import { SEVERITIES, SEVERITY_COLORS, sortedFindings } from '../findings'

export function FindingRows({
  findings,
  onSelect,
}: {
  findings: Vuln[]
  onSelect: (finding: Vuln) => void
}) {
  return (
    <div className="finding-list">
      {findings.length === 0 && (
        <div className="panel-empty">no findings reported</div>
      )}
      {sortedFindings(findings).map((finding) => (
        <button
          className="finding-row"
          key={finding.id}
          onClick={() => onSelect(finding)}
        >
          <i
            style={{
              background: SEVERITY_COLORS[finding.severity] || 'var(--dim)',
            }}
          />
          <span className="finding-info">
            <span className="ell" title={finding.title}>
              {finding.title}
            </span>
            <span
              className="mono ell"
              title={`${finding.project} · ${finding.endpoint}`}
            >
              {finding.project} · {finding.endpoint}
            </span>
          </span>
          <span
            className={`finding-tag ${finding.status === 'remediated' ? 'is-fixed' : ''}`}
          >
            {finding.status === 'remediated'
              ? 'fixed'
              : finding.status === 'investigating'
                ? 'investigating'
                : 'open'}
          </span>
        </button>
      ))}
    </div>
  )
}

export function FindingsPanel({
  findings,
  onViewAll,
  onSelect,
}: {
  findings: Vuln[]
  onViewAll: () => void
  onSelect: (finding: Vuln) => void
}) {
  const open = findings.filter((finding) => finding.status !== 'remediated')
  const fixed = findings.length - open.length
  const counts = SEVERITIES.map(
    (severity) =>
      open.filter((finding) => finding.severity === severity).length,
  )

  return (
    <section
      className="dash-panel findings-panel"
      id="findings"
      aria-labelledby="findings-title"
    >
      <div className="panel-heading">
        <h2 id="findings-title">findings</h2>
        <button className="text-button" onClick={onViewAll}>
          view all ↗
        </button>
      </div>
      <div className="finding-stats">
        <div>
          <strong>{open.length}</strong>
          <span>open</span>
        </div>
        <div>
          <strong>{fixed}</strong>
          <span>remediated</span>
        </div>
      </div>
      <div className="severity-summary">
        <div
          className="severity-bar"
          aria-label={`${open.length} open findings by severity`}
        >
          {SEVERITIES.map(
            (severity, i) =>
              counts[i] > 0 && (
                <span
                  key={severity}
                  style={{
                    flex: counts[i],
                    background: SEVERITY_COLORS[severity],
                  }}
                />
              ),
          )}
        </div>
        <div className="severity-legend">
          {SEVERITIES.map(
            (severity, i) =>
              counts[i] > 0 && (
                <span key={severity}>
                  <i style={{ background: SEVERITY_COLORS[severity] }} />
                  {counts[i]} {severity}
                </span>
              ),
          )}
        </div>
      </div>
      <FindingRows findings={findings} onSelect={onSelect} />
    </section>
  )
}
