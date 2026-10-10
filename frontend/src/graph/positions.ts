// Shared position bookkeeping for the fleet view.
//  - saved positions: persisted in localStorage, keyed by node LABEL
//  - placements: one-shot world positions for nodes about to appear (palette drop)
//  - aliases: optimistic temp node id -> real node id once POST returns

const KEY = 'ari.fleet.positions.v1'

export interface Pos {
  x: number
  y: number
}

function readAll(): Record<string, Pos> {
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return {}
    const v = JSON.parse(raw) as unknown
    return v && typeof v === 'object' ? (v as Record<string, Pos>) : {}
  } catch {
    return {}
  }
}

export function loadPos(label: string): Pos | null {
  const p = readAll()[label]
  return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? p : null
}

export function savePos(label: string, x: number, y: number): void {
  try {
    const all = readAll()
    all[label] = { x: Math.round(x), y: Math.round(y) }
    window.localStorage.setItem(KEY, JSON.stringify(all))
  } catch {
    /* storage unavailable (private mode, quota) — positions just won't persist */
  }
}

export function forgetPos(label: string): void {
  try {
    const all = readAll()
    if (!(label in all)) return
    delete all[label]
    window.localStorage.setItem(KEY, JSON.stringify(all))
  } catch {
    /* ignore */
  }
}

const placements = new Map<string, Pos>()
export function setPlacement(id: string, p: Pos): void {
  placements.set(id, p)
}
export function takePlacement(id: string): Pos | null {
  const p = placements.get(id) ?? null
  placements.delete(id)
  return p
}

const aliases = new Map<string, string>() // realId -> tempId
export function aliasNode(tempId: string, realId: string): void {
  aliases.set(realId, tempId)
}
export function takeAlias(realId: string): string | null {
  const t = aliases.get(realId) ?? null
  aliases.delete(realId)
  return t
}
