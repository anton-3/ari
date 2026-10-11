import { useEffect, useRef } from 'react'
import { ACTIVE_AGENT, codeFor, fileIssues, fmtMem, fmtRate, isControl, issueLevel } from '../../graph/GraphView'
import type { Sel } from '../../graph/GraphView'
import { loadPos, savePos, takeAlias, takePlacement } from '../../graph/positions'
import type { Agent, Codemap, CodemapRole, Fleet, FleetIssue, FleetLink, FleetNode, Metrics } from '../../graph/types'

// ---------------------------------------------------------------------------
// Isometric fleet map (Cloudcraft-style). The model is a flat 2D ground plane
// (world x/y, snapped to a grid); a fixed isometric camera projects it, so pan
// and zoom stay 2D. Every block, pipe and dash maps to real fleet data.
// ---------------------------------------------------------------------------

export const GRID = 60
const CX = Math.cos(Math.PI / 6) // screen x per world unit along an iso axis
const CY = 0.5 // screen y per world unit along an iso axis

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

type Kind = 'box' | 'server' | 'cyl' | 'stack' | 'slab' | 'client' | 'disc'
export interface RoleShape {
  kind: Kind
  w: number // world extent along x
  d: number // world extent along y
  h: number // height
  color: string // accent (icon) colour
  glyph: string
  weight: number
  ax: number // anchor cell x
  ay: number // anchor cell y
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
export const shapeOf = (r: string): RoleShape =>
  ROLE[r] ?? { kind: 'box', w: 30, d: 30, h: 28, color: '#738096', glyph: r.slice(0, 3).toUpperCase(), weight: 2, ax: 0, ay: -6 }

const SEV_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 }
const SANS = '"Inter", system-ui, -apple-system, "Segoe UI", sans-serif'
const MONO = '"JetBrains Mono", ui-monospace, Menlo, monospace'
const LINK_GRACE_MS = 30000
const TOP_PAD = 100
const BOTTOM_PAD = 170
const LEFT_PAD = 210
const RIGHT_PAD = 40
const FS = 92 // file tile spacing (world)

type Level = 'red' | 'amber'

interface Body {
  id: string
  node: FleetNode
  pending: boolean
  x: number // displayed world position (eased)
  y: number
  gx: number // grid target
  gy: number
  ox: number // make-room displacement (eased)
  oy: number
  pinned: boolean
  ta: number
  alpha: number
  ex: number
  open: boolean
  bootStart: number
  bootPhase: string
  lastIssueCount: number
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
}

interface FileLayout {
  role: CodemapRole
  entry: string
  R: number // platform half-size (world)
  pos: Map<string, { x: number; y: number; h: number; s: number }>
  pathTo: Map<string, [string, string][]>
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

type Hit = { kind: 'node' | 'badge' | 'file'; id: string; file?: string; sx: number; sy: number; rs: number }

interface Props {
  fleet: Fleet | null
  agents: Agent[]
  metrics: Metrics | null
  codemap: Codemap | null
  live: boolean
  reduced: boolean
  rightInset: number
  showControl: boolean
  selected: Sel | null
  focus: { id: string; n: number } | null
  onSelect: (s: Sel | null) => void
  onDropRole: (role: string, x: number, y: number) => void
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v)
const snap = (v: number) => Math.round(v / GRID) * GRID

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
function levelOf(issues: FleetIssue[]): Level | null {
  let top = 0
  for (const i of issues) top = Math.max(top, SEV_RANK[i.severity] ?? 1)
  return top === 0 ? null : top >= 3 ? 'red' : 'amber'
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

// File tiles on a grid around the entry file: port-owning files first (on the
// four sides), then by size. Height scales with loc.
const RING: [number, number][] = [
  [1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1],
  [2, 0], [0, 2], [-2, 0], [0, -2], [2, 1], [1, 2], [-2, -1], [-1, -2], [2, -1], [-1, 2], [-2, 1], [1, -2],
]
const layoutCache = new Map<string, FileLayout>()
function layoutFor(role: string, cr: CodemapRole): FileLayout {
  const key = `${role}|${cr.files.map((f) => f.path).join(',')}|${cr.edges.length}`
  const hit = layoutCache.get(key)
  if (hit) return hit
  const portFiles = new Set(cr.ports.map((p) => p.file))
  const entry = cr.ports.find((p) => p.dir === 'in')?.file ?? cr.files.slice().sort((a, b) => b.loc - a.loc)[0].path
  const others = cr.files
    .filter((f) => f.path !== entry)
    .sort((a, b) => Number(portFiles.has(b.path)) - Number(portFiles.has(a.path)) || b.loc - a.loc)
  const hOf = (loc: number) => clamp(6 + Math.sqrt(loc) * 1.4, 7, 30)
  const pos = new Map<string, { x: number; y: number; h: number; s: number }>()
  const ef = cr.files.find((f) => f.path === entry)
  pos.set(entry, { x: 0, y: 0, h: hOf(ef?.loc ?? 50), s: 38 })
  let maxRing = 0
  others.slice(0, RING.length).forEach((f, i) => {
    const [cx, cy] = RING[i]
    maxRing = Math.max(maxRing, Math.abs(cx), Math.abs(cy))
    pos.set(f.path, { x: cx * FS, y: cy * FS, h: hOf(f.loc), s: 30 })
  })
  const adj = new Map<string, string[]>()
  for (const e of cr.edges) {
    if (!adj.has(e.from)) adj.set(e.from, [])
    adj.get(e.from)!.push(e.to)
  }
  const prev = new Map<string, string>()
  const q = [entry]
  const seen = new Set([entry])
  while (q.length) {
    const cur = q.shift()!
    for (const nx of adj.get(cur) ?? []) {
      if (seen.has(nx)) continue
      seen.add(nx)
      prev.set(nx, cur)
      q.push(nx)
    }
  }
  const pathTo = new Map<string, [string, string][]>()
  for (const f of cr.files) {
    const out: [string, string][] = []
    let c = f.path
    while (prev.has(c)) {
      const p = prev.get(c)!
      out.unshift([p, c])
      c = p
    }
    pathTo.set(f.path, out)
  }
  const lay = { role: cr, entry, R: Math.max(1, maxRing) * FS + 46, pos, pathTo }
  layoutCache.set(key, lay)
  return lay
}

// Axis-aligned route on the ground: along x, then y, then x (Z-shape).
type P2 = { x: number; y: number }
function route(a: P2, b: P2, nudge: number): P2[] {
  if (Math.abs(a.y - b.y) < 0.5 || Math.abs(a.x - b.x) < 0.5) return [a, b]
  const mx = (a.x + b.x) / 2 + nudge
  return [a, { x: mx, y: a.y }, { x: mx, y: b.y }, b]
}
// Offset a polyline sideways on the ground (right-hand side of travel).
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
    const occupied = (gx: number, gy: number, self: string) => {
      for (const b of bodies.values()) {
        if (b.id === self) continue
        if (Math.max(Math.abs(b.gx - gx), Math.abs(b.gy - gy)) < GRID * 2.5) return true
      }
      return false
    }
    const freeCell = (cx: number, cy: number, self: string) => {
      // nearest free grid cell to (cx,cy); prefer spreading along y (rows)
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
      const f = freeCell(st.ax * GRID, st.ay * GRID, n.id)
      return { ...f, pin: false }
    }

    const seen = new Set<string>()
    // place pinned/saved ones first so auto-placed nodes avoid them
    const order = fleet.nodes.slice().sort((a, b) => Number(!!loadPos(b.label)) - Number(!!loadPos(a.label)))
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
      if (!b) {
        const p = place(n)
        b = {
          id: n.id, node: n, pending: n.id.startsWith('pending-'), x: p.x, y: p.y, gx: p.x, gy: p.y, ox: 0, oy: 0,
          pinned: p.pin, ta: 0, alpha: 0, ex: 0, open: false, bootStart: performance.now(), bootPhase: n.status,
          lastIssueCount: (n.issues ?? []).length,
        }
        bodies.set(n.id, b)
      }
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
        lr = { id: l.id, a, b, data: l, sF: 0, sR: 0, phF: 0, phR: 0, present: true, goneAt: 0, nudge: ((hash(l.id) % 5) - 2) * 7 }
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

    let W = window.innerWidth
    let H = window.innerHeight
    let dpr = 1
    const view = { k: 1, tx: W / 2, ty: H / 2 }
    let autoFit = true
    let focusN = -1
    let panTo: { x: number; y: number } | null = null
    let expandedId: string | null = null

    const pointers = new Map<number, { x: number; y: number }>()
    let press: { x: number; y: number; hit: Hit | null; moved: boolean; lastX: number; lastY: number; gdx: number; gdy: number } | null = null
    let pinch: { dist: number; k: number } | null = null
    let dragBody: Body | null = null
    let mouse: { x: number; y: number } | null = null
    let hover: Hit | null = null
    let hoverLink: LinkR | null = null
    let hits: Hit[] = []
    let visibleLinks = new Set<LinkR>()
    let routes = new Map<LinkR, { A: P2; B: P2; pts: P2[] }>()
    const agentsR = new Map<string, AgentR>()

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      W = window.innerWidth
      H = window.innerHeight
      canvas.width = Math.floor(W * dpr)
      canvas.height = Math.floor(H * dpr)
      canvas.style.width = `${W}px`
      canvas.style.height = `${H}px`
    }
    resize()
    window.addEventListener('resize', resize)

    // world (x,y,z) → screen
    const P = (x: number, y: number, z = 0) => ({ x: (x - y) * CX * view.k + view.tx, y: ((x + y) * CY - z) * view.k + view.ty })
    // screen → ground plane
    const toGround = (sx: number, sy: number) => {
      const a = (sx - view.tx) / view.k / CX
      const b = (sy - view.ty) / view.k / CY
      return { x: (a + b) / 2, y: (b - a) / 2 }
    }
    const zoomAround = (sx: number, sy: number, nk: number) => {
      const k = clamp(nk, 0.25, 4)
      view.tx = sx - ((sx - view.tx) * k) / view.k
      view.ty = sy - ((sy - view.ty) * k) / view.k
      view.k = k
    }
    const layoutOf = (b: Body): FileLayout | null => {
      const cr = codeFor(propsRef.current.codemap, b.node.role)
      return cr ? layoutFor(b.node.role, cr) : null
    }
    const bx = (b: Body) => b.x + b.ox
    const by = (b: Body) => b.y + b.oy

    const fitTarget = () => {
      const bodies = bodiesRef.current
      if (bodies.size === 0) return null
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      for (const b of bodies.values()) {
        const st = shapeOf(b.node.role)
        const lay = b.ex > 0.01 ? layoutOf(b) : null
        const r = lay ? lay.R * b.ex + Math.max(st.w, st.d) / 2 * (1 - b.ex) : Math.max(st.w, st.d) / 2
        const X = bx(b), Y = by(b)
        // projected bounds of the footprint diamond (screen units at k=1)
        const u = (X - Y) * CX, v = (X + Y) * CY
        const hu = 2 * r * CX, hv = 2 * r * CY
        x0 = Math.min(x0, u - hu - 50); x1 = Math.max(x1, u + hu + 50)
        y0 = Math.min(y0, v - hv - st.h - 62); y1 = Math.max(y1, v + hv + 20)
      }
      const aw = Math.max(200, W - LEFT_PAD - Math.max(RIGHT_PAD, propsRef.current.rightInset))
      const ah = Math.max(160, H - TOP_PAD - BOTTOM_PAD)
      const k = clamp(Math.min(aw / (x1 - x0), ah / (y1 - y0)), 0.3, 1.5)
      return { k, tx: LEFT_PAD + aw / 2 - ((x0 + x1) / 2) * k, ty: TOP_PAD + ah / 2 - ((y0 + y1) / 2) * k }
    }

    // Ground attachment point of a link end; with the node expanded, the file
    // that owns that port.
    const endPos = (b: Body, l: LinkR, outgoing: boolean): P2 & { file: string | null } => {
      const base = { x: bx(b), y: by(b) }
      if (b.ex < 0.01) return { ...base, file: null }
      const lay = layoutOf(b)
      if (!lay) return { ...base, file: null }
      const dir = outgoing ? 'out' : 'in'
      const pe = lay.role.ports.find((p) => p.port === l.data.port && p.dir === dir) ?? lay.role.ports.find((p) => p.port === l.data.port)
      const fp = pe ? lay.pos.get(pe.file) : undefined
      if (!pe || !fp) return { ...base, file: null }
      return { x: base.x + fp.x * b.ex, y: base.y + fp.y * b.ex, file: pe.file }
    }

    const segDist = (px: number, py: number, ax: number, ay: number, bx2: number, by2: number) => {
      const dx = bx2 - ax, dy = by2 - ay
      const L = dx * dx + dy * dy || 1
      const t = clamp(((px - ax) * dx + (py - ay) * dy) / L, 0, 1)
      return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
    }
    const hitTest = (x: number, y: number): Hit | null => {
      for (let i = hits.length - 1; i >= 0; i--) {
        const h = hits[i]
        if (Math.hypot(x - h.sx, y - h.sy) <= h.rs + 3) return h
      }
      return null
    }
    const linkAt = (x: number, y: number): LinkR | null => {
      let best: LinkR | null = null
      let bd = 7
      for (const l of visibleLinks) {
        const r = routes.get(l)
        if (!r || !l.present) continue
        const s = r.pts.map((p) => P(p.x, p.y))
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
        hoverLink = hover ? null : linkAt(p.x, p.y)
        canvas.style.cursor = hover || hoverLink ? 'pointer' : 'grab'
        return
      }
      if (!press.moved && Math.hypot(p.x - press.x, p.y - press.y) > 3) {
        press.moved = true
        const h = press.hit
        if (h?.kind === 'node') dragBody = bodiesRef.current.get(h.id) ?? null
        canvas.style.cursor = 'grabbing'
      }
      if (!press.moved) return
      if (dragBody) {
        // slide across the ground, snapping to the iso grid
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
        if (h?.kind === 'file' || h?.kind === 'badge') Pp.onSelect({ kind: 'node', id: h.id, file: h.file })
        else if (h?.kind === 'node') {
          const same = Pp.selected?.kind === 'node' && Pp.selected.id === h.id
          Pp.onSelect(same ? null : { kind: 'node', id: h.id })
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
    // axis-aligned box: centre (x,y), base z0
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
    // a decal lying on a horizontal plane at height z (text/icons read flat)
    const onPlane = (x: number, y: number, z: number, fn: () => void) => {
      const c = P(x, y, z)
      ctx.save()
      ctx.setTransform(dpr * view.k * CX * Math.SQRT2, 0, 0, dpr * view.k * CY * Math.SQRT2, dpr * c.x, dpr * c.y)
      fn()
      ctx.restore()
    }
    const topIcon = (x: number, y: number, z: number, s: number, col: string, glyph: string, a: number) => {
      // inset coloured "service icon" diamond + glyph on the top face
      const h = s / 2
      poly([P(x - h, y - h, z), P(x + h, y - h, z), P(x + h, y + h, z), P(x - h, y + h, z)])
      ctx.fillStyle = rgba(col, a)
      ctx.fill()
      if (s * view.k > 15) {
        onPlane(x, y, z, () => {
          ctx.fillStyle = 'rgba(255,255,255,0.96)'
          ctx.font = `700 ${Math.max(6, Math.min(11, s * 0.34))}px ${SANS}`
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(glyph, 0, 0.5)
        })
      }
    }
    // ellipse = projected circle on the ground plane at height z
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
      // soft cast shadow toward +x (screen down-right); light from top-left
      const s = h * 0.45
      const pts = [P(x - w / 2, y - d / 2), P(x + w / 2 + s, y - d / 2), P(x + w / 2 + s, y + d / 2 + 3), P(x - w / 2, y + d / 2 + 3)]
      ctx.fillStyle = `rgba(36,52,80,${0.13 * a})`
      poly(pts)
      ctx.fill()
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
            // slab front stripe in accent colour
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
          // rack units on the front-left face + status LEDs
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
          // lid
          box(x, y, z0 + st.h - 4 + lidLift, st.w, st.d, 4, f)
          topIcon(x, y, z0 + st.h + lidLift, st.w * 0.55, st.color, st.glyph, 1)
          break
        }
        case 'client': {
          box(x, y, z0, st.w, st.d, st.h, f)
          // screen on the front-left face
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
    const strokePath = (pts: P2[], z = 0) => {
      ctx.beginPath()
      pts.forEach((p, i) => {
        const s = P(p.x, p.y, z)
        if (i) ctx.lineTo(s.x, s.y)
        else ctx.moveTo(s.x, s.y)
      })
      ctx.stroke()
    }
    const flowLane = (pts: P2[], bps: number, col: string, phase: number, alpha: number) => {
      if (bps < 1) return
      const it = intensity(bps)
      const lane = offsetPoly(pts, 4.2)
      ctx.setLineDash([5, 24 - 14 * it])
      ctx.lineDashOffset = -phase
      ctx.lineCap = 'butt'
      ctx.lineWidth = 2.6
      ctx.strokeStyle = rgba(col, (0.55 + 0.45 * it) * alpha)
      strokePath(lane)
      ctx.setLineDash([])
      ctx.lineDashOffset = 0
    }

    const drawTooltip = (lines: { t: string; c?: string }[], anchor: { x: number; y: number; r: number }, side: 'node' | 'cursor') => {
      ctx.font = `400 11px ${MONO}`
      const maxW = Math.min(360, W - 24)
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
      const pulse = red ? 1 : 0.7 + 0.3 * Math.sin(now / 380)
      const bodies = bodiesRef.current
      const links = linksRef.current
      const k = view.k
      const sel = Pp.selected
      const ease = (rate: number) => (red ? 1 : 1 - Math.exp(-dt * rate))

      const want = sel?.kind === 'node' && bodies.has(sel.id) && codeFor(Pp.codemap, bodies.get(sel.id)!.node.role) ? sel.id : null
      if (want !== expandedId) {
        expandedId = want
        for (const b of bodies.values()) b.open = b.id === want
      }
      let dimAll = 0
      const exp = expandedId ? bodies.get(expandedId) : undefined
      const expLay = exp ? layoutOf(exp) : null
      for (const b of bodies.values()) {
        b.ex += ((b.open ? 1 : 0) - b.ex) * ease(7)
        if (b.ex < 0.001) b.ex = 0
        dimAll = Math.max(dimAll, b.ex)
        // glide to the snapped grid target
        b.x += (b.gx - b.x) * ease(14)
        b.y += (b.gy - b.y) * ease(14)
        // make room around an opened block (visual only, never persisted)
        let tx = 0, ty = 0
        if (exp && expLay && b !== exp) {
          const st = shapeOf(b.node.role)
          const need = expLay.R + Math.max(st.w, st.d) / 2 + 90
          const dx = b.gx - exp.gx, dy = b.gy - exp.gy
          const cheb = Math.max(Math.abs(dx), Math.abs(dy))
          if (cheb < need) {
            // push out along the dominant grid axis
            if (Math.abs(dx) >= Math.abs(dy) && dx !== 0) tx = Math.sign(dx) * (need - Math.abs(dx))
            else ty = (Math.sign(dy) || 1) * (need - Math.abs(dy))
          }
        }
        b.ox += (tx - b.ox) * ease(7)
        b.oy += (ty - b.oy) * ease(7)
      }

      if (Pp.focus && Pp.focus.n !== focusN) {
        focusN = Pp.focus.n
        const b = bodies.get(Pp.focus.id)
        if (b) { autoFit = false; panTo = { x: bx(b), y: by(b) } }
      }
      if (panTo) {
        const cx = LEFT_PAD + (W - LEFT_PAD - Math.max(RIGHT_PAD, Pp.rightInset)) / 2
        const cy = TOP_PAD + (H - TOP_PAD - BOTTOM_PAD) / 2
        const t = ease(6)
        const tx = cx - (panTo.x - panTo.y) * CX * view.k
        const ty = cy - (panTo.x + panTo.y) * CY * view.k
        view.tx += (tx - view.tx) * t
        view.ty += (ty - view.ty) * t
        if (Math.abs(tx - view.tx) + Math.abs(ty - view.ty) < 1) panTo = null
      }
      if (autoFit && !dragBody) {
        const f = fitTarget()
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
        while (step * k * CX < 14) step *= 2
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

      // -- expanded platforms (ground layer) ---------------------------------------
      for (const b of bodies.values()) {
        if (b.ex < 0.01) continue
        const lay = layoutOf(b)
        if (!lay) continue
        const st = shapeOf(b.node.role)
        const e = b.ex
        const R = lay.R * e + Math.max(st.w, st.d) / 2 * (1 - e)
        const X = bx(b), Y = by(b)
        ctx.globalAlpha = e
        poly([P(X - R, Y - R, 0), P(X + R, Y - R, 0), P(X + R, Y + R, 0), P(X - R, Y + R, 0)])
        ctx.fillStyle = 'rgba(255,255,255,0.72)'
        ctx.fill()
        ctx.strokeStyle = rgba(st.color, 0.55)
        ctx.lineWidth = 1.2
        ctx.setLineDash([5, 4])
        ctx.stroke()
        ctx.setLineDash([])
        // import edges: routed along the grid on the platform
        const fp = (path: string) => {
          const f = lay.pos.get(path)
          return f ? { x: X + f.x * e, y: Y + f.y * e } : null
        }
        ctx.strokeStyle = 'rgba(40,56,84,0.32)'
        ctx.lineWidth = 1
        for (const ed of lay.role.edges) {
          const A = fp(ed.from), B = fp(ed.to)
          if (!A || !B) continue
          strokePath(route(A, B, 0))
        }
        // entry → port-file import paths, scaled by that link's real rate
        for (const l of links.values()) {
          const outgoing = l.a === b
          if (!l.present || (!outgoing && l.b !== b)) continue
          const pe = lay.role.ports.find((q) => q.port === l.data.port && q.dir === (outgoing ? 'out' : 'in'))
          if (!pe) continue
          const it = intensity(l.sF + l.sR)
          if (it <= 0.01) continue
          const pc = PROTO_COLOR[l.data.protocol] ?? PROTO_COLOR.other
          for (const [f, t] of lay.pathTo.get(pe.file) ?? []) {
            const A = fp(f), B = fp(t)
            if (!A || !B) continue
            ctx.strokeStyle = rgba(pc, 0.18 + 0.45 * it)
            ctx.lineWidth = 1.5 + 1.5 * it
            strokePath(route(A, B, 0))
          }
        }
        ctx.globalAlpha = 1
      }

      // -- pipes: ground cables routed along the grid + iso dashes for bytes/s -----
      const nextVisible = new Set<LinkR>()
      const nextRoutes = new Map<LinkR, { A: P2; B: P2; pts: P2[] }>()
      for (const l of links.values()) {
        const s = 1 - Math.exp(-dt / 1.2)
        l.sF += (Math.max(0, l.data.bytesPerSec) - l.sF) * s
        l.sR += (Math.max(0, l.data.bytesPerSecReverse) - l.sR) * s
        if (!red) {
          l.phF += laneSpeed(l.sF) * dt
          l.phR += laneSpeed(l.sR) * dt
        }
        if (!l.present) continue
        const col = PROTO_COLOR[l.data.protocol] ?? PROTO_COLOR.other
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
        const pts = route(A, B, l.nudge)
        nextRoutes.set(l, { A, B, pts })
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
        // tube: soft body + darker underside line + highlight
        ctx.strokeStyle = rgba(mix(col, '#ffffff', 0.72), 0.95 * da)
        ctx.lineWidth = Math.max(4, 13 * k)
        strokePath(pts)
        ctx.strokeStyle = rgba(col, (0.3 + (isSel || isHov ? 0.45 : 0)) * da)
        ctx.lineWidth = isSel || isHov ? 2 : 1
        strokePath(pts)
        ctx.lineCap = 'butt'
        const http = l.data.protocol === 'http' || l.data.protocol === 'http-app'
        flowLane(pts, l.sF, http && errTint > 0 ? mix(col, C.red, errTint) : col, l.phF, da)
        flowLane(pts.slice().reverse(), l.sR, mix(col, '#1c2635', 0.25), l.phR, da)
      }
      visibleLinks = nextVisible
      routes = nextRoutes

      // -- ghosts of removed servers -------------------------------------------------
      for (let i = ghostsRef.current.length - 1; i >= 0; i--) {
        const g = ghostsRef.current[i]
        g.t += dt / 0.8
        if (g.t >= 1) { ghostsRef.current.splice(i, 1); continue }
        drawBlock({ id: '', label: '', role: g.role, status: 'deleting', publicIp: '', privateIp: '', region: '', type: '', cpu: 0, memUsed: 0, memTotal: 0, load1: 0, processes: [], deletable: false }, g.x, g.y, -g.t * 30, null, 0, 0.35 * (1 - g.t), 0)
      }

      // -- blocks + file tiles, painter's order (back → front) ------------------------
      const surge = Pp.metrics?.mode === 'surge'
      type Job = { depth: number; draw: () => void }
      const drawJobs: Job[] = []
      const labelJobs: { b: Body; sx: number; sy: number; foot: { x: number; y: number; r: number }; a: number; prio: number; level: Level | null; n: number }[] = []
      const badgeJobs: { id: string; file?: string; x: number; y: number; level: Level; n: number; a: number }[] = []
      const circles: { id: string; x: number; y: number; r: number }[] = []
      const fileLabels: { x: number; y: number; text: string; loc: number; a: number; sel: boolean; id: string; file: string; level: Level | null; n: number }[] = []
      const fileRects: { x0: number; y0: number; x1: number; y1: number }[] = []

      for (const b of bodies.values()) {
        const n = b.node
        const st = shapeOf(n.role)
        const X = bx(b), Y = by(b)
        const level = issueLevel(n)
        const nIssues = (n.issues ?? []).length
        const surgeTint = surge && (n.role === 'traffic' || n.role === 'internet')
        b.ta += ((level || surgeTint ? 1 : 0) - b.ta) * ease(6)
        const statusA = n.status === 'deleting' ? 0.25 : n.status === 'provisioning' || n.status === 'booting' ? 0.55 : n.status === 'offline' ? 0.7 : 1
        b.alpha += (statusA - b.alpha) * ease(4)
        const tcol = level === 'amber' ? C.amber : C.red
        const dim = dimOf(b)
        const a = b.alpha * dim
        const lay = b.ex > 0 ? layoutOf(b) : null
        const e = b.ex
        const fr = Math.max(st.w, st.d) / 2
        const c0 = P(X, Y, st.h / 2)
        const rs0 = Math.max(10, (fr + st.h * 0.35) * k)
        const R = lay ? lay.R * e + fr * (1 - e) : fr
        const isSel = sel?.kind === 'node' && sel.id === b.id
        const isHov = hover?.kind === 'node' && hover.id === b.id

        // ground decorations (issue glow, selection, rings) go with the block
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
            // boot ring + running check jobs: arcs on the ground around the block
            const ringR = R + 12
            if (n.status === 'provisioning' || n.status === 'booting') {
              const t = (now - b.bootStart) / 1000
              const prog = n.status === 'provisioning' ? 0.4 * (1 - Math.exp(-t / 3)) : 0.4 + 0.55 * (1 - Math.exp(-t / 5))
              const g = groundEllipse(X, Y, 0, ringR)
              ctx.strokeStyle = 'rgba(40,56,84,0.15)'; ctx.lineWidth = 2.5
              ctx.beginPath(); ctx.ellipse(g.cx, g.cy, g.rx, g.ry, 0, 0, Math.PI * 2); ctx.stroke()
              ctx.strokeStyle = C.acc
              ctx.beginPath(); ctx.ellipse(g.cx, g.cy, g.rx, g.ry, 0, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * prog); ctx.stroke()
            }
            const jobs = jobsByNode.get(b.id) ?? []
            jobs.forEach((r, i) => {
              const g = groundEllipse(X, Y, 0, ringR + 5 + i * 6)
              const end = -Math.PI / 2 + Math.PI * 2 * Math.max(0.06, r.progress)
              ctx.globalAlpha = r.alpha * dim
              ctx.strokeStyle = C.job
              ctx.lineWidth = 2
              ctx.beginPath(); ctx.ellipse(g.cx, g.cy, g.rx, g.ry, 0, -Math.PI / 2, end); ctx.stroke()
              const tx = g.cx + Math.cos(end) * g.rx, ty = g.cy + Math.sin(end) * g.ry
              ctx.fillStyle = C.job
              ctx.beginPath(); ctx.arc(tx, ty, 2.6, 0, Math.PI * 2); ctx.fill()
              ctx.globalAlpha = 1
            })
          },
        })

        // the block itself: opens (lid rises, body fades) when expanded
        if (e < 0.995) {
          drawJobs.push({
            depth: X + Y,
            draw: () => drawBlock(n, X, Y, 0, level || surgeTint ? tcol : null, b.ta * (level === 'red' ? 1.6 : 1), a * (1 - 0.88 * e), e * 26),
          })
        }

        // file tiles
        if (lay && e > 0.01) {
          for (const f of lay.role.files) {
            const fp = lay.pos.get(f.path)
            if (!fp) continue
            const fx = X + fp.x * e, fy = Y + fp.y * e
            const fi = fileIssues(n, f.path)
            const fl = levelOf(fi)
            const isF = sel?.kind === 'node' && sel.id === b.id && sel.file === f.path
            const isH = hover?.kind === 'file' && hover.id === b.id && hover.file === f.path
            const s = fp.s * (0.4 + 0.6 * e)
            const h = fp.h * e
            const isEntry = f.path === lay.entry
            drawJobs.push({
              depth: fx + fy + 0.02,
              draw: () => {
                ctx.globalAlpha = e
                shadow(fx, fy, s, s, h, e)
                if (isF || isH) {
                  const o = s / 2 + 6
                  poly([P(fx - o, fy - o), P(fx + o, fy - o), P(fx + o, fy + o), P(fx - o, fy + o)])
                  ctx.strokeStyle = rgba(C.acc, isF ? 0.95 : 0.55); ctx.lineWidth = isF ? 2 : 1.3; ctx.stroke()
                }
                const ff = faces(fl ? (fl === 'red' ? C.red : C.amber) : null, fl ? 1.6 : 0)
                box(fx, fy, 0, s, s, h, ff)
                // file "page" decal on top: role colour for entry, ink otherwise
                const ic = s * 0.5
                poly([P(fx - ic / 2, fy - ic / 2, h), P(fx + ic / 2, fy - ic / 2, h), P(fx + ic / 2, fy + ic / 2, h), P(fx - ic / 2, fy + ic / 2, h)])
                ctx.fillStyle = fl ? rgba(fl === 'red' ? C.red : C.amber, 0.9) : isEntry ? st.color : rgba(st.color, 0.55)
                ctx.fill()
                ctx.globalAlpha = 1
              },
            })
            const top = P(fx, fy, h)
            if (e > 0.5) newHits.push({ kind: 'file', id: b.id, file: f.path, sx: top.x, sy: top.y + s * 0.3 * k, rs: Math.max(s * 0.9 * k, 9) })
            if (e > 0.6) fileLabels.push({ x: top.x, y: top.y - s * 0.62 * k - 4, text: f.label, loc: f.loc, a: (e - 0.6) / 0.4, sel: isF, id: b.id, file: f.path, level: fl, n: fi.length })
            circles.push({ id: b.id + f.path, x: top.x, y: top.y + s * 0.3 * k, r: s * 0.7 * k })
          }
        }

        // hit target: block body; expanded → the platform (files pushed later win)
        const hitR = lay && e > 0.5 ? R * k * 1.1 : rs0
        const hc = lay && e > 0.5 ? P(X, Y, 0) : c0
        newHits.splice(newHits.length - (lay && e > 0.5 ? lay.role.files.length : 0), 0, { kind: 'node', id: b.id, sx: hc.x, sy: hc.y, rs: hitR })
        if (e < 0.5) circles.push({ id: b.id, x: c0.x, y: c0.y, r: rs0 * 0.95 })
        // label anchor: above the block top (or above the platform's back corner)
        const topZ = st.h + 26 * e
        const ap = e > 0.5 && lay ? P(X - R, Y - R, 0) : P(X, Y, topZ)
        labelJobs.push({
          b, sx: ap.x, sy: ap.y, foot: { x: c0.x, y: c0.y, r: rs0 }, a, level: nIssues > 0 && b.ta > 0.05 ? level : null, n: nIssues,
          prio: (isSel || isHov ? 100 : 0) + st.weight + (level ? 3 : 0),
        })
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

      // -- file labels (small flat tags) ----------------------------------------------
      for (const fl of fileLabels) {
        ctx.globalAlpha = fl.a
        ctx.font = `500 10px ${MONO}`
        const tw = ctx.measureText(fl.text).width
        ctx.font = `400 9px ${MONO}`
        const lw = ctx.measureText(String(fl.loc)).width
        const w = tw + lw + 16
        const x = fl.x - w / 2, y = fl.y - 16
        fileRects.push({ x0: x - 2, y0: y - 2, x1: x + w + 2, y1: y + 17 })
        if (fl.level && fl.a > 0.3) badgeJobs.push({ id: fl.id, file: fl.file, x: x + w + 11, y: y + 7.5, level: fl.level, n: fl.n, a: fl.a })
        ctx.fillStyle = fl.sel ? '#e7f0fd' : 'rgba(255,255,255,0.95)'
        ctx.beginPath(); ctx.roundRect(x, y, w, 15, 3); ctx.fill()
        ctx.strokeStyle = fl.sel ? rgba(C.acc, 0.8) : 'rgba(60,80,110,0.2)'
        ctx.lineWidth = 1
        ctx.stroke()
        ctx.textAlign = 'left'
        ctx.textBaseline = 'middle'
        ctx.font = `500 10px ${MONO}`
        ctx.fillStyle = C.ink
        ctx.fillText(fl.text, x + 5, y + 8)
        ctx.font = `400 9px ${MONO}`
        ctx.fillStyle = C.dim
        ctx.fillText(String(fl.loc), x + 11 + tw, y + 8)
        ctx.globalAlpha = 1
      }

      // -- status tags + labels: flat white tags above blocks (collision pass) -------
      {
        type Rect = { x0: number; y0: number; x1: number; y1: number }
        const placed: Rect[] = [...fileRects]
        const overlaps = (r: Rect, ownId: string) => {
          for (const q of placed) if (r.x0 < q.x1 && r.x1 > q.x0 && r.y0 < q.y1 && r.y1 > q.y0) return true
          for (const c of circles) {
            if (c.id === ownId || c.id.startsWith(ownId)) continue
            const nx = clamp(c.x, r.x0, r.x1), ny = clamp(c.y, r.y0, r.y1)
            if (Math.hypot(c.x - nx, c.y - ny) < c.r) return true
          }
          return false
        }
        const showGauge = k > 0.55
        for (const j of labelJobs.sort((p, q) => q.prio - p.prio)) {
          const n = j.b.node
          const tag = n.status === 'provisioning' || n.status === 'booting' || n.status === 'deleting' || n.status === 'offline' ? n.status.toUpperCase() : ''
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
          const sx = j.sx
          const y1 = j.sy - 12
          let rect = { x0: sx - w / 2, y0: y1 - h, x1: sx + w / 2, y1 }
          let below = false
          if (j.prio < 100 && overlaps(rect, j.b.id)) {
            // try under the block's front corner
            const fy = j.foot.y + j.foot.r + 8
            const alt = { x0: j.foot.x - w / 2, y0: fy, x1: j.foot.x + w / 2, y1: fy + h }
            if (overlaps(alt, j.b.id) || alt.y1 > H - BOTTOM_PAD + 10) continue
            rect = alt
            below = true
          }
          placed.push(rect)
          const a = Math.max(0.55, j.a)
          ctx.globalAlpha = a
          // leader line from tag to block top
          if (!below) {
            ctx.strokeStyle = 'rgba(40,56,84,0.35)'
            ctx.lineWidth = 1
            ctx.beginPath(); ctx.moveTo(sx, rect.y1); ctx.lineTo(sx, j.sy - 2); ctx.stroke()
          }
          ctx.save()
          ctx.shadowColor = 'rgba(30,45,70,0.14)'
          ctx.shadowBlur = 8
          ctx.shadowOffsetY = 2
          ctx.fillStyle = '#ffffff'
          ctx.beginPath(); ctx.roundRect(rect.x0, rect.y0, w, h, 4); ctx.fill()
          ctx.restore()
          ctx.strokeStyle = j.prio >= 100 ? rgba(C.acc, 0.7) : 'rgba(60,80,110,0.18)'
          ctx.lineWidth = 1
          ctx.beginPath(); ctx.roundRect(rect.x0 + 0.5, rect.y0 + 0.5, w - 1, h - 1, 4); ctx.stroke()
          // role colour stripe on the left
          ctx.fillStyle = shapeOf(n.role).color
          ctx.fillRect(rect.x0 + 0.5, rect.y0 + 4, 2.5, h - 8)
          const lx = rect.x0 + 8
          ctx.textAlign = 'left'
          ctx.textBaseline = 'top'
          ctx.font = `600 11px ${SANS}`
          ctx.fillStyle = C.ink
          ctx.fillText(label, lx, rect.y0 + 4)
          if (tag) {
            ctx.font = `600 8.5px ${MONO}`
            const tx = lx + lw + 6
            ctx.fillStyle = n.status === 'offline' ? C.red : C.acc
            ctx.beginPath(); ctx.roundRect(tx, rect.y0 + 4.5, tagW, 12, 2); ctx.fill()
            ctx.fillStyle = '#fff'
            ctx.fillText(tag, tx + 4, rect.y0 + 6.5)
          }
          ctx.font = `400 10px ${MONO}`
          ctx.fillStyle = C.dim
          ctx.fillText(ip, lx, rect.y0 + 18)
          if (showGauge && n.status === 'running') {
            const gy = rect.y0 + 32
            const vals = [n.cpu, n.memTotal ? n.memUsed / n.memTotal : 0]
            vals.forEach((v, i) => {
              const x = lx + i * 36
              ctx.fillStyle = 'rgba(60,80,110,0.13)'
              ctx.fillRect(x, gy, 32, 3)
              ctx.fillStyle = v > 0.9 ? C.red : v > 0.75 ? C.amber : C.acc
              ctx.fillRect(x, gy, 32 * clamp(v, 0, 1), 3)
            })
          }
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
              const min = 26
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
          ctx.font = `700 10px ${SANS}`
          const w = Math.max(17, ctx.measureText(text).width + 9)
          ctx.globalAlpha = Math.max(0.6, bj.a) * (red ? 1 : 0.85 + 0.15 * pulse)
          ctx.fillStyle = col
          ctx.beginPath(); ctx.roundRect(bj.x - w / 2, bj.y - 8, w, 16, 8); ctx.fill()
          ctx.strokeStyle = '#ffffff'
          ctx.lineWidth = 1.5
          ctx.stroke()
          ctx.fillStyle = '#ffffff'
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(text, bj.x, bj.y + 0.5)
          ctx.globalAlpha = 1
          newHits.push({ kind: 'badge', id: bj.id, file: bj.file, sx: bj.x, sy: bj.y, rs: w / 2 })
        }
      }
      hits = newHits
      if (hoverLink && !visibleLinks.has(hoverLink)) hoverLink = null
      if (hover) {
        const h = hover
        hover = hits.find((x) => x.kind === h.kind && x.id === h.id && x.file === h.file) ?? null
      }

      // -- tooltips ------------------------------------------------------------------
      if (!press && mouse) {
        if (hover?.kind === 'node') {
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
            if (codeFor(Pp.codemap, n.role) && b.ex < 0.5) lines.push({ t: 'click to open into files', c: C.acc })
            drawTooltip(lines, { x: hover.sx, y: hover.sy, r: Math.min(hover.rs, 60) + 10 }, 'node')
          }
        } else if (hover?.kind === 'file') {
          const b = bodies.get(hover.id)
          const lay = b ? layoutOf(b) : null
          const f = lay?.role.files.find((x) => x.path === hover!.file)
          if (b && lay && f) {
            const ports = lay.role.ports.filter((q) => q.file === f.path).map((q) => `${q.dir} :${q.port}`)
            const imports = lay.role.edges.filter((e) => e.from === f.path).length
            const lines: { t: string; c?: string }[] = [{ t: f.path }, { t: `${f.loc} loc  ·  imports ${imports}${ports.length ? '  ·  ' + ports.join(', ') : ''}` }]
            for (const i of fileIssues(b.node, f.path).slice(0, 2)) lines.push({ t: `! ${i.severity}  ${i.title}`, c: (SEV_RANK[i.severity] ?? 0) >= 3 ? C.red : C.amber })
            drawTooltip(lines, { x: hover.sx, y: hover.sy, r: hover.rs + 6 }, 'node')
          }
        } else if (hover?.kind === 'badge') {
          const b = bodies.get(hover.id)
          const src = b ? (hover.file ? fileIssues(b.node, hover.file) : b.node.issues ?? []) : []
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
