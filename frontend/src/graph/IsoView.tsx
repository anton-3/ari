import { useEffect, useRef } from 'react'
import { ACTIVE_AGENT, SEV_RANK, fmtMem, fmtRate, isControl, issueLevel, levelOf } from './helpers'
import type { Level } from './helpers'
import { chainOf, errFrac, factsOf, issueChain, issuesUnder, routeOf, treeFor } from './codetree'
import type { CodeTree, TItem } from './codetree'
import { loadPos, savePos, takeAlias, takePlacement } from './positions'
import type { Agent, Codemap, Fleet, FleetLink, FleetNode, Metrics } from './types'

// ---------------------------------------------------------------------------
// Isometric fleet map (Cloudcraft-style). The model is a flat 2D ground plane
// (world x/y, snapped to a grid); a fixed isometric camera projects it, so pan
// and zoom stay 2D. Every block, pipe and dash maps to real fleet data.
//
// Recursive expansion: server → files → symbols → child symbols. Anything with
// children opens in place into a platform of smaller tiles (lid lifts), one
// level smaller each time; siblings make room on screen only.
// ---------------------------------------------------------------------------

/** Selection: a server (optionally a path of item keys below it) or a link. */
export type IsoSel = { kind: 'node'; id: string; path?: string[] } | { kind: 'link'; id: string }

export const GRID = 60
const CX = Math.cos(Math.PI / 6)
const CY = 0.5

export const C = {
  bg: '#eef2f7',
  ink: '#1c2635',
  text: '#2a3546',
  dim: '#738096',
  acc: '#1d6fe0',
  red: '#e5383b',
  amber: '#e39b1b',
  top: '#fbfcfe',
  left: '#e1e7ef',
  right: '#c6d0dd',
  edge: 'rgba(40,56,84,0.28)',
  job: '#0f9fbf',
}

export const PROTO_COLOR: Record<string, string> = {
  http: '#22a06b',
  'http-app': '#22a06b',
  postgres: '#2f5fd0',
  redis: '#c2368f',
  ssh: '#8a96a8',
  control: '#8a96a8',
  other: '#8a96a8',
}

// decal colour per item kind
export const KIND_COLOR: Record<string, string> = {
  route: '#22a06b',
  function: '#55667d',
  class: '#7b4fe0',
  method: '#8a96a8',
  query: '#2f5fd0',
  config: '#0f8fa8',
  // inventory (db / cache / lb contents)
  table: '#2f5fd0',
  column: '#55667d',
  index: '#0f8fa8',
  key: '#c2368f',
  field: '#8a5fb0',
  upstream: '#7b4fe0',
  block: '#55667d',
  location: '#22a06b',
  member: '#3b82c4',
  directive: '#8a96a8',
  more: '#b4bcc8',
}
// drawn as a cylinder (data stores) rather than a box
const ROUND_KIND = new Set(['query', 'table', 'key'])
const FLAT_KIND = new Set(['config', 'index', 'more'])

type Kind = 'box' | 'server' | 'cyl' | 'stack' | 'slab' | 'client' | 'disc'
export interface RoleShape {
  kind: Kind
  w: number
  d: number
  h: number
  color: string
  glyph: string
  weight: number
  ax: number
  ay: number
}
export const ROLE: Record<string, RoleShape> = {
  internet: { kind: 'disc', w: 46, d: 46, h: 7, color: '#7a8699', glyph: 'NET', weight: 3, ax: -10, ay: 0 },
  traffic: { kind: 'client', w: 34, d: 34, h: 30, color: '#55667d', glyph: 'TRF', weight: 3, ax: -7, ay: 0 },
  lb: { kind: 'slab', w: 46, d: 70, h: 13, color: '#7b4fe0', glyph: 'LB', weight: 5, ax: -4, ay: 0 },
  app: { kind: 'server', w: 38, d: 38, h: 50, color: '#22a06b', glyph: 'APP', weight: 3, ax: 0, ay: 0 },
  worker: { kind: 'box', w: 28, d: 28, h: 26, color: '#3d8f86', glyph: 'WRK', weight: 2, ax: 1, ay: 5 },
  cache: { kind: 'stack', w: 38, d: 38, h: 31, color: '#c2368f', glyph: 'RDS', weight: 4, ax: 4, ay: -3 },
  db: { kind: 'cyl', w: 46, d: 46, h: 40, color: '#2f5fd0', glyph: 'PG', weight: 5, ax: 4, ay: 3 },
  controller: { kind: 'box', w: 40, d: 40, h: 34, color: '#0f8fa8', glyph: 'CTL', weight: 4, ax: -7, ay: -5 },
}
// Visual scale knobs: BLOCK_K enlarges the server blocks, UI_K the label tags,
// their text, and the issue badges.
const BLOCK_K = 1.2
export const UI_K = 1.25
const SHAPES: Record<string, RoleShape> = Object.fromEntries(
  Object.entries(ROLE).map(([k, s]) => [k, { ...s, w: s.w * BLOCK_K, d: s.d * BLOCK_K, h: s.h * BLOCK_K }]),
)
export const shapeOf = (r: string): RoleShape =>
  SHAPES[r] ?? { kind: 'box', w: 30 * BLOCK_K, d: 30 * BLOCK_K, h: 28 * BLOCK_K, color: '#738096', glyph: r.slice(0, 3).toUpperCase(), weight: 2, ax: 0, ay: -6 }

const SANS = '"Inter", system-ui, -apple-system, "Segoe UI", sans-serif'
const MONO = '"JetBrains Mono", ui-monospace, Menlo, monospace'
const LINK_GRACE_MS = 30000
const TOP_PAD = 100
const BOTTOM_PAD = 170
const LEFT_PAD = 210
const RIGHT_PAD = 40
const SEP = '\u001f'
const FS = 92 // file spacing (world); each level is LEVEL_K smaller
const LEVEL_K = 0.64
const spacing = (d: number) => FS * Math.pow(LEVEL_K, d - 1)
const tileBase = (d: number) => 30 * Math.pow(LEVEL_K, d - 1)
const READ_PX = 128 // min screen distance between horizontally adjacent tiles at the open level

interface Body {
  id: string
  node: FleetNode
  pending: boolean
  x: number
  y: number
  gx: number
  gy: number
  ox: number
  oy: number
  pinned: boolean
  ta: number
  alpha: number
  ex: number
  bootScale: number
  bootStart: number
  bootPhase: string
  lastIssueCount: number
  bornAt: number
}

interface LinkR {
  id: string
  a: Body
  b: Body
  data: FleetLink
  sF: number
  sR: number
  phF: number
  phR: number
  present: boolean
  goneAt: number
  nudge: number
  bornAt: number
}

interface AgentR {
  id: string
  type: string
  note: string
  status: string
  progress: number
  target: string
  alpha: number
  active: boolean
}

interface Ghost {
  x: number
  y: number
  role: string
  t: number
}

type P2 = { x: number; y: number }

interface LevelLay {
  pos: Map<string, P2>
  ext: Map<string, number>
  sub: Map<string, LevelLay>
  R: number
}

interface Vis {
  b: Body
  it: TItem
  keys: string[]
  fk: string
  x: number
  y: number
  s: number
  h: number
  a: number // parent openness (visibility)
  e: number // own openness
  d: number
  R: number // platform half-size when open
}

interface Plat {
  b: Body
  fk: string
  keys: string[]
  x: number
  y: number
  R: number
  d: number // depth of the tiles on it
  e: number
}

type Hit = { kind: 'node' | 'item' | 'badge'; id: string; keys?: string[]; sx: number; sy: number; rs: number; g?: { x: number; y: number; R: number } }

interface Props {
  fleet: Fleet | null
  agents: Agent[]
  metrics: Metrics | null
  codemap: Codemap | null
  live: boolean
  reduced: boolean
  rightInset: number
  /** camera padding around the scene; defaults leave room for the full-page chrome */
  insets?: { top: number; right: number; bottom: number; left: number }
  showControl: boolean
  selected: IsoSel | null
  focus: { id: string; n: number } | null
  onSelect: (s: IsoSel | null) => void
  onDropRole: (role: string, x: number, y: number) => void
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v)
const snap = (v: number) => Math.round(v / GRID) * GRID
const sameKeys = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])
const startsWith = (a: string[], pre: string[]) => pre.length <= a.length && pre.every((x, i) => x === a[i])

const rgbCache = new Map<string, [number, number, number]>()
function rgb(hex: string): [number, number, number] {
  let v = rgbCache.get(hex)
  if (!v) {
    const n = parseInt(hex.slice(1), 16)
    v = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    if (rgbCache.size > 4000) rgbCache.clear()
    rgbCache.set(hex, v)
  }
  return v
}
function mix(a: string, b: string, t: number): string {
  const A = rgb(a)
  const B = rgb(b)
  const f = (i: number) => Math.round(A[i] + (B[i] - A[i]) * t)
  return '#' + ((1 << 24) | (f(0) << 16) | (f(1) << 8) | f(2)).toString(16).slice(1)
}
function rgba(hex: string, a: number): string {
  const [r, g, b] = rgb(hex)
  return `rgba(${r},${g},${b},${a})`
}
function truncate(ctx: CanvasRenderingContext2D, s: string, max: number): string {
  if (ctx.measureText(s).width <= max) return s
  let lo = 0
  let hi = s.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (ctx.measureText(s.slice(0, mid) + '…').width <= max) lo = mid
    else hi = mid - 1
  }
  return s.slice(0, lo) + '…'
}
function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}
const fmtRps = (r: number) => (r >= 100 ? `${Math.round(r)}` : r >= 10 ? r.toFixed(1) : r.toFixed(2).replace(/0$/, ''))

// Grid slots: centre, then Chebyshev rings (ring 1 in a fixed, balanced order).
const SLOTS: [number, number][] = (() => {
  const out: [number, number][] = [[0, 0], [1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]
  for (let r = 2; r <= 7; r++) {
    const ring: [number, number][] = []
    for (let x = -r; x <= r; x++) for (let y = -r; y <= r; y++) if (Math.max(Math.abs(x), Math.abs(y)) === r) ring.push([x, y])
    ring.sort((a, b) => Math.atan2(a[1], a[0]) - Math.atan2(b[1], b[0]))
    out.push(...ring)
  }
  return out
})()

const KIND_ORDER: Record<string, number> = { route: 0, class: 1, function: 2, query: 3, method: 4, config: 5, more: 9 }
const slotCache = new Map<string, Map<string, P2>>()
function baseSlots(prefix: string, items: TItem[], d: number, tree: CodeTree): Map<string, P2> {
  const sig = prefix + '#' + items.map((i) => i.key).join(',')
  const hit = slotCache.get(sig)
  if (hit) return hit
  let order: TItem[]
  if (d === 1) {
    const portFiles = new Set(tree.role.ports.map((p) => p.file))
    const entry = items.find((i) => i.key === tree.entry)
    const rest = items
      .filter((i) => i !== entry)
      .sort((a, b) => Number(portFiles.has(b.key)) - Number(portFiles.has(a.key)) || (b.fileInfo?.loc ?? 0) - (a.fileInfo?.loc ?? 0))
    order = entry ? [entry, ...rest] : rest
  } else {
    order = items.slice().sort((a, b) => (KIND_ORDER[a.kind] ?? 6) - (KIND_ORDER[b.kind] ?? 6) || (a.sym?.line ?? 0) - (b.sym?.line ?? 0))
  }
  const sp = spacing(d)
  const m = new Map<string, P2>()
  order.forEach((it, i) => {
    const [cx, cy] = SLOTS[Math.min(i, SLOTS.length - 1)]
    m.set(it.key, { x: cx * sp, y: cy * sp })
  })
  if (slotCache.size > 500) slotCache.clear()
  slotCache.set(sig, m)
  return m
}

function tileSize(it: TItem, d: number, tree: CodeTree): number {
  const b = tileBase(d)
  if (it.kind === 'file') return it.key === tree.entry ? b * 1.27 : b
  if (it.kind === 'class' || it.kind === 'table' || it.kind === 'key') return b * 1.12
  if (it.kind === 'config') return b * 0.9
  if (it.kind === 'index' || it.kind === 'directive' || it.kind === 'field' || it.kind === 'more') return b * 0.85
  return b
}
function tileHeight(it: TItem, d: number, tree: CodeTree): number {
  const sc = Math.pow(LEVEL_K, d - 1)
  if (it.kind === 'file') return clamp(6 + Math.sqrt(it.fileInfo?.loc ?? 40) * 1.4, 7, 30)
  if (FLAT_KIND.has(it.kind)) return 5 * sc + 2
  const w = factsOf(it)?.weight
  if (w != null) return (5 + clamp(w, 0, 1) * 24) * sc + 2
  const r = routeOf(tree, it)
  if (r) return (7 + Math.log10(1 + Math.max(0, r.rps)) * 9) * sc + 2
  const lines = it.sym ? Math.max(1, it.sym.endLine - it.sym.line + 1) : 10
  return clamp(5 + Math.sqrt(lines) * 2.2, 6, 26) * sc + 2
}

// Axis-aligned route on the ground: along x, then y, then x (Z-shape).
function route(a: P2, b: P2, nudge: number): P2[] {
  if (Math.abs(a.y - b.y) < 0.5 || Math.abs(a.x - b.x) < 0.5) return [a, b]
  const mx = (a.x + b.x) / 2 + nudge
  return [a, { x: mx, y: a.y }, { x: mx, y: b.y }, b]
}
function offsetPoly(pts: P2[], o: number): P2[] {
  const n = pts.length
  const norm = (i: number) => {
    const dx = pts[i + 1].x - pts[i].x, dy = pts[i + 1].y - pts[i].y
    const l = Math.hypot(dx, dy) || 1
    return { x: -dy / l, y: dx / l }
  }
  return pts.map((p, i) => {
    const n0 = i > 0 ? norm(i - 1) : null
    const n1 = i < n - 1 ? norm(i) : null
    const nx = (n0?.x ?? 0) + (n1?.x ?? 0)
    const ny = (n0?.y ?? 0) + (n1?.y ?? 0)
    return { x: p.x + nx * o, y: p.y + ny * o }
  })
}

/** Which symbols own an outbound client (pg/redis): named for the client first, else
 *  the query symbols. Attached to the deepest visible owner; none → the file. */
function clientOwners(items: TItem[], proto: string): TItem[] {
  const all: TItem[] = []
  const walk = (xs: TItem[]) => { for (const x of xs) { all.push(x); walk(x.children) } }
  walk(items)
  const named = proto === 'postgres' ? /postgres|\bpool\b|\bpg\b/i : proto === 'redis' ? /redis|client/i : null
  if (!named) return []
  const byName = all.filter((x) => x.kind !== 'query' && x.kind !== 'config' && named.test(x.sym?.name ?? x.label))
  if (byName.length) return byName.filter((x) => !byName.some((y) => y !== x && startsWith(chainOf(x), chainOf(y))))
  return proto === 'postgres' ? all.filter((x) => x.kind === 'query' && !/schema/i.test(x.label)) : []
}

// ---------------------------------------------------------------------------
export default function IsoView(props: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const propsRef = useRef<Props>(props)
  propsRef.current = props

  const bodiesRef = useRef(new Map<string, Body>())
  const linksRef = useRef(new Map<string, LinkR>())
  const ghostsRef = useRef<Ghost[]>([])
  const burstsRef = useRef<{ id: string; age: number; color: string }[]>([])

  // ---- sync fleet → scene ---------------------------------------------------
  useEffect(() => {
    const fleet = props.fleet
    const bodies = bodiesRef.current
    const links = linksRef.current
    if (!fleet) {
      bodies.clear()
      links.clear()
      return
    }
    // Compute targets from this snapshot, not the previous scene. Otherwise a
    // newly arriving node gets a different slot than it would on a fresh load.
    const targets = new Map<string, { gx: number; gy: number }>()
    const occupied = (gx: number, gy: number, self: string) => {
      for (const [id, b] of targets) {
        if (id === self) continue
        if (Math.max(Math.abs(b.gx - gx), Math.abs(b.gy - gy)) < GRID * 2.5) return true
      }
      return false
    }
    const freeCell = (cx: number, cy: number, self: string) => {
      const cands: [number, number, number][] = []
      for (let dx = -8; dx <= 8; dx++) for (let dy = -8; dy <= 8; dy++) cands.push([dx, dy, Math.abs(dx) * 1.35 + Math.abs(dy) + (dy < 0 ? 0.01 : 0)])
      cands.sort((p, q) => p[2] - q[2])
      for (const [dx, dy] of cands) {
        const gx = cx + dx * GRID, gy = cy + dy * GRID
        if (!occupied(gx, gy, self)) return { x: gx, y: gy }
      }
      return { x: cx, y: cy }
    }
    const place = (n: FleetNode): { x: number; y: number; pin: boolean } => {
      const drop = takePlacement(n.id)
      if (drop) return { x: snap(drop.x), y: snap(drop.y), pin: true }
      const saved = n.id.startsWith('pending-') ? null : loadPos(n.label)
      if (saved) return { x: snap(saved.x), y: snap(saved.y), pin: true }
      const st = shapeOf(n.role)
      return { ...freeCell(st.ax * GRID, st.ay * GRID, n.id), pin: false }
    }

    const seen = new Set<string>()
    const isPinned = (n: FleetNode) => !!loadPos(n.label) || !!bodies.get(n.id)?.pinned
    const order = fleet.nodes.slice().sort((a, b) => Number(isPinned(b)) - Number(isPinned(a)))
    for (const n of order) {
      let b = bodies.get(n.id)
      if (!b) {
        const tmp = takeAlias(n.id)
        const old = tmp ? bodies.get(tmp) : undefined
        if (tmp && old) {
          bodies.delete(tmp)
          old.id = n.id
          bodies.set(n.id, old)
          b = old
          if (old.pinned) savePos(n.label, old.gx, old.gy)
        }
      }
      const p = b?.pinned ? { x: b.gx, y: b.gy, pin: true } : place(n)
      targets.set(n.id, { gx: p.x, gy: p.y })
      if (!b) {
        b = {
          id: n.id, node: n, pending: n.id.startsWith('pending-'), x: p.x, y: p.y, gx: p.x, gy: p.y, ox: 0, oy: 0,
          pinned: p.pin, ta: 0, alpha: 0, ex: 0, bootScale: 1, bootStart: performance.now(), bootPhase: n.status,
          lastIssueCount: (n.issues ?? []).length,
          bornAt: n.activation && Date.now() - n.activation.startedAt < 15000 ? performance.now() : performance.now() - 1000,
        }
        bodies.set(n.id, b)
        if (n.activation && n.activation.status !== 'ready') {
          const lb = [...bodies.values()].find(body => body.node.role === 'lb')
          if (lb) { b.x = lb.x + GRID; b.y = lb.y + GRID }
        }
      }
      b.gx = p.x
      b.gy = p.y
      b.pinned = p.pin
      if (b.bootPhase !== n.status) {
        b.bootPhase = n.status
        b.bootStart = performance.now()
      }
      const ic = (n.issues ?? []).length
      if (ic > b.lastIssueCount) burstsRef.current.push({ id: n.id, age: 0, color: issueLevel(n) === 'amber' ? C.amber : C.red })
      b.lastIssueCount = ic
      b.node = n
      b.pending = n.id.startsWith('pending-')
      seen.add(n.id)
    }
    for (const [id, b] of bodies) {
      if (seen.has(id)) continue
      ghostsRef.current.push({ x: b.x, y: b.y, role: b.node.role, t: 0 })
      bodies.delete(id)
    }

    const lseen = new Set<string>()
    for (const l of fleet.links) {
      const a = bodies.get(l.source)
      const b = bodies.get(l.target)
      if (!a || !b || a === b) continue
      let lr = links.get(l.id)
      if (!lr || lr.a !== a || lr.b !== b) {
        lr = { id: l.id, a, b, data: l, sF: 0, sR: 0, phF: 0, phR: 0, present: true, goneAt: 0, nudge: ((hash(l.id) % 5) - 2) * 7, bornAt: performance.now() }
        links.set(l.id, lr)
      }
      lr.data = l
      lr.present = true
      lseen.add(l.id)
    }
    const nowMs = Date.now()
    for (const [id, l] of links) {
      if (lseen.has(id)) continue
      const endsGone = bodies.get(l.a.id) !== l.a || bodies.get(l.b.id) !== l.b
      if (l.present) { l.present = false; l.goneAt = nowMs }
      if (endsGone || nowMs - l.goneAt > LINK_GRACE_MS) links.delete(id)
    }
  }, [props.fleet])

  // ---- canvas loop + interaction ---------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const host = canvas.parentElement
    const measure = () => {
      const r = host?.getBoundingClientRect()
      return { w: Math.max(1, Math.round(r?.width ?? window.innerWidth)), h: Math.max(1, Math.round(r?.height ?? window.innerHeight)) }
    }
    let { w: W, h: H } = measure()
    let dpr = 0
    const view = { k: 1, tx: W / 2, ty: H / 2 }
    let autoFit = true
    let focusN = -1
    let panTo: { x: number; y: number } | null = null
    let openSig = ''

    const exMap = new Map<string, number>() // openness per item (fk)
    const phases = new Map<string, number>() // flow phase per branch / call edge

    const pointers = new Map<number, { x: number; y: number }>()
    let press: { x: number; y: number; hit: Hit | null; moved: boolean; lastX: number; lastY: number; gdx: number; gdy: number } | null = null
    let pinch: { dist: number; k: number } | null = null
    let dragBody: Body | null = null
    let mouse: { x: number; y: number } | null = null
    let hover: Hit | null = null
    let hoverLink: LinkR | null = null
    let hits: Hit[] = []
    let visibleLinks = new Set<LinkR>()
    let routes = new Map<LinkR, P2[]>()
    let visByNode = new Map<string, Map<string, Vis>>()
    const agentsR = new Map<string, AgentR>()

    const resize = () => {
      const m = measure()
      const d = Math.min(window.devicePixelRatio || 1, 2)
      if (m.w === W && m.h === H && d === dpr) return
      dpr = d
      W = m.w
      H = m.h
      canvas.width = Math.floor(W * dpr)
      canvas.height = Math.floor(H * dpr)
      canvas.style.width = `${W}px`
      canvas.style.height = `${H}px`
    }
    resize()
    window.addEventListener('resize', resize)
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize)
    if (ro && host) ro.observe(host)

    const P = (x: number, y: number, z = 0) => ({ x: (x - y) * CX * view.k + view.tx, y: ((x + y) * CY - z) * view.k + view.ty })
    const toGround = (sx: number, sy: number) => {
      const a = (sx - view.tx) / view.k / CX
      const b = (sy - view.ty) / view.k / CY
      return { x: (a + b) / 2, y: (b - a) / 2 }
    }
    const zoomAround = (sx: number, sy: number, nk: number) => {
      const k = clamp(nk, 0.25, 6)
      view.tx = sx - ((sx - view.tx) * k) / view.k
      view.ty = sy - ((sy - view.ty) * k) / view.k
      view.k = k
    }
    const treeOf = (b: Body): CodeTree | null => treeFor(propsRef.current.codemap, b.node.role)
    const bx = (b: Body) => b.x + b.ox
    const by = (b: Body) => b.y + b.oy
    const exOf = (fk: string) => exMap.get(fk) ?? 0

    // ---- recursive layout: positions relative to the parent centre ----------------
    const levelLayout = (prefix: string, items: TItem[], d: number, tree: CodeTree): LevelLay => {
      const base = baseSlots(prefix, items, d, tree)
      const ext = new Map<string, number>()
      const sub = new Map<string, LevelLay>()
      for (const it of items) {
        const s = tileSize(it, d, tree)
        const e = it.children.length ? exOf(prefix + SEP + it.key) : 0
        let x = s / 2 + 2
        if (e > 0.001) {
          const L = levelLayout(prefix + SEP + it.key, it.children, d + 1, tree)
          sub.set(it.key, L)
          x = L.R * e + (s / 2) * (1 - e)
        }
        ext.set(it.key, x)
      }
      const pos = new Map<string, P2>()
      for (const [k, v] of base) pos.set(k, { x: v.x, y: v.y })
      // An open child "inserts space" in the grid: every sibling beyond its row/column
      // slides outward by the child's growth, so relative layout (and spacing) is kept.
      const margin = spacing(d) * 0.42
      for (const c of items) {
        const ec = ext.get(c.key)!
        const grow = ec - (tileSize(c, d, tree) / 2 + 2)
        if (grow <= 0.5) continue
        const shift = grow + margin * Math.min(1, grow / spacing(d))
        const pc = base.get(c.key)!
        for (const sib of items) {
          if (sib === c) continue
          const b0 = base.get(sib.key)!
          const ps = pos.get(sib.key)!
          if (b0.x > pc.x + 0.5) ps.x += shift
          else if (b0.x < pc.x - 0.5) ps.x -= shift
          if (b0.y > pc.y + 0.5) ps.y += shift
          else if (b0.y < pc.y - 0.5) ps.y -= shift
        }
      }
      let R = 0
      for (const it of items) {
        const p = pos.get(it.key)!
        R = Math.max(R, Math.max(Math.abs(p.x), Math.abs(p.y)) + ext.get(it.key)!)
      }
      return { pos, ext, sub, R: R + spacing(d) * 0.5 }
    }

    const nearestVisible = (nodeId: string, chain: string[]): Vis | null => {
      const m = visByNode.get(nodeId)
      if (!m) return null
      for (let i = chain.length - 1; i >= 0; i--) {
        const v = m.get(chain[i])
        if (v && v.a > 0.5) return v
      }
      return null
    }

    // ---- hit testing ---------------------------------------------------------------
    const segDist = (px: number, py: number, ax: number, ay: number, bx2: number, by2: number) => {
      const dx = bx2 - ax, dy = by2 - ay
      const L = dx * dx + dy * dy || 1
      const t = clamp(((px - ax) * dx + (py - ay) * dy) / L, 0, 1)
      return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
    }
    const hitTest = (x: number, y: number): Hit | null => {
      const g = toGround(x, y)
      for (let i = hits.length - 1; i >= 0; i--) {
        const h = hits[i]
        if (h.g) {
          if (Math.max(Math.abs(g.x - h.g.x), Math.abs(g.y - h.g.y)) <= h.g.R) return h
        } else if (Math.hypot(x - h.sx, y - h.sy) <= h.rs + 3) return h
      }
      return null
    }
    const linkAt = (x: number, y: number): LinkR | null => {
      let best: LinkR | null = null
      let bd = 7
      for (const l of visibleLinks) {
        const r = routes.get(l)
        if (!r || !l.present) continue
        const s = r.map((p) => P(p.x, p.y))
        for (let i = 0; i < s.length - 1; i++) {
          const d = segDist(x, y, s[i].x, s[i].y, s[i + 1].x, s[i + 1].y)
          if (d < bd) { bd = d; best = l }
        }
      }
      return best
    }

    // ---- input ------------------------------------------------------------------
    const pos = (e: MouseEvent) => {
      const r = canvas.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }
    const onDown = (e: PointerEvent) => {
      const p = pos(e)
      canvas.setPointerCapture(e.pointerId)
      pointers.set(e.pointerId, p)
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()]
        pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, k: view.k }
        press = null
        dragBody = null
        return
      }
      const hit = hitTest(p.x, p.y)
      let gdx = 0, gdy = 0
      if (hit?.kind === 'node') {
        const b = bodiesRef.current.get(hit.id)
        const g = toGround(p.x, p.y)
        if (b) { gdx = b.gx - g.x; gdy = b.gy - g.y }
      }
      press = { x: p.x, y: p.y, hit, moved: false, lastX: p.x, lastY: p.y, gdx, gdy }
    }
    const onMove = (e: PointerEvent) => {
      const p = pos(e)
      mouse = p
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p)
      if (pinch && pointers.size >= 2) {
        const [a, b] = [...pointers.values()]
        autoFit = false
        zoomAround((a.x + b.x) / 2, (a.y + b.y) / 2, (pinch.k * (Math.hypot(a.x - b.x, a.y - b.y) || 1)) / pinch.dist)
        return
      }
      if (!press) {
        hover = hitTest(p.x, p.y)
        hoverLink = hover && !hover.g ? null : linkAt(p.x, p.y)
        if (hoverLink && hover?.g) hover = null
        canvas.style.cursor = hover || hoverLink ? 'pointer' : 'grab'
        return
      }
      if (!press.moved && Math.hypot(p.x - press.x, p.y - press.y) > 3) {
        press.moved = true
        const h = press.hit
        if (h?.kind === 'node' && !h.g) dragBody = bodiesRef.current.get(h.id) ?? null
        canvas.style.cursor = 'grabbing'
      }
      if (!press.moved) return
      if (dragBody) {
        const g = toGround(p.x, p.y)
        dragBody.gx = snap(g.x + press.gdx)
        dragBody.gy = snap(g.y + press.gdy)
        dragBody.pinned = true
      } else {
        autoFit = false
        view.tx += p.x - press.lastX
        view.ty += p.y - press.lastY
      }
      press.lastX = p.x
      press.lastY = p.y
    }
    const onUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId)
      if (pinch) {
        if (pointers.size < 2) pinch = null
        return
      }
      if (press && !press.moved) {
        const h = press.hit
        const Pp = propsRef.current
        const cur = Pp.selected?.kind === 'node' ? Pp.selected : null
        if (h?.kind === 'badge') Pp.onSelect({ kind: 'node', id: h.id, path: h.keys ?? [] })
        else if (h?.kind === 'item' && h.keys) {
          // clicking the current item steps back up one level; anything else opens/selects it
          if (cur && cur.id === h.id && sameKeys(cur.path ?? [], h.keys)) Pp.onSelect({ kind: 'node', id: h.id, path: h.keys.slice(0, -1) })
          else Pp.onSelect({ kind: 'node', id: h.id, path: h.keys })
        } else if (h?.kind === 'node') {
          if (cur && cur.id === h.id) Pp.onSelect((cur.path ?? []).length ? { kind: 'node', id: h.id, path: [] } : null)
          else Pp.onSelect({ kind: 'node', id: h.id })
        } else {
          const l = linkAt(press.x, press.y)
          Pp.onSelect(l ? { kind: 'link', id: l.id } : null)
        }
      }
      if (dragBody) {
        if (!dragBody.pending) savePos(dragBody.node.label, dragBody.gx, dragBody.gy)
        dragBody = null
      }
      press = null
      canvas.style.cursor = hover ? 'pointer' : 'grab'
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      autoFit = false
      const p = pos(e)
      zoomAround(p.x, p.y, view.k * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)))
    }
    const onDbl = () => { autoFit = true }
    const onLeave = () => { mouse = null; hover = null; hoverLink = null }
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('text/ari-role')) {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }
    }
    const onDrop = (e: DragEvent) => {
      const role = e.dataTransfer?.getData('text/ari-role')
      if (!role) return
      e.preventDefault()
      const p = pos(e)
      const g = toGround(p.x, p.y)
      propsRef.current.onDropRole(role, snap(g.x), snap(g.y))
    }

    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointercancel', onUp)
    canvas.addEventListener('pointerleave', onLeave)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('dblclick', onDbl)
    canvas.addEventListener('dragover', onDragOver)
    canvas.addEventListener('drop', onDrop)
    canvas.style.cursor = 'grab'

    // ---- drawing primitives -------------------------------------------------------
    const poly = (pts: { x: number; y: number }[]) => {
      ctx.beginPath()
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)))
      ctx.closePath()
    }
    const faces = (tint: string | null, t: number) => ({
      top: tint ? mix(C.top, tint, 0.1 * t) : C.top,
      left: tint ? mix(C.left, tint, 0.14 * t) : C.left,
      right: tint ? mix(C.right, tint, 0.16 * t) : C.right,
    })
    type Faces = ReturnType<typeof faces>
    const box = (x: number, y: number, z0: number, w: number, d: number, h: number, f: Faces) => {
      const x0 = x - w / 2, x1 = x + w / 2, y0 = y - d / 2, y1 = y + d / 2, z1 = z0 + h
      ctx.lineWidth = 0.8
      ctx.lineJoin = 'round'
      ctx.strokeStyle = C.edge
      poly([P(x1, y0, z0), P(x1, y1, z0), P(x1, y1, z1), P(x1, y0, z1)])
      ctx.fillStyle = f.right; ctx.fill(); ctx.stroke()
      poly([P(x0, y1, z0), P(x1, y1, z0), P(x1, y1, z1), P(x0, y1, z1)])
      ctx.fillStyle = f.left; ctx.fill(); ctx.stroke()
      poly([P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1)])
      ctx.fillStyle = f.top; ctx.fill(); ctx.stroke()
    }
    const onPlane = (x: number, y: number, z: number, fn: () => void) => {
      const c = P(x, y, z)
      ctx.save()
      ctx.setTransform(dpr * view.k * CX * Math.SQRT2, 0, 0, dpr * view.k * CY * Math.SQRT2, dpr * c.x, dpr * c.y)
      fn()
      ctx.restore()
    }
    const topIcon = (x: number, y: number, z: number, s: number, col: string, glyph: string, a: number) => {
      const h = s / 2
      poly([P(x - h, y - h, z), P(x + h, y - h, z), P(x + h, y + h, z), P(x - h, y + h, z)])
      ctx.fillStyle = rgba(col, a)
      ctx.fill()
      if (glyph && s * view.k > 15) {
        onPlane(x, y, z, () => {
          ctx.fillStyle = 'rgba(255,255,255,0.96)'
          ctx.font = `700 ${Math.max(6, Math.min(11, s * 0.34))}px ${SANS}`
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(glyph, 0, 0.5)
        })
      }
    }
    const lockGlyph = (x: number, y: number, z: number, s: number) => {
      onPlane(x, y, z, () => {
        const u = s * 0.18
        ctx.fillStyle = '#ffffff'
        ctx.strokeStyle = '#ffffff'
        ctx.lineWidth = u * 0.55
        ctx.beginPath(); ctx.arc(0, -u * 0.55, u * 0.75, Math.PI, 0); ctx.stroke()
        ctx.fillRect(-u * 1.15, -u * 0.6, u * 2.3, u * 1.8)
      })
    }
    const groundEllipse = (x: number, y: number, z: number, r: number) => {
      const c = P(x, y, z)
      return { cx: c.x, cy: c.y, rx: r * Math.SQRT2 * CX * view.k, ry: r * Math.SQRT2 * CY * view.k }
    }
    const cylinder = (x: number, y: number, z0: number, r: number, h: number, f: Faces, bands: number) => {
      const b = groundEllipse(x, y, z0, r)
      const t = groundEllipse(x, y, z0 + h, r)
      const g = ctx.createLinearGradient(b.cx - b.rx, 0, b.cx + b.rx, 0)
      g.addColorStop(0, f.left)
      g.addColorStop(0.55, mix(f.left, f.right, 0.5))
      g.addColorStop(1, f.right)
      ctx.beginPath()
      ctx.moveTo(t.cx - t.rx, t.cy)
      ctx.lineTo(b.cx - b.rx, b.cy)
      ctx.ellipse(b.cx, b.cy, b.rx, b.ry, 0, Math.PI, 0, true)
      ctx.lineTo(t.cx + t.rx, t.cy)
      ctx.closePath()
      ctx.fillStyle = g
      ctx.fill()
      ctx.strokeStyle = C.edge
      ctx.lineWidth = 0.8
      ctx.stroke()
      for (let i = 1; i <= bands; i++) {
        const m = groundEllipse(x, y, z0 + (h * i) / (bands + 1), r)
        ctx.beginPath(); ctx.ellipse(m.cx, m.cy, m.rx, m.ry, 0, 0, Math.PI); ctx.stroke()
      }
      ctx.beginPath(); ctx.ellipse(t.cx, t.cy, t.rx, t.ry, 0, 0, Math.PI * 2)
      ctx.fillStyle = f.top
      ctx.fill(); ctx.stroke()
    }
    const shadow = (x: number, y: number, w: number, d: number, h: number, a: number) => {
      const s = h * 0.45
      const pts = [P(x - w / 2, y - d / 2), P(x + w / 2 + s, y - d / 2), P(x + w / 2 + s, y + d / 2 + 3), P(x - w / 2, y + d / 2 + 3)]
      ctx.fillStyle = `rgba(36,52,80,${0.13 * a})`
      poly(pts)
      ctx.fill()
    }
    // "expandable" affordance: a lid seam just under the top edge
    const seam = (x: number, y: number, w: number, d: number, z: number) => {
      ctx.strokeStyle = 'rgba(40,56,84,0.45)'
      ctx.lineWidth = 1
      const a = P(x - w / 2, y + d / 2, z), b = P(x + w / 2, y + d / 2, z), c = P(x + w / 2, y - d / 2, z)
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.stroke()
    }

    const drawBlock = (n: FleetNode, x: number, y: number, z0: number, tint: string | null, ta: number, a: number, lidLift: number) => {
      const st = shapeOf(n.role)
      const f = faces(tint, ta)
      const running = n.status === 'running'
      ctx.globalAlpha = a
      switch (st.kind) {
        case 'cyl': {
          const r = st.w / 2
          cylinder(x, y, z0, r, st.h, f, 2)
          const e = groundEllipse(x, y, z0 + st.h + lidLift, r * 0.6)
          ctx.beginPath(); ctx.ellipse(e.cx, e.cy, e.rx, e.ry, 0, 0, Math.PI * 2)
          ctx.fillStyle = st.color
          ctx.fill()
          if (r * view.k > 12) onPlane(x, y, z0 + st.h, () => {
            ctx.fillStyle = '#fff'; ctx.font = `700 9px ${SANS}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(st.glyph, 0, 0.5)
          })
          break
        }
        case 'disc': {
          const r = st.w / 2
          cylinder(x, y, z0, r, st.h, f, 0)
          const e = groundEllipse(x, y, z0 + st.h, r * 0.7)
          ctx.setLineDash([2, 3]); ctx.strokeStyle = rgba(st.color, 0.9); ctx.lineWidth = 1.2
          ctx.beginPath(); ctx.ellipse(e.cx, e.cy, e.rx, e.ry, 0, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([])
          if (r * view.k > 12) onPlane(x, y, z0 + st.h, () => {
            ctx.fillStyle = st.color; ctx.font = `700 9px ${SANS}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(st.glyph, 0, 0.5)
          })
          break
        }
        case 'stack': {
          const sh = (st.h - 6) / 3
          for (let i = 0; i < 3; i++) {
            const zz = z0 + i * (sh + 3) + (i === 2 ? lidLift : 0)
            box(x, y, zz, st.w - i * 2, st.d - i * 2, sh, f)
            ctx.strokeStyle = rgba(st.color, 0.75)
            ctx.lineWidth = 1.4
            const yy = y + (st.d - i * 2) / 2
            const p0 = P(x - (st.w - i * 2) / 2 + 4, yy, zz + sh / 2), p1 = P(x + (st.w - i * 2) / 2 - 4, yy, zz + sh / 2)
            ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke()
          }
          topIcon(x, y, z0 + st.h + lidLift, st.w * 0.55, st.color, st.glyph, 1)
          break
        }
        case 'server': {
          box(x, y, z0, st.w, st.d, st.h - 4, f)
          const yy = y + st.d / 2
          for (let i = 1; i < 4; i++) {
            const zz = z0 + ((st.h - 4) * i) / 4
            const p0 = P(x - st.w / 2 + 3, yy, zz), p1 = P(x + st.w / 2 - 3, yy, zz)
            ctx.strokeStyle = 'rgba(40,56,84,0.25)'; ctx.lineWidth = 0.8
            ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke()
            const led = P(x + st.w / 2 - 7, yy, zz + (st.h - 4) / 8)
            ctx.fillStyle = running ? st.color : '#9aa5b5'
            ctx.fillRect(led.x - 1.5, led.y - 1, 3, 2)
          }
          box(x, y, z0 + st.h - 4 + lidLift, st.w, st.d, 4, f)
          topIcon(x, y, z0 + st.h + lidLift, st.w * 0.55, st.color, st.glyph, 1)
          break
        }
        case 'client': {
          box(x, y, z0, st.w, st.d, st.h, f)
          const yy = y + st.d / 2
          poly([P(x - st.w / 2 + 5, yy, z0 + 8), P(x + st.w / 2 - 5, yy, z0 + 8), P(x + st.w / 2 - 5, yy, z0 + st.h - 5), P(x - st.w / 2 + 5, yy, z0 + st.h - 5)])
          ctx.fillStyle = mix('#33415a', st.color, 0.3)
          ctx.fill()
          topIcon(x, y, z0 + st.h + lidLift, st.w * 0.55, st.color, st.glyph, 1)
          break
        }
        case 'slab': {
          box(x, y, z0, st.w, st.d, st.h, f)
          topIcon(x, y, z0 + st.h + lidLift, Math.min(st.w, st.d) * 0.6, st.color, st.glyph, 1)
          break
        }
        default: {
          box(x, y, z0, st.w, st.d, st.h, f)
          topIcon(x, y, z0 + st.h + lidLift, st.w * 0.58, st.color, st.glyph, 1)
        }
      }
      ctx.globalAlpha = 1
    }

    const intensity = (bps: number) => clamp(Math.log10(1 + bps / 1024) / 3.5, 0, 1)
    const laneSpeed = (bps: number) => (bps < 1 ? 0 : 12 + 40 * intensity(bps))
    const rpsIntensity = (rps: number) => clamp(Math.log10(1 + rps) / 2.6, 0, 1)
    const strokePath = (pts: P2[], z = 0) => {
      ctx.beginPath()
      pts.forEach((p, i) => {
        const s = P(p.x, p.y, z)
        if (i) ctx.lineTo(s.x, s.y)
        else ctx.moveTo(s.x, s.y)
      })
      ctx.stroke()
    }
    const lane = (pts: P2[], it: number, col: string, phase: number, alpha: number, off: number, width: number) => {
      if (it <= 0) return
      ctx.setLineDash([5, 24 - 14 * it])
      ctx.lineDashOffset = -phase
      ctx.lineCap = 'butt'
      ctx.lineWidth = width
      ctx.strokeStyle = rgba(col, (0.55 + 0.45 * it) * alpha)
      strokePath(off ? offsetPoly(pts, off) : pts)
      ctx.setLineDash([])
      ctx.lineDashOffset = 0
    }

    const drawTooltip = (lines: { t: string; c?: string }[], anchor: { x: number; y: number; r: number }, side: 'node' | 'cursor') => {
      ctx.font = `400 11px ${MONO}`
      const maxW = Math.min(380, W - 24)
      const shown = lines.map((l) => ({ t: truncate(ctx, l.t, maxW - 20), c: l.c }))
      const w = Math.min(maxW, Math.max(...shown.map((l) => ctx.measureText(l.t).width)) + 20)
      const h = shown.length * 16 + 12
      let x: number
      let y: number
      if (side === 'node') {
        x = anchor.x + anchor.r + 14
        if (x + w > W - 8) x = anchor.x - anchor.r - 14 - w
        y = anchor.y - h / 2
      } else {
        x = anchor.x + 14
        y = anchor.y + 14
        if (x + w > W - 8) x = anchor.x - 14 - w
        if (y + h > H - 8) y = anchor.y - 14 - h
      }
      x = clamp(x, 8, W - 8 - w)
      y = clamp(y, 100, H - 8 - h)
      ctx.save()
      ctx.shadowColor = 'rgba(30,45,70,0.18)'
      ctx.shadowBlur = 14
      ctx.shadowOffsetY = 4
      ctx.fillStyle = '#ffffff'
      ctx.beginPath(); ctx.roundRect(x, y, w, h, 6); ctx.fill()
      ctx.restore()
      ctx.strokeStyle = 'rgba(60,80,110,0.18)'
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, 6); ctx.stroke()
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      shown.forEach((l, i) => {
        ctx.font = i === 0 ? `600 11px ${MONO}` : `400 11px ${MONO}`
        ctx.fillStyle = l.c ?? (i === 0 ? C.ink : C.dim)
        ctx.fillText(l.t, x + 10, y + 7 + i * 16)
      })
    }

    // ---- frame ------------------------------------------------------------------
    let raf = 0
    let last = performance.now()
    const frame = (now: number) => {
      const dt = Math.min(0.25, Math.max(0, (now - last) / 1000))
      last = now
      const Pp = propsRef.current
      const red = Pp.reduced
      const incidentImpact = Pp.metrics?.mode === 'surge' && !Pp.metrics?.stale
      const padT = Pp.insets?.top ?? TOP_PAD
      const padB = Pp.insets?.bottom ?? BOTTOM_PAD
      const padL = Pp.insets?.left ?? LEFT_PAD
      const padR = Math.max(Pp.insets?.right ?? RIGHT_PAD, Pp.rightInset)
      const pulse = red ? 1 : 0.7 + 0.3 * Math.sin(now / 380)
      const bodies = bodiesRef.current
      const links = linksRef.current
      const k = view.k
      const sel = Pp.selected
      const ease = (rate: number) => (red ? 1 : 1 - Math.exp(-dt * rate))

      // -- open chain from the selection: the server + every item with children on the path
      const selNodeId = sel?.kind === 'node' && bodies.has(sel.id) ? sel.id : null
      const selBody = selNodeId ? bodies.get(selNodeId)! : null
      const selTree = selBody ? treeOf(selBody) : null
      const selPath = sel?.kind === 'node' ? sel.path ?? [] : []
      const openFks = new Set<string>()
      let selFk: string | null = null
      if (selBody && selTree) {
        openFks.add(selBody.id)
        let level = selTree.files
        let fk = selBody.id
        for (const key of selPath) {
          const it = level.find((x) => x.key === key)
          if (!it) break
          fk += SEP + key
          selFk = fk
          if (!it.children.length) break
          openFks.add(fk)
          level = it.children
        }
      }
      const sig = [...openFks].join('|')
      if (sig !== openSig) {
        openSig = sig
        autoFit = true // opening/closing a level re-frames the view
      }
      for (const fk of openFks) if (!exMap.has(fk)) exMap.set(fk, 0)
      for (const [fk, v] of exMap) {
        const nv = v + ((openFks.has(fk) ? 1 : 0) - v) * ease(7)
        if (nv < 0.001 && !openFks.has(fk)) exMap.delete(fk)
        else exMap.set(fk, nv)
      }

      // -- per-server layout of the open tree ---------------------------------------
      const nodeLay = new Map<string, { lay: LevelLay; tree: CodeTree }>()
      let dimAll = 0
      for (const b of bodies.values()) {
        b.ex = exOf(b.id)
        dimAll = Math.max(dimAll, b.ex)
        const tree = b.ex > 0.001 ? treeOf(b) : null
        if (tree) nodeLay.set(b.id, { lay: levelLayout(b.id, tree.files, 1, tree), tree })
        const entering = b.node.activation && now - b.bornAt < 1000
        b.x += (b.gx - b.x) * ease(entering ? 4 : 14)
        b.y += (b.gy - b.y) * ease(entering ? 4 : 14)
      }
      const nodeR = (b: Body) => {
        const st = shapeOf(b.node.role)
        const fr = Math.max(st.w, st.d) / 2
        const nl = nodeLay.get(b.id)
        return nl ? nl.lay.R * b.ex + fr * (1 - b.ex) : fr
      }
      // make room around opened servers (visual only, never persisted): servers beyond
      // its row/column slide outward by how much it grew
      for (const b of bodies.values()) {
        let tx = 0, ty = 0
        for (const o of bodies.values()) {
          if (o === b || o.ex < 0.01 || !nodeLay.has(o.id)) continue
          const so = shapeOf(o.node.role)
          const shift = Math.max(0, nodeR(o) - Math.max(so.w, so.d) / 2) + 70 * o.ex
          if (b.gx > o.gx + 0.5) tx += shift
          else if (b.gx < o.gx - 0.5) tx -= shift
          if (b.gy > o.gy + 0.5) ty += shift
          else if (b.gy < o.gy - 0.5) ty -= shift
        }
        b.ox += (tx - b.ox) * ease(7)
        b.oy += (ty - b.oy) * ease(7)
      }

      // -- visible items + platforms (world positions) -----------------------------
      const plats: Plat[] = []
      const visList: Vis[] = []
      visByNode = new Map()
      for (const b of bodies.values()) {
        const nl = nodeLay.get(b.id)
        if (!nl || b.ex < 0.01) continue
        const m = new Map<string, Vis>()
        visByNode.set(b.id, m)
        plats.push({ b, fk: b.id, keys: [], x: bx(b), y: by(b), R: nodeR(b), d: 1, e: b.ex })
        const walk = (lay: LevelLay, items: TItem[], cx: number, cy: number, pe: number, d: number, keys: string[], prefix: string) => {
          for (const it of items) {
            const rel = lay.pos.get(it.key)
            if (!rel) continue
            const fk = prefix + SEP + it.key
            const e = it.children.length ? exOf(fk) : 0
            const s = tileSize(it, d, nl.tree) * (0.4 + 0.6 * pe)
            const sub = lay.sub.get(it.key)
            const R = sub ? sub.R * e + (s / 2) * (1 - e) : s / 2
            const v: Vis = { b, it, keys: [...keys, it.key], fk, x: cx + rel.x * pe, y: cy + rel.y * pe, s, h: tileHeight(it, d, nl.tree) * pe, a: pe, e, d, R }
            m.set(it.key, v)
            visList.push(v)
            if (sub && e > 0.01) {
              plats.push({ b, fk, keys: v.keys, x: v.x, y: v.y, R, d: d + 1, e })
              walk(sub, it.children, v.x, v.y, e, d + 1, v.keys, fk)
            }
          }
        }
        walk(nl.lay, nl.tree.files, bx(b), by(b), b.ex, 1, [], b.id)
      }

      const itemsOfFk = (pl: Plat): TItem[] => {
        const nl = nodeLay.get(pl.b.id)
        if (!nl) return []
        if (!pl.keys.length) return nl.tree.files
        return visByNode.get(pl.b.id)?.get(pl.keys[pl.keys.length - 1])?.it.children ?? []
      }
      // -- camera: follow pan requests, else fit the fleet or the deepest open level ----
      if (Pp.focus && Pp.focus.n !== focusN) {
        focusN = Pp.focus.n
        const b = bodies.get(Pp.focus.id)
        if (b) { autoFit = false; panTo = { x: bx(b), y: by(b) } }
      }
      const aw = Math.max(200, W - padL - padR)
      const ah = Math.max(160, H - padT - padB)
      if (panTo) {
        const cx = padL + aw / 2
        const cy = padT + ah / 2
        const t = ease(6)
        const tx = cx - (panTo.x - panTo.y) * CX * view.k
        const ty = cy - (panTo.x + panTo.y) * CY * view.k
        view.tx += (tx - view.tx) * t
        view.ty += (ty - view.ty) * t
        if (Math.abs(tx - view.tx) + Math.abs(ty - view.ty) < 1) panTo = null
      }
      if (autoFit && !dragBody) {
        let f: { k: number; tx: number; ty: number } | null = null
        const deep = plats.filter((p) => p.d >= 2 && openFks.has(p.fk)).sort((a, b) => b.d - a.d)[0]
        if (deep) {
          // fit the deepest open platform; zoom in further if its tiles would be too tight to read
          const u = (deep.x - deep.y) * CX, v = (deep.x + deep.y) * CY
          const hu = 2 * deep.R * CX + 40, hv = 2 * deep.R * CY + 30
          const kFit = Math.min(aw / (2 * hu), ah / (2 * hv + 60))
          // widest tile label on that level decides how far apart neighbours must be on screen
          const kids = itemsOfFk(deep)
          ctx.font = `500 10px ${MONO}`
          let lw = READ_PX - 24
          for (const it of kids) lw = Math.max(lw, Math.min(170, ctx.measureText(it.label).width + 60))
          // tiles side by side on screen only exist from the 3rd tile on; before that,
          // neighbours are diagonal and just need a label's height between them
          const sp = spacing(deep.d)
          const kRead = Math.max(44 / sp, kids.length >= 3 ? (lw + 24) / (2 * CX * sp) : 0)
          const kk = clamp(Math.max(kFit, kRead), 0.3, 6)
          f = { k: kk, tx: padL + aw / 2 - u * kk, ty: padT + ah / 2 - (v - 20) * kk }
        } else if (bodies.size) {
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
          for (const b of bodies.values()) {
            const st = shapeOf(b.node.role)
            const r = nodeR(b)
            const X = bx(b), Y = by(b)
            const u = (X - Y) * CX, v = (X + Y) * CY
            const hu = 2 * r * CX, hv = 2 * r * CY
            x0 = Math.min(x0, u - hu - 50); x1 = Math.max(x1, u + hu + 50)
            y0 = Math.min(y0, v - hv - st.h - 62); y1 = Math.max(y1, v + hv + 20)
          }
          const kk = clamp(Math.min(aw / (x1 - x0), ah / (y1 - y0)), 0.3, 1.5)
          f = { k: kk, tx: padL + aw / 2 - ((x0 + x1) / 2) * kk, ty: padT + ah / 2 - ((y0 + y1) / 2) * kk }
        }
        if (f) {
          const t = ease(4)
          view.k += (f.k - view.k) * t
          view.tx += (f.tx - view.tx) * t
          view.ty += (f.ty - view.ty) * t
        }
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.globalAlpha = 1
      ctx.fillStyle = C.bg
      ctx.fillRect(0, 0, W, H)

      // -- isometric ground grid (blueprint) ---------------------------------------
      {
        const corners = [toGround(0, 0), toGround(W, 0), toGround(0, H), toGround(W, H)]
        const gx0 = Math.min(...corners.map((c) => c.x)), gx1 = Math.max(...corners.map((c) => c.x))
        const gy0 = Math.min(...corners.map((c) => c.y)), gy1 = Math.max(...corners.map((c) => c.y))
        let step = GRID
        while (step * view.k * CX < 14) step *= 2
        const i0 = Math.floor(gx0 / step), i1 = Math.ceil(gx1 / step)
        const j0 = Math.floor(gy0 / step), j1 = Math.ceil(gy1 / step)
        if (i1 - i0 < 400 && j1 - j0 < 400) {
          for (const major of [false, true]) {
            ctx.strokeStyle = major ? 'rgba(70,105,155,0.16)' : 'rgba(70,105,155,0.075)'
            ctx.lineWidth = 1
            ctx.beginPath()
            for (let i = i0; i <= i1; i++) {
              if ((i % 5 === 0) !== major) continue
              const a = P(i * step, gy0), b = P(i * step, gy1)
              ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y)
            }
            for (let j = j0; j <= j1; j++) {
              if ((j % 5 === 0) !== major) continue
              const a = P(gx0, j * step), b = P(gx1, j * step)
              ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y)
            }
            ctx.stroke()
          }
        }
      }

      const newHits: Hit[] = []
      const dimOf = (b: Body) => 1 - 0.55 * Math.max(0, dimAll - b.ex)
      const errTint = Pp.metrics ? clamp(Pp.metrics.errorRate / 10, 0, 0.6) : 0

      // -- agents → per-node check-job state ---------------------------------------
      for (const r of agentsR.values()) r.active = false
      for (const a of Pp.agents) {
        if (Pp.live && a.simulated) continue
        if (!bodies.has(a.targetNodeId)) continue
        let r = agentsR.get(a.id)
        if (!r) {
          if (!ACTIVE_AGENT.has(a.status)) continue
          r = { id: a.id, type: a.type, note: a.note ?? '', status: a.status, progress: a.progress, target: a.targetNodeId, alpha: 0, active: true }
          agentsR.set(a.id, r)
        }
        r.type = a.type; r.note = a.note ?? ''; r.status = a.status
        r.progress = clamp(a.progress, 0, 1); r.target = a.targetNodeId
        r.active = ACTIVE_AGENT.has(a.status)
      }
      const jobsByNode = new Map<string, AgentR[]>()
      for (const [id, r] of agentsR) {
        r.alpha = r.active ? Math.min(1, r.alpha + dt * 3) : r.alpha - dt / 1.5
        if (r.alpha <= 0 || !bodies.has(r.target)) { agentsR.delete(id); continue }
        const arr = jobsByNode.get(r.target) ?? []
        arr.push(r)
        jobsByNode.set(r.target, arr)
      }

      const phaseStep = (key: string, speed: number) => {
        const p = (phases.get(key) ?? 0) + (red ? 0 : speed * dt)
        phases.set(key, p)
        return p
      }

      // -- platforms (ground), shallow → deep, with their import / call edges ---------
      plats.sort((a, b) => a.d - b.d)
      for (const pl of plats) {
        const col = shapeOf(pl.b.node.role).color
        ctx.globalAlpha = pl.e
        const R = pl.R
        poly([P(pl.x - R, pl.y - R, 0), P(pl.x + R, pl.y - R, 0), P(pl.x + R, pl.y + R, 0), P(pl.x - R, pl.y + R, 0)])
        ctx.fillStyle = pl.d === 1 ? 'rgba(255,255,255,0.72)' : 'rgba(246,249,253,0.92)'
        ctx.fill()
        ctx.strokeStyle = rgba(col, pl.d === 1 ? 0.55 : 0.45)
        ctx.lineWidth = pl.d === 1 ? 1.2 : 1
        ctx.setLineDash(pl.d === 1 ? [5, 4] : [3, 3])
        ctx.stroke()
        ctx.setLineDash([])
        ctx.globalAlpha = 1
      }
      for (const [nodeId, m] of visByNode) {
        const nl = nodeLay.get(nodeId)
        if (!nl) continue
        // file imports (file level)
        ctx.strokeStyle = 'rgba(40,56,84,0.3)'
        ctx.lineWidth = 1
        for (const ed of nl.tree.role.edges) {
          const A = m.get(ed.from), B = m.get(ed.to)
          if (!A || !B || A.a < 0.05) continue
          ctx.globalAlpha = A.a
          strokePath(route(A, B, 0))
        }
        ctx.globalAlpha = 1
        // calls between visible symbols (each end rolls up to its nearest visible ancestor)
        const drawn = new Set<string>()
        for (const it of nl.tree.byKey.values()) {
          if (!it.sym || !it.sym.calls?.length) continue
          const from = nearestVisible(nodeId, chainOf(it))
          if (!from) continue
          const stat = from.it === it ? routeOf(nl.tree, it) : null
          for (const cid of it.sym.calls) {
            const cit = nl.tree.byKey.get(cid)
            if (!cit) continue
            const to = nearestVisible(nodeId, chainOf(cit))
            if (!to || to === from) continue
            if (startsWith(from.keys, to.keys) || startsWith(to.keys, from.keys)) continue // containment, not a call
            if (from.d < 2 && to.d < 2) continue // file↔file is already shown as imports
            const key = from.fk + '>' + to.fk
            if (drawn.has(key) && !stat) continue
            drawn.add(key)
            const pts = route(from, to, 0)
            const al = Math.min(from.a, to.a)
            ctx.globalAlpha = al
            ctx.strokeStyle = 'rgba(40,56,84,0.42)'
            ctx.lineWidth = 1
            ctx.setLineDash(from.it === it && to.it === cit ? [] : [2, 3])
            strokePath(pts)
            ctx.setLineDash([])
            // arrowhead at the callee
            const q = P(to.x, to.y), pq = P(pts[pts.length - 2].x, pts[pts.length - 2].y)
            const ang = Math.atan2(q.y - pq.y, q.x - pq.x)
            const back = Math.min(to.s * k * 0.75 + 3, 18)
            const hx = q.x - Math.cos(ang) * back, hy = q.y - Math.sin(ang) * back
            ctx.fillStyle = 'rgba(40,56,84,0.55)'
            ctx.beginPath()
            ctx.moveTo(hx, hy)
            ctx.lineTo(hx - Math.cos(ang - 0.45) * 6, hy - Math.sin(ang - 0.45) * 6)
            ctx.lineTo(hx - Math.cos(ang + 0.45) * 6, hy - Math.sin(ang + 0.45) * 6)
            ctx.closePath(); ctx.fill()
            // a route's real rps animates its outgoing calls
            if (stat && stat.rps > 0) {
              const ri = rpsIntensity(stat.rps)
              const col = mix(KIND_COLOR.route, C.red, clamp(errFrac(stat.errorRate) * 6, 0, 0.75))
              lane(pts, ri, col, phaseStep(key, 10 + 30 * ri), al, 0, 2)
            }
            ctx.globalAlpha = 1
          }
        }
      }

      // -- link endpoints: the deepest visible element that owns the traffic ----------
      type Branch = { to: Vis; rps: number; err: number; live: boolean }
      const endPos = (b: Body, l: LinkR, outgoing: boolean): { x: number; y: number; branches: Branch[] } => {
        const base = { x: bx(b), y: by(b), branches: [] as Branch[] }
        if (b.ex < 0.01) return base
        const nl = nodeLay.get(b.id)
        if (!nl) return base
        const dir = outgoing ? 'out' : 'in'
        const ports = nl.tree.role.ports
        const pe = ports.find((p) => p.port === l.data.port && p.dir === dir) ?? ports.find((p) => p.port === l.data.port)
        const fv = pe ? visByNode.get(b.id)?.get(pe.file) : undefined
        if (!pe || !fv) return base
        if (fv.e < 0.5 || !fv.it.children.length) return { x: fv.x, y: fv.y, branches: [] }
        if (!outgoing && nl.tree.routes.size) {
          const agg = new Map<string, Branch>()
          for (const r of nl.tree.routes.values()) {
            const it = nl.tree.byKey.get(r.symbolId)
            if (!it || it.file !== pe.file) continue
            const v = nearestVisible(b.id, chainOf(it))
            if (!v || v === fv) continue
            const cur = agg.get(v.fk) ?? { to: v, rps: 0, err: 0, live: true }
            cur.rps += Math.max(0, r.rps)
            cur.err = Math.max(cur.err, errFrac(r.errorRate))
            agg.set(v.fk, cur)
          }
          return { x: fv.x, y: fv.y, branches: [...agg.values()] }
        }
        if (outgoing) {
          const owners = new Map<string, Vis>()
          for (const it of clientOwners(fv.it.children, l.data.protocol)) {
            const v = nearestVisible(b.id, chainOf(it))
            if (v && v !== fv) owners.set(v.fk, v)
          }
          const list = [...owners.values()]
          if (list.length === 1) return { x: list[0].x, y: list[0].y, branches: [] }
          return { x: fv.x, y: fv.y, branches: list.map((to) => ({ to, rps: 0, err: 0, live: false })) }
        }
        return { x: fv.x, y: fv.y, branches: [] }
      }

      // -- pipes: ground cables routed along the grid + iso dashes for bytes/s -----
      const nextVisible = new Set<LinkR>()
      const nextRoutes = new Map<LinkR, P2[]>()
      const branchJobs: { from: P2; br: Branch; key: string; col: string; da: number }[] = []
      for (const l of links.values()) {
        const s = 1 - Math.exp(-dt / 1.2)
        l.sF += (Math.max(0, l.data.bytesPerSec) - l.sF) * s
        l.sR += (Math.max(0, l.data.bytesPerSecReverse) - l.sR) * s
        if (!red) {
          l.phF += laneSpeed(l.sF) * dt * (incidentImpact ? 3 : 1)
          l.phR += laneSpeed(l.sR) * dt * (incidentImpact ? 3 : 1)
        }
        if (!l.present) continue
        const col = incidentImpact ? C.red : PROTO_COLOR[l.data.protocol] ?? PROTO_COLOR.other
        const control = isControl(l.data.protocol)
        const isSel = sel?.kind === 'link' && sel.id === l.id
        const ctlLink = control && (l.a.node.role === 'controller' || l.b.node.role === 'controller')
        if (ctlLink && !Pp.showControl && !isSel) {
          const focusId = (id: string) => hover?.id === id || (sel?.kind === 'node' && sel.id === id) || jobsByNode.has(id)
          if (!focusId(l.a.id) && !focusId(l.b.id)) continue
        }
        nextVisible.add(l)
        const A = endPos(l.a, l, true)
        const B = endPos(l.b, l, false)
        const fullPath = route(A, B, l.nudge)
        const linkGrowth = red ? 1 : clamp((now - l.bornAt) / 600, 0, 1)
        const lengths = fullPath.slice(1).map((point, i) => Math.hypot(point.x - fullPath[i].x, point.y - fullPath[i].y))
        let remaining = lengths.reduce((sum, length) => sum + length, 0) * linkGrowth
        const pts = [fullPath[0]]
        for (let i = 0; i < lengths.length; i++) {
          if (remaining >= lengths[i]) { pts.push(fullPath[i + 1]); remaining -= lengths[i] }
          else {
            const fraction = lengths[i] ? remaining / lengths[i] : 0
            pts.push({ x: fullPath[i].x + (fullPath[i + 1].x - fullPath[i].x) * fraction, y: fullPath[i].y + (fullPath[i + 1].y - fullPath[i].y) * fraction })
            break
          }
        }
        nextRoutes.set(l, pts)
        const isHov = hoverLink === l
        const da = Math.min(dimOf(l.a), dimOf(l.b))
        ctx.lineJoin = 'round'
        ctx.lineCap = 'round'
        if (control) {
          ctx.strokeStyle = rgba(col, (0.55 + (isSel || isHov ? 0.4 : 0)) * da)
          ctx.lineWidth = 1 + (isSel || isHov ? 1 : 0)
          ctx.setLineDash([4, 5])
          strokePath(pts)
          ctx.setLineDash([])
          continue
        }
        ctx.strokeStyle = rgba(mix(col, '#ffffff', 0.72), 0.95 * da)
        ctx.lineWidth = Math.max(4, 13 * k)
        strokePath(pts)
        ctx.strokeStyle = rgba(col, (0.3 + (isSel || isHov ? 0.45 : 0)) * da)
        ctx.lineWidth = isSel || isHov ? 2 : 1
        strokePath(pts)
        const http = l.data.protocol === 'http' || l.data.protocol === 'http-app'
        if (l.sF >= 1) lane(pts, intensity(l.sF), http && errTint > 0 ? mix(col, C.red, errTint) : col, l.phF, da, 4.2, 2.6)
        if (l.sR >= 1) lane(pts.slice().reverse(), intensity(l.sR), mix(col, '#1c2635', 0.25), l.phR, da, 4.2, 2.6)
        for (const br of A.branches) branchJobs.push({ from: A, br, key: `${l.id}>${br.to.fk}`, col, da })
        for (const br of B.branches) branchJobs.push({ from: B, br, key: `${l.id}>${br.to.fk}`, col, da })
      }
      visibleLinks = nextVisible
      routes = nextRoutes
      // branches inside an opened file: per-route share of inbound traffic (real rps)
      for (const j of branchJobs) {
        const to = j.br.to
        const pts = route(j.from, to, 0)
        const al = Math.min(j.da, to.a)
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        ctx.strokeStyle = rgba(mix(j.col, '#ffffff', 0.72), 0.9 * al)
        ctx.lineWidth = Math.max(2.5, 7 * k * Math.pow(LEVEL_K, to.d - 2))
        strokePath(pts)
        ctx.strokeStyle = rgba(j.col, 0.35 * al)
        ctx.lineWidth = 1
        strokePath(pts)
        if (j.br.live && j.br.rps > 0) {
          const ri = rpsIntensity(j.br.rps)
          lane(pts, ri, mix(j.col, C.red, clamp(j.br.err * 6, 0, 0.75)), phaseStep(j.key, 12 + 36 * ri), al, 0, 2.2)
        }
      }

      // -- ghosts of removed servers -------------------------------------------------
      for (let i = ghostsRef.current.length - 1; i >= 0; i--) {
        const g = ghostsRef.current[i]
        g.t += dt / 0.8
        if (g.t >= 1) { ghostsRef.current.splice(i, 1); continue }
        drawBlock({ id: '', label: '', role: g.role, status: 'deleting', publicIp: '', privateIp: '', region: '', type: '', cpu: 0, memUsed: 0, memTotal: 0, load1: 0, processes: [], deletable: false }, g.x, g.y, -g.t * 30, null, 0, 0.35 * (1 - g.t), 0)
      }

      // -- issue roll-up onto visible items ---------------------------------------------
      const itemIssues = new Map<string, { n: number; level: Level }>()
      for (const [nodeId, nl] of nodeLay) {
        const b = bodies.get(nodeId)!
        if (b.ex < 0.5) continue
        for (const iss of b.node.issues ?? []) {
          const chain = issueChain(nl.tree, iss)
          if (!chain.length) continue
          const v = nearestVisible(nodeId, chain)
          if (!v) continue
          const cur = itemIssues.get(v.fk)
          const lv = levelOf([iss])!
          itemIssues.set(v.fk, { n: (cur?.n ?? 0) + 1, level: cur?.level === 'red' || lv === 'red' ? 'red' : 'amber' })
        }
      }

      // -- blocks + tiles, painter's order (back → front) --------------------------------
      const surge = incidentImpact
      type Job = { depth: number; draw: () => void }
      const drawJobs: Job[] = []
      type LabelJob = { prio: number; kind: 'node' | 'item'; b: Body; v?: Vis; sx: number; sy: number; foot: { x: number; y: number; r: number }; a: number; level: Level | null; n: number }
      const labelJobs: LabelJob[] = []
      const badgeJobs: { id: string; keys?: string[]; x: number; y: number; level: Level; n: number; a: number }[] = []
      const circles: { id: string; x: number; y: number; r: number }[] = []

      for (const b of bodies.values()) {
        const n = b.node
        const st = shapeOf(n.role)
        const X = bx(b), Y = by(b)
        const level = issueLevel(n)
        const nIssues = (n.issues ?? []).length
        const surgeTint = surge
        b.ta += ((level || surgeTint ? 1 : 0) - b.ta) * ease(6)
        const statusA = n.status === 'deleting' ? 0.25 : n.status === 'rebooting' || n.status === 'provisioning' || n.status === 'booting' ? 0.55 : n.status === 'offline' ? 0.7 : 1
        b.alpha += (statusA - b.alpha) * ease(4)
        const bootAge = (now - b.bootStart) / 1000
        const scaleTarget = n.status === 'rebooting' ? 0.15 : n.status === 'booting' ? Math.min(0.9, 0.15 + bootAge * 0.12) : 1
        b.bootScale += (scaleTarget - b.bootScale) * ease(5)
        const tcol = surge ? (n.role === 'app' ? C.red : C.amber) : level === 'amber' ? C.amber : C.red
        const dim = dimOf(b)
        const a = b.alpha * dim
        const e = b.ex
        const fr = Math.max(st.w, st.d) / 2
        const c0 = P(X, Y, st.h / 2)
        const rs0 = Math.max(10, (fr + st.h * 0.35) * k)
        const R = nodeR(b)
        const isSel = sel?.kind === 'node' && sel.id === b.id
        const isHov = hover?.kind === 'node' && hover.id === b.id && !hover.g
        const opened = nodeLay.has(b.id) && e > 0.5

        drawJobs.push({
          depth: X + Y - 0.01,
          draw: () => {
            if (b.ta > 0.02 && (level || surgeTint) && e < 0.5) {
              const g = groundEllipse(X, Y, 0, fr + 16)
              ctx.globalAlpha = (0.55 * b.ta * pulse) * dim
              const grad = ctx.createRadialGradient(g.cx, g.cy, 0, g.cx, g.cy, g.rx)
              grad.addColorStop(0, rgba(tcol, 0.45))
              grad.addColorStop(1, rgba(tcol, 0))
              ctx.fillStyle = grad
              ctx.beginPath(); ctx.ellipse(g.cx, g.cy, g.rx, g.ry, 0, 0, Math.PI * 2); ctx.fill()
              ctx.globalAlpha = 1
            }
            if (e < 0.99) shadow(X, Y, st.w, st.d, st.h, a * (1 - e))
            if ((isSel || isHov) && e < 0.3) {
              const o = fr + 9
              poly([P(X - o, Y - o), P(X + o, Y - o), P(X + o, Y + o), P(X - o, Y + o)])
              ctx.strokeStyle = rgba(C.acc, isSel ? 0.95 : 0.55)
              ctx.lineWidth = isSel ? 2 : 1.4
              ctx.stroke()
            }
            const ringR = R + 12
            if (n.activation && (n.activation.status !== 'ready' || Date.now() - (n.activation.completedAt ?? 0) < 1000) || n.status === 'rebooting' || n.status === 'provisioning' || n.status === 'booting') {
              const t = (now - b.bootStart) / 1000
              const activation = n.activation
              const prog = activation
                ? activation.status === 'ready' ? 1 : activation.status === 'failed' ? activation.progress : clamp((Date.now() - activation.startedAt) / (activation.durationMs ?? 10000), 0, 0.98)
                : (n.status === 'provisioning' ? 0.4 * (1 - Math.exp(-t / 3)) : 0.4 + 0.55 * (1 - Math.exp(-t / 5)))
              const g = groundEllipse(X, Y, 0, ringR)
              ctx.strokeStyle = 'rgba(40,56,84,0.15)'; ctx.lineWidth = 2.5
              ctx.beginPath(); ctx.ellipse(g.cx, g.cy, g.rx, g.ry, 0, 0, Math.PI * 2); ctx.stroke()
              const start = -Math.PI / 2 + (!red && !n.activation ? now / 900 : 0)
              const gradient = ctx.createConicGradient(start, g.cx, g.cy)
              if (activation) {
                // The hollow outline itself shifts red -> amber -> green as
                // the arc steadily draws; no spinning or stage-based jumps.
                const colorAt = (p: number) => p < 0.5 ? mix(C.red, C.amber, p * 2) : mix(C.amber, '#36bb80', (p - 0.5) * 2)
                gradient.addColorStop(0, colorAt(Math.max(0, prog - 0.12)))
                gradient.addColorStop(1, colorAt(prog))
              } else {
                gradient.addColorStop(0, C.red)
                gradient.addColorStop(0.5, C.amber)
                gradient.addColorStop(1, '#36bb80')
              }
              ctx.strokeStyle = gradient
              ctx.beginPath(); ctx.ellipse(g.cx, g.cy, g.rx, g.ry, 0, start, start + Math.PI * 2 * prog); ctx.stroke()
            }
            const jobs = jobsByNode.get(b.id) ?? []
            jobs.forEach((r, i) => {
              const g = groundEllipse(X, Y, 0, ringR + 5 + i * 6)
              const end = -Math.PI / 2 + Math.PI * 2 * Math.max(0.06, r.progress)
              ctx.globalAlpha = r.alpha * dim * (1 - 0.6 * e)
              ctx.strokeStyle = C.job
              ctx.lineWidth = 2 - e
              ctx.beginPath(); ctx.ellipse(g.cx, g.cy, g.rx, g.ry, 0, -Math.PI / 2, end); ctx.stroke()
              const tx = g.cx + Math.cos(end) * g.rx, ty = g.cy + Math.sin(end) * g.ry
              ctx.fillStyle = C.job
              ctx.beginPath(); ctx.arc(tx, ty, 2.6, 0, Math.PI * 2); ctx.fill()
              ctx.globalAlpha = 1
            })
          },
        })
        if (e < 0.995) {
          drawJobs.push({
            depth: X + Y,
            draw: () => {
              const growth = red ? 1 : clamp((now - b.bornAt) / 500, 0, 1) * b.bootScale
              ctx.save()
              const anchor = P(X, Y, 0)
              ctx.translate(anchor.x, anchor.y)
              ctx.scale(growth, growth)
              ctx.translate(-anchor.x, -anchor.y)
              drawBlock(n, X, Y, 0, level || surgeTint ? tcol : null, b.ta * (surge ? 3.5 : level === 'red' ? 1.6 : 1), a * (1 - 0.88 * e), e * 26)
              ctx.restore()
            },
          })
        }

        // node hit first; the platform, then deeper tiles, win when on top
        if (opened) newHits.push({ kind: 'node', id: b.id, sx: 0, sy: 0, rs: 0, g: { x: X, y: Y, R } })
        else {
          newHits.push({ kind: 'node', id: b.id, sx: c0.x, sy: c0.y, rs: rs0 })
          circles.push({ id: b.id, x: c0.x, y: c0.y, r: rs0 * 0.95 })
        }
        const ap = opened ? P(X - R, Y - R, 0) : P(X, Y, st.h + 26 * e)
        labelJobs.push({
          kind: 'node', b, sx: ap.x, sy: ap.y, foot: { x: c0.x, y: c0.y, r: rs0 }, a, level: nIssues > 0 && b.ta > 0.05 ? level : null, n: nIssues,
          prio: (isSel || isHov ? 200 : 0) + st.weight + (level ? 3 : 0),
        })
      }

      // tiles for every visible item (hits in depth order: shallow first)
      const visSorted = visList.slice().sort((p, q) => p.d - q.d)
      for (const v of visSorted) {
        const nl = nodeLay.get(v.b.id)!
        const tree = nl.tree
        const it = v.it
        const isSel = selFk === v.fk
        const isHov = hover?.kind === 'item' && hover.id === v.b.id && !!hover.keys && sameKeys(hover.keys, v.keys)
        const iss = itemIssues.get(v.fk)
        const ownIss = issuesUnder(tree, v.b.node.issues ?? [], v.keys)
        const lvl = levelOf(ownIss)
        const stat = routeOf(tree, it)
        const ef = stat ? errFrac(stat.errorRate) : 0
        const tint = lvl ? (lvl === 'red' ? C.red : C.amber) : ef > 0 ? C.red : null
        const tAmt = lvl ? 1.6 : clamp(ef * 6, 0, 0.75) * 2
        const kc = it.kind === 'file' || it.kind === 'conf' ? (it.key === tree.entry ? shapeOf(v.b.node.role).color : rgba(shapeOf(v.b.node.role).color, 0.55)) : KIND_COLOR[it.kind] ?? '#738096'
        const decal = stat && ef > 0 ? mix(KIND_COLOR.route, C.red, clamp(ef * 6, 0, 0.75)) : kc
        const expandable = it.children.length > 0
        const s = v.s, h = v.h, fx = v.x, fy = v.y, e = v.e
        if (v.a > 0.01 && e < 0.995) {
          drawJobs.push({
            depth: fx + fy + 0.02 + v.d * 0.001,
            draw: () => {
              ctx.globalAlpha = v.a * (1 - 0.85 * e)
              shadow(fx, fy, s, s, h, v.a * (1 - e))
              if ((isSel || isHov) && e < 0.3) {
                const o = s / 2 + 5
                poly([P(fx - o, fy - o), P(fx + o, fy - o), P(fx + o, fy + o), P(fx - o, fy + o)])
                ctx.strokeStyle = rgba(C.acc, isSel ? 0.95 : 0.55); ctx.lineWidth = isSel ? 2 : 1.3; ctx.stroke()
              }
              const ff = faces(tint, tAmt)
              const lid = e * 14 * Math.pow(LEVEL_K, v.d - 1)
              if (ROUND_KIND.has(it.kind)) {
                cylinder(fx, fy, 0, s * 0.48, h, ff, 1)
                const el = groundEllipse(fx, fy, h + lid, s * 0.28)
                ctx.beginPath(); ctx.ellipse(el.cx, el.cy, el.rx, el.ry, 0, 0, Math.PI * 2)
                ctx.fillStyle = decal; ctx.fill()
              } else {
                box(fx, fy, 0, s, s, h, ff)
                if (expandable) seam(fx, fy, s, s, h * 0.74)
                if (lid > 0.2) box(fx, fy, h + lid, s, s, 2, ff)
                const ic = s * 0.5
                const zt = h + lid + (lid > 0.2 ? 2 : 0)
                poly([P(fx - ic / 2, fy - ic / 2, zt), P(fx + ic / 2, fy - ic / 2, zt), P(fx + ic / 2, fy + ic / 2, zt), P(fx - ic / 2, fy + ic / 2, zt)])
                ctx.fillStyle = decal
                ctx.fill()
                if (it.sym?.secret) lockGlyph(fx, fy, zt, s)
              }
              ctx.globalAlpha = 1
            },
          })
        }
        if (v.a > 0.5) {
          const top = P(fx, fy, h)
          if (e > 0.5) newHits.push({ kind: 'item', id: v.b.id, keys: v.keys, sx: 0, sy: 0, rs: 0, g: { x: fx, y: fy, R: v.R } })
          else newHits.push({ kind: 'item', id: v.b.id, keys: v.keys, sx: top.x, sy: top.y + s * 0.3 * k, rs: Math.max(s * 0.8 * k, 8) })
          if (e < 0.5) circles.push({ id: v.fk, x: top.x, y: top.y + s * 0.3 * k, r: s * 0.5 * k })
          const anchor = e > 0.5 ? P(fx - v.R, fy - v.R, 0) : P(fx, fy, h)
          const readable = spacing(v.d) * k * CX * 2 >= 70
          if (readable || isSel || isHov || e > 0.5) {
            labelJobs.push({
              kind: 'item', b: v.b, v, sx: anchor.x, sy: anchor.y - (e > 0.5 ? 0 : s * 0.62 * k + 4), foot: { x: top.x, y: top.y, r: s * k }, a: (v.a - 0.5) * 2,
              level: iss?.level ?? null, n: iss?.n ?? 0,
              prio: (isSel || isHov ? 150 : 0) + (e > 0.5 ? 120 : 0) + (stat ? 40 + Math.min(20, stat.rps) : 0) + (iss ? 30 : 0) + (5 - Math.min(5, v.d)) * 4,
            })
          } else if (iss) {
            badgeJobs.push({ id: v.b.id, keys: v.keys, x: top.x + s * 0.6 * k + 8, y: top.y - 6, level: iss.level, n: iss.n, a: v.a })
          }
        }
      }

      drawJobs.sort((p, q) => p.depth - q.depth)
      for (const j of drawJobs) j.draw()

      // -- brief ground ring when a node gains a new real issue --------------------
      for (let i = burstsRef.current.length - 1; i >= 0; i--) {
        const bu = burstsRef.current[i]
        bu.age += dt
        const b = bodies.get(bu.id)
        if (bu.age >= 0.9 || !b || red) { burstsRef.current.splice(i, 1); continue }
        const t = bu.age / 0.9
        const st = shapeOf(b.node.role)
        const g = groundEllipse(bx(b), by(b), 0, Math.max(st.w, st.d) / 2 + 8 + t * 34)
        ctx.globalAlpha = (1 - t) * 0.8
        ctx.strokeStyle = bu.color
        ctx.lineWidth = 2
        ctx.beginPath(); ctx.ellipse(g.cx, g.cy, g.rx, g.ry, 0, 0, Math.PI * 2); ctx.stroke()
        ctx.globalAlpha = 1
      }

      // -- labels: flat white tags (servers) and small tags (items), collision pass ----
      {
        type Rect = { x0: number; y0: number; x1: number; y1: number }
        const placed: Rect[] = []
        const overlaps = (r: Rect, ownId: string, labelsOnly = false) => {
          for (const q of placed) if (r.x0 < q.x1 && r.x1 > q.x0 && r.y0 < q.y1 && r.y1 > q.y0) return true
          if (labelsOnly) return false
          for (const c of circles) {
            if (c.id === ownId) continue
            const nx = clamp(c.x, r.x0, r.x1), ny = clamp(c.y, r.y0, r.y1)
            if (Math.hypot(c.x - nx, c.y - ny) < c.r) return true
          }
          return false
        }
        const showGauge = k > 0.55
        for (const j of labelJobs.sort((p, q) => q.prio - p.prio)) {
          if (j.kind === 'item' && j.v) {
            const v = j.v
            const it = v.it
            const tree = nodeLay.get(v.b.id)!.tree
            const stat = routeOf(tree, it)
            const open = v.e > 0.5
            const fontMain = open ? `600 10.5px ${MONO}` : `500 10px ${MONO}`
            ctx.font = fontMain
            const maxW = open ? 260 : Math.max(90, spacing(v.d) * k * CX * 1.7)
            const text = truncate(ctx, it.label, maxW)
            const tw = ctx.measureText(text).width
            const facts = factsOf(it)
            const sub = facts ? (facts.sub ?? '') : it.sym?.secret ? 'secret' : stat ? `${fmtRps(stat.rps)} r/s` : it.kind === 'file' ? String(it.fileInfo?.loc ?? '') : it.kind
            const subCol = it.sym?.secret ? C.amber : stat && errFrac(stat.errorRate) > 0 ? C.red : C.dim
            ctx.font = `400 9px ${MONO}`
            const sw = ctx.measureText(sub).width
            const chev = it.children.length && !open ? 10 : 0
            const w = tw + sw + 16 + chev
            const hgt = 15
            const W = w * UI_K, HG = hgt * UI_K
            const x = open ? j.sx - 4 : j.sx - W / 2
            const y = open ? j.sy - HG - 6 : j.sy - HG - 1
            const rect = { x0: x - 2, y0: y - 2, x1: x + W + 2, y1: y + HG + 2 }
            if (j.prio < 150 && !open && overlaps(rect, v.fk, true)) {
              if (j.n > 0 && j.level) badgeJobs.push({ id: v.b.id, keys: v.keys, x: j.foot.x + j.foot.r * 0.6 + 8, y: j.foot.y - 6, level: j.level, n: j.n, a: v.a })
              continue
            }
            placed.push(rect)
            ctx.globalAlpha = clamp(j.a, 0, 1)
            ctx.save(); ctx.translate(x, y); ctx.scale(UI_K, UI_K)
            const isSel = selFk === v.fk
            ctx.fillStyle = isSel ? '#e7f0fd' : 'rgba(255,255,255,0.96)'
            ctx.beginPath(); ctx.roundRect(0, 0, w, hgt, 3); ctx.fill()
            ctx.strokeStyle = isSel ? rgba(C.acc, 0.85) : open ? rgba(KIND_COLOR[it.kind] ?? shapeOf(v.b.node.role).color, 0.6) : 'rgba(60,80,110,0.2)'
            ctx.lineWidth = 1
            ctx.stroke()
            ctx.textAlign = 'left'
            ctx.textBaseline = 'middle'
            ctx.font = fontMain
            ctx.fillStyle = C.ink
            ctx.fillText(text, 5, 8)
            ctx.font = `400 9px ${MONO}`
            ctx.fillStyle = subCol
            ctx.fillText(sub, 11 + tw, 8)
            if (chev) {
              // expandable affordance: a small chevron
              const cx2 = w - 7, cy2 = 7.5
              ctx.strokeStyle = C.dim
              ctx.lineWidth = 1.2
              ctx.beginPath(); ctx.moveTo(cx2 - 2, cy2 - 3); ctx.lineTo(cx2 + 1.5, cy2); ctx.lineTo(cx2 - 2, cy2 + 3); ctx.stroke()
            }
            ctx.restore()
            ctx.globalAlpha = 1
            if (j.n > 0 && j.level) badgeJobs.push({ id: v.b.id, keys: v.keys, x: x + W + 11 * UI_K, y: y + 7.5 * UI_K, level: j.level, n: j.n, a: j.a })
            continue
          }
          const n = j.b.node
          const tag = n.status === 'rebooting' || n.status === 'provisioning' || n.status === 'booting' || n.status === 'deleting' || n.status === 'offline' ? n.status.toUpperCase() : ''
          ctx.font = `600 11px ${SANS}`
          const label = truncate(ctx, n.label, 150)
          const lw = ctx.measureText(label).width
          ctx.font = `400 10px ${MONO}`
          const ip = truncate(ctx, n.privateIp, 150)
          const iw = ctx.measureText(ip).width
          ctx.font = `600 8.5px ${MONO}`
          const tagW = tag ? ctx.measureText(tag).width + 8 : 0
          const w = Math.max(lw + (tagW ? tagW + 6 : 0), iw, showGauge ? 70 : 0) + 14
          const h = 16 + 13 + (showGauge && n.status === 'running' ? 8 : 0) + 4
          const opened = j.b.ex > 0.5 && nodeLay.has(j.b.id)
          const W = w * UI_K, HH = h * UI_K
          const sx = opened ? j.sx - 4 + W / 2 : j.sx
          const y1 = j.sy - 12
          let rect = { x0: sx - W / 2, y0: y1 - HH, x1: sx + W / 2, y1 }
          let below = false
          if (j.prio < 200 && overlaps(rect, j.b.id)) {
            const fy = j.foot.y + j.foot.r + 8
            const alt = { x0: j.foot.x - W / 2, y0: fy, x1: j.foot.x + W / 2, y1: fy + HH }
            if (overlaps(alt, j.b.id) || alt.y1 > H - padB + 10) continue
            rect = alt
            below = true
          }
          placed.push(rect)
          const a = Math.max(0.55, j.a)
          ctx.globalAlpha = a
          if (!below) {
            ctx.strokeStyle = 'rgba(40,56,84,0.35)'
            ctx.lineWidth = 1
            ctx.beginPath(); ctx.moveTo(opened ? j.sx : sx, rect.y1); ctx.lineTo(opened ? j.sx : sx, j.sy - 2); ctx.stroke()
          }
          ctx.save(); ctx.translate(rect.x0, rect.y0); ctx.scale(UI_K, UI_K)
          const R = { x0: 0, y0: 0 }
          ctx.save()
          ctx.shadowColor = 'rgba(30,45,70,0.14)'
          ctx.shadowBlur = 8
          ctx.shadowOffsetY = 2
          ctx.fillStyle = '#ffffff'
          ctx.beginPath(); ctx.roundRect(R.x0, R.y0, w, h, 4); ctx.fill()
          ctx.restore()
          ctx.strokeStyle = j.prio >= 200 ? rgba(C.acc, 0.7) : 'rgba(60,80,110,0.18)'
          ctx.lineWidth = 1
          ctx.beginPath(); ctx.roundRect(R.x0 + 0.5, R.y0 + 0.5, w - 1, h - 1, 4); ctx.stroke()
          ctx.fillStyle = shapeOf(n.role).color
          ctx.fillRect(R.x0 + 0.5, R.y0 + 4, 2.5, h - 8)
          const lx = R.x0 + 8
          ctx.textAlign = 'left'
          ctx.textBaseline = 'top'
          ctx.font = `600 11px ${SANS}`
          ctx.fillStyle = C.ink
          ctx.fillText(label, lx, R.y0 + 4)
          if (tag) {
            ctx.font = `600 8.5px ${MONO}`
            const tx = lx + lw + 6
            ctx.fillStyle = n.status === 'offline' ? C.red : C.acc
            ctx.beginPath(); ctx.roundRect(tx, R.y0 + 4.5, tagW, 12, 2); ctx.fill()
            ctx.fillStyle = '#fff'
            ctx.fillText(tag, tx + 4, R.y0 + 6.5)
          }
          ctx.font = `400 10px ${MONO}`
          ctx.fillStyle = C.dim
          ctx.fillText(ip, lx, R.y0 + 18)
          if (showGauge && n.status === 'running') {
            const gy = R.y0 + 32
            const vals = [n.cpu, n.memTotal ? n.memUsed / n.memTotal : 0]
            vals.forEach((v, i) => {
              const x = lx + i * 36
              ctx.fillStyle = 'rgba(60,80,110,0.13)'
              ctx.fillRect(x, gy, 32, 3)
              ctx.fillStyle = v > 0.9 ? C.red : v > 0.75 ? C.amber : C.acc
              ctx.fillRect(x, gy, 32 * clamp(v, 0, 1), 3)
            })
          }
          ctx.restore()
          ctx.globalAlpha = 1
          if (j.level && j.n > 0) badgeJobs.push({ id: n.id, x: rect.x1 + 2, y: rect.y0 + 1, level: j.level, n: j.n, a: j.a })
        }
      }

      // -- "!" badges: pushed apart so they never overlap ----------------------------
      {
        for (let it = 0; it < 8; it++) {
          for (let i = 0; i < badgeJobs.length; i++) {
            for (let j = i + 1; j < badgeJobs.length; j++) {
              const A = badgeJobs[i], B = badgeJobs[j]
              let dx = B.x - A.x, dy = B.y - A.y
              let d = Math.hypot(dx, dy)
              const min = 26 * UI_K
              if (d >= min) continue
              if (d < 0.01) { dx = 1; dy = -0.4; d = 1 }
              const push = (min - d) / 2
              A.x -= (dx / d) * push; A.y -= (dy / d) * push
              B.x += (dx / d) * push; B.y += (dy / d) * push
            }
          }
        }
        for (const bj of badgeJobs) {
          const col = bj.level === 'amber' ? C.amber : C.red
          const text = bj.n > 1 ? `!${bj.n}` : '!'
          ctx.font = `700 ${10 * UI_K}px ${SANS}`
          const w = Math.max(17 * UI_K, ctx.measureText(text).width + 9 * UI_K)
          ctx.globalAlpha = clamp(Math.max(0.6, bj.a), 0, 1) * (red ? 1 : 0.85 + 0.15 * pulse)
          ctx.fillStyle = col
          ctx.beginPath(); ctx.roundRect(bj.x - w / 2, bj.y - 8 * UI_K, w, 16 * UI_K, 8 * UI_K); ctx.fill()
          ctx.strokeStyle = '#ffffff'
          ctx.lineWidth = 1.5
          ctx.stroke()
          ctx.fillStyle = '#ffffff'
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(text, bj.x, bj.y + 0.5)
          ctx.globalAlpha = 1
          newHits.push({ kind: 'badge', id: bj.id, keys: bj.keys, sx: bj.x, sy: bj.y, rs: w / 2 })
        }
      }
      hits = newHits
      if (hoverLink && !visibleLinks.has(hoverLink)) hoverLink = null
      if (hover) {
        const h = hover
        hover = hits.find((x) => x.kind === h.kind && x.id === h.id && sameKeys(x.keys ?? [], h.keys ?? [])) ?? null
      }

      // -- tooltips ------------------------------------------------------------------
      if (!press && mouse) {
        if (hover?.kind === 'node' && !hover.g) {
          const b = bodies.get(hover.id)
          if (b) {
            const n = b.node
            const lines: { t: string; c?: string }[] = [
              { t: `${n.label}  ·  ${n.role}  ·  ${n.status}` },
              { t: `${n.privateIp}  /  ${n.publicIp}` },
              { t: `${n.region}  ·  ${n.type}` },
            ]
            if (n.status === 'running') lines.push({ t: `cpu ${Math.round(n.cpu * 100)}%  mem ${fmtMem(n.memUsed, n.memTotal)}  load ${n.load1}` })
            for (const pr of n.processes.slice(0, 4)) lines.push({ t: `  ${pr.name}${pr.ports.length ? ':' + pr.ports.join(',') : ''}` })
            if (n.processes.length > 4) lines.push({ t: `  +${n.processes.length - 4} more (select for detail)` })
            for (const r of jobsByNode.get(n.id) ?? []) if (r.active) lines.push({ t: `check ${r.type} ${Math.round(r.progress * 100)}%  ${r.note}`, c: C.job })
            const ni = (n.issues ?? []).length
            if (ni) lines.push({ t: `! ${ni} issue${ni > 1 ? 's' : ''} — select for detail`, c: issueLevel(n) === 'amber' ? C.amber : C.red })
            const role = treeOf(b)?.role
            if (role?.title) lines.splice(1, 0, { t: role.title })
            if (role && b.ex < 0.5) lines.push({ t: `click to open into ${role.noun ?? 'files'}`, c: C.acc })
            drawTooltip(lines, { x: hover.sx, y: hover.sy, r: Math.min(hover.rs, 60) + 10 }, 'node')
          }
        } else if (hover?.kind === 'item' && hover.keys) {
          const v = visByNode.get(hover.id)?.get(hover.keys[hover.keys.length - 1])
          const nl = nodeLay.get(hover.id)
          if (v && nl && v.e < 0.5) {
            const it = v.it
            const lines: { t: string; c?: string }[] = [{ t: it.kind === 'file' ? it.key : it.label }]
            const facts = factsOf(it)
            if (facts) {
              lines[0].t = `${it.label}  ·  ${it.kind}`
              for (const [key, value] of (facts.info ?? []).slice(0, 5)) lines.push({ t: `${key}  ${value.length > 44 ? value.slice(0, 43) + '…' : value}`, c: /sensitive/.test(value) ? C.amber : undefined })
            } else if (it.kind === 'file') {
              const ports = nl.tree.role.ports.filter((q) => q.file === it.key).map((q) => `${q.dir} :${q.port}`)
              lines.push({ t: `${it.fileInfo?.loc ?? 0} loc  ·  ${it.children.length} symbols${ports.length ? '  ·  ' + ports.join(', ') : ''}` })
            } else if (it.sym) {
              lines.push({ t: `${it.kind}  ·  ${it.file.split('/').pop()}:${it.sym.line}–${it.sym.endLine}  ·  calls ${it.sym.calls?.length ?? 0}` })
              if (it.sym.secret) lines.push({ t: 'secret: value never shown', c: C.amber })
            }
            const st = routeOf(nl.tree, it)
            if (st) lines.push({ t: `${fmtRps(st.rps)} req/s  ·  err ${(errFrac(st.errorRate) * 100).toFixed(2)}%  ·  p95 ${st.p95ms == null ? '—' : st.p95ms + ' ms'}`, c: errFrac(st.errorRate) > 0 ? C.red : C.text })
            for (const i of issuesUnder(nl.tree, v.b.node.issues ?? [], v.keys).slice(0, 2)) lines.push({ t: `! ${i.severity}  ${i.title}`, c: (SEV_RANK[i.severity] ?? 0) >= 3 ? C.red : C.amber })
            if (it.children.length) lines.push({ t: `click to open (${it.children.length} inside)`, c: C.acc })
            drawTooltip(lines, { x: hover.sx, y: hover.sy, r: hover.rs + 6 }, 'node')
          }
        } else if (hover?.kind === 'badge') {
          const b = bodies.get(hover.id)
          const tree = b ? treeOf(b) : null
          const all = b?.node.issues ?? []
          const src = hover.keys ? issuesUnder(tree, all, hover.keys) : all
          const iss = src.slice().sort((x, y) => (SEV_RANK[y.severity] ?? 0) - (SEV_RANK[x.severity] ?? 0))
          if (b && iss.length) {
            const lines = [{ t: `${iss[0].severity.toUpperCase()}  ${iss[0].title}`, c: (SEV_RANK[iss[0].severity] ?? 0) >= 3 ? C.red : C.amber }]
            if (iss.length > 1) lines.push({ t: `+${iss.length - 1} more on ${b.node.label}`, c: C.dim })
            drawTooltip(lines, { x: hover.sx, y: hover.sy, r: hover.rs + 2 }, 'node')
          }
        } else if (hoverLink) {
          const l = hoverLink
          drawTooltip([
            { t: `${l.data.protocol} :${l.data.port}  ·  ${l.data.conns} conns` },
            { t: `${l.a.node.label} → ${l.b.node.label}  ${fmtRate(l.sF)}` },
            { t: `${l.b.node.label} → ${l.a.node.label}  ${fmtRate(l.sR)}` },
          ], { x: mouse.x, y: mouse.y, r: 0 }, 'cursor')
        }
      }

      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      ro?.disconnect()
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onUp)
      canvas.removeEventListener('pointerleave', onLeave)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('dblclick', onDbl)
      canvas.removeEventListener('dragover', onDragOver)
      canvas.removeEventListener('drop', onDrop)
    }
  }, [])

  return <canvas ref={canvasRef} className="iso-canvas" />
}
