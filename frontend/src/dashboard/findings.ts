import type { Vuln } from './types'

export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const
export const SEVERITY_COLORS: Record<string, string> = {
  critical: 'var(--danger)',
  high: 'var(--warn)',
  medium: 'var(--muted)',
  low: 'var(--line-strong)',
}

export function sortedFindings(findings: Vuln[]): Vuln[] {
  const rank = (severity: string) => {
    const index = SEVERITIES.indexOf(severity as (typeof SEVERITIES)[number])
    return index === -1 ? SEVERITIES.length : index
  }
  return [...findings].sort(
    (a, b) =>
      Number(a.status === 'remediated') - Number(b.status === 'remediated') ||
      rank(a.severity) - rank(b.severity) ||
      b.discoveredAt - a.discoveredAt,
  )
}
