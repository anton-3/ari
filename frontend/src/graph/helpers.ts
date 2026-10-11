// Neutral helpers shared by the main map (Graph/IsoView) and the test looks.
// (Previously defined in GraphView.tsx, which re-exports them for compatibility.)
import type { Codemap, CodemapRole, FleetIssue, FleetNode } from './types'

export type Sel = { kind: 'node'; id: string; file?: string } | { kind: 'link'; id: string }

export const ACTIVE_AGENT = new Set(['dispatched', 'working', 'reporting', 'moving', 'spawning'])
export const SEV_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 }

// the live backend tags controller links as "control"; contract lists ssh/other
export const isControl = (proto: string) => proto === 'ssh' || proto === 'control' || proto === 'other'

/** Memory: the live API reports bytes; tolerate MB too (values < 1e6 total). */
export function fmtMem(used: number, total: number): string {
  const bytes = total > 1e6
  const mb = (v: number) => (bytes ? v / 1048576 : v)
  const f = (v: number) => (mb(v) >= 1024 ? `${(mb(v) / 1024).toFixed(1)} GB` : `${Math.round(mb(v))} MB`)
  return total ? `${f(used)} / ${f(total)}` : '—'
}

export function fmtRate(bps: number): string {
  if (bps < 1024) return `${Math.round(bps)} B/s`
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`
  return `${(bps / 1024 / 1024).toFixed(2)} MB/s`
}

export type Level = 'red' | 'amber'
export function levelOf(issues: FleetIssue[]): Level | null {
  let top = 0
  for (const i of issues) top = Math.max(top, SEV_RANK[i.severity] ?? 1)
  return top === 0 ? null : top >= 3 ? 'red' : 'amber'
}
export function issueLevel(n: FleetNode): Level | null {
  return levelOf(n.issues ?? [])
}

/** Does this issue point at the file `path`? */
export function issueMatchesFile(i: FleetIssue, path: string): boolean {
  const base = path.split('/').pop() ?? path
  if (i.file) return i.file === path || i.file.endsWith(path) || path.endsWith(i.file)
  return i.detail.includes(path) || (base.length > 3 && i.detail.startsWith(base))
}

/** Issues that carry a file path matching `path`. */
export function fileIssues(n: FleetNode, path: string): FleetIssue[] {
  return (n.issues ?? []).filter((i) => issueMatchesFile(i, path))
}

export function codeFor(cm: Codemap | null, role: string): CodemapRole | null {
  const r = cm?.roles?.[role]
  // source files only: the file-level looks don't draw inventory (tables, keys, config)
  return r && !r.inventory && r.files && r.files.length > 0 ? r : null
}
