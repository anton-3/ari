// One generic tree for recursive expansion: server → files → symbols → child
// symbols, to any depth. Built from the codemap only; files without `symbols`
// are simply leaves (nothing is invented).
import { issueMatchesFile } from './helpers'
import type { Codemap, CodemapFile, CodemapRole, FleetIssue, RouteStat, Sym } from './types'

export interface TItem {
  key: string // file path, or symbol id
  label: string
  kind: string // 'file' | Sym kind
  depth: number // 1 = file, 2 = top-level symbol, ...
  file: string // owning file path
  fileInfo?: CodemapFile
  sym?: Sym
  children: TItem[]
  parent: TItem | null
}

export interface CodeTree {
  role: CodemapRole
  files: TItem[]
  byKey: Map<string, TItem>
  routes: Map<string, RouteStat> // symbolId → live per-route stats
  entry: string // entry file path (owns the inbound port)
}

export function symLabel(s: Sym): string {
  if (s.kind === 'route' && s.route) return `${s.route.method} ${s.route.path}`
  return s.name
}

const cache = new WeakMap<CodemapRole, CodeTree>()

export function treeFor(cm: Codemap | null, roleName: string): CodeTree | null {
  const role = cm?.roles?.[roleName]
  if (!role || !role.files || role.files.length === 0) return null
  const hit = cache.get(role)
  if (hit) return hit
  const byKey = new Map<string, TItem>()
  const mkSym = (s: Sym, parent: TItem, file: string): TItem => {
    const it: TItem = { key: s.id, label: symLabel(s), kind: s.kind, depth: parent.depth + 1, file, sym: s, children: [], parent }
    if (!byKey.has(s.id)) byKey.set(s.id, it)
    it.children = (s.children ?? []).map((c) => mkSym(c, it, file))
    return it
  }
  const files = role.files.map((f) => {
    const it: TItem = { key: f.path, label: f.label, kind: 'file', depth: 1, file: f.path, fileInfo: f, children: [], parent: null }
    byKey.set(f.path, it)
    it.children = (f.symbols ?? []).map((s) => mkSym(s, it, f.path))
    return it
  })
  const routes = new Map<string, RouteStat>()
  for (const r of role.routes ?? []) if (r && r.symbolId) routes.set(r.symbolId, r)
  const entry = role.ports.find((p) => p.dir === 'in')?.file ?? role.files.slice().sort((a, b) => b.loc - a.loc)[0].path
  const t: CodeTree = { role, files, byKey, routes, entry }
  cache.set(role, t)
  return t
}

/** Keys from the file down to `it` (inclusive). */
export function chainOf(it: TItem): string[] {
  const out: string[] = []
  for (let c: TItem | null = it; c; c = c.parent) out.unshift(c.key)
  return out
}

/** Resolve a key path to items; stops at the first key that doesn't resolve. */
export function itemsOf(t: CodeTree | null, keys: string[] | undefined): TItem[] {
  const out: TItem[] = []
  if (!t || !keys) return out
  let level = t.files
  for (const k of keys) {
    const it = level.find((x) => x.key === k)
    if (!it) break
    out.push(it)
    level = it.children
  }
  return out
}

/** Deep-link segments (file label/path, then symbol names/labels/ids) → keys. */
export function resolveSegments(t: CodeTree | null, segs: string[]): { keys: string[]; complete: boolean } {
  const keys: string[] = []
  if (!t) return { keys, complete: segs.length === 0 }
  let level = t.files
  const norm = (s: string) => s.trim().toLowerCase()
  for (const seg of segs) {
    const q = norm(seg)
    const it =
      level.find((x) => x.key === seg) ??
      level.find((x) => norm(x.label) === q) ??
      level.find((x) => x.sym && norm(x.sym.name) === q) ??
      level.find((x) => x.kind === 'file' && x.key.endsWith('/' + seg))
    if (!it) return { keys, complete: false }
    keys.push(it.key)
    level = it.children
  }
  return { keys, complete: true }
}

/** Where an issue lives in the tree: chain of keys (empty = the server itself). */
export function issueChain(t: CodeTree | null, i: FleetIssue): string[] {
  if (!t) return []
  if (i.symbolId) {
    const it = t.byKey.get(i.symbolId)
    if (it) return chainOf(it)
  }
  const f = t.files.find((x) => issueMatchesFile(i, x.key))
  return f ? [f.key] : []
}

/** Issues on this item or anything below it. */
export function issuesUnder(t: CodeTree | null, issues: FleetIssue[], keys: string[]): FleetIssue[] {
  if (!keys.length) return issues
  return issues.filter((i) => {
    const c = issueChain(t, i)
    if (c.length < keys.length) return false
    for (let j = 0; j < keys.length; j++) if (c[j] !== keys[j]) return false
    return true
  })
}

/** Route stats under an item (a route itself, or routes nested below it). */
export function routeOf(t: CodeTree | null, it: TItem): RouteStat | null {
  return t && it.sym ? t.routes.get(it.sym.id) ?? null : null
}

/** Route error rate normalised to a 0..1 fraction (tolerates percent values). */
export function errFrac(e: number | null | undefined): number {
  if (!e || !Number.isFinite(e) || e <= 0) return 0
  return e > 1 ? Math.min(1, e / 100) : e
}
