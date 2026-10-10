import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from 'd3-force'
import type { Simulation, SimulationLinkDatum, SimulationNodeDatum } from 'd3-force'
import { ACTIVE_AGENT, codeFor, fileIssues, fmtMem, fmtRate, isControl, issueLevel } from '../../graph/GraphView'
import type { Sel } from '../../graph/GraphView'
import { loadPos, savePos, takeAlias, takePlacement } from '../../graph/positions'
import type { Agent, Codemap, CodemapRole, Fleet, FleetIssue, FleetLink, FleetNode, Metrics } from '../../graph/types'
import { ICON_HH, ICON_HW, ICON_SCALE, iconFor, path2d } from './icons'
import type { Part } from './icons'

// ---------------------------------------------------------------------------
// Logical network diagram (Packet Tracer / Visio style) on a canvas.
// Device symbols, orthogonal links with port labels at the ends, zone boxes
// derived from the real addressing, packet glyphs paced by real bytes/s.
// ---------------------------------------------------------------------------

export const PAL = {
  paper: '#f3f0e6',
  ink: '#1b3a6b',
  inkSoft: '#4c6690',
  dim: '#7d89a1',
  face: '#dce5f1',
  side: '#b7c7dd',
  red: '#c42b1c',
  amber: '#b57200',
  redPale: '#f3cfc8',
  amberPale: '#f1e0b8',
  sel: '#0b7f8f',
}

export const PROTO_COLOR: Record<string, string> = {
  http: '#1b3a6b',
  'http-app': '#1b3a6b',
  postgres: '#1d7663',
  redis: '#9a5410',
  ssh: '#8a94a8',
  control: '#8a94a8',
  other: '#8a94a8',
}
const PROTO_SHORT: Record<string, string> = { http: 'http', 'http-app': 'http', postgres: 'pg', redis: 'redis', ssh: 'ssh', control: 'ssh' }

const MONO = '"IBM Plex Mono", ui-monospace, Menlo, monospace'
const SANS = '"IBM Plex Sans Condensed", "IBM Plex Sans", "Helvetica Neue", sans-serif'

// layout tiers: left→right like a logical diagram (edge → core → data)
const TIER: Record<string, { x: number; y: number }> = {
  internet: { x: -800, y: 90 },
  controller: { x: -800, y: -170 },
  traffic: { x: -520, y: 0 },
  lb: { x: -260, y: 0 },
  app: { x: 20, y: 0 },
  worker: { x: 20, y: 270 },
  cache: { x: 320, y: -130 },
  db: { x: 320, y: 130 },
}
const tierOf = (r: string) => TIER[r] ?? { x: 0, y: 160 }
const ANCHOR_ROLE: Record<string, string> = { app: 'lb', worker: 'db', cache: 'app', db: 'app', lb: 'traffic', traffic: 'internet' }

const SEV_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 }
const LINK_GRACE_MS = 30000
const TOP_PAD = 104
const BOTTOM_PAD = 176
const LEFT_PAD = 214
const RIGHT_PAD = 40
const GRID = 20

type Level = 'red' | 'amber'
type Side = 'L' | 'R' | 'T' | 'B'
interface Pt { x: number; y: number }

interface Body extends SimulationNodeDatum {
  id: string
  node: FleetNode
  pending: boolean
  ta: number
  alpha: number
  ex: number
  open: boolean
  bootStart: number
  bootPhase: string
  lastIssueCount: number
  labelW: number
}

interface LinkR extends SimulationLinkDatum<Body> {
  id: string
  a: Body
  b: Body
  data: FleetLink
  sF: number
  sR: number
  phF: number
  phR: number
  dead: boolean
  present: boolean
  goneAt: number
  route: Pt[] // world polyline, recomputed per frame
}

interface RackRow { path: string; label: string; loc: number; u: number; uTop: number; y0: number; y1: number }
interface Rack {
  role: CodemapRole
  rows: RackRow[]
  byPath: Map<string, RackRow>
  RW: number
  RH: number
  totalU: number
  lane: Map<number, number> // edge index → patch lane
  lanes: number
  pathTo: Map<string, [string, string][]>
}

interface AgentR { id: string; type: string; note: string; status: string; progress: number; target: string; alpha: number; active: boolean }
interface Ghost { x: number; y: number; role: string; t: number }
type Hit = { kind: 'node' | 'badge' | 'file'; id: string; file?: string; x0: number; y0: number; x1: number; y1: number }

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
  scaleRef?: RefObject<HTMLSpanElement | null>
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v)

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
  const A = rgb(a), B = rgb(b)
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
  let lo = 0, hi = s.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (ctx.measureText(s.slice(0, mid) + '…').width <= max) lo = mid
    else hi = mid - 1
  }
  return s.slice(0, lo) + '…'
}

const isPrivate = (ip: string) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)
const ipNum = (ip: string) => ip.split('.').reduce((s, o) => s * 256 + (Number(o) & 255), 0)
/** Smallest CIDR block covering all the given IPv4 addresses. */
export function coveringCidr(ips: string[]): string {
  if (!ips.length) return ''
  const nums = ips.map(ipNum)
  let bits = 32
  const first = nums[0]
  for (const n of nums) {
    while (bits > 0 && Math.floor(n / 2 ** (32 - bits)) !== Math.floor(first / 2 ** (32 - bits))) bits--
  }
  const base = Math.floor(first / 2 ** (32 - bits)) * 2 ** (32 - bits)
  return `${[24, 16, 8, 0].map((s) => Math.floor(base / 2 ** s) % 256).join('.')}/${bits}`
}
const shortIp = (ip: string) => (ip && ip !== '—' ? '.' + ip.split('.').slice(2).join('.') : '')
const addrOf = (n: FleetNode) => (n.privateIp && n.privateIp !== '—' ? n.privateIp : n.publicIp && n.publicIp !== '—' ? n.publicIp : '')

// ---- rack elevation layout (expanded node) ---------------------------------
const RACK_W = 430
const RACK_HEAD = 48
const RACK_U = 26
const RACK_FOOT = 16
const RAIL = 18
const rackCache = new Map<string, Rack>()
export function rackFor(role: string, cr: CodemapRole): Rack {
  const key = `${role}|${cr.files.map((f) => f.path + f.loc).join(',')}|${cr.edges.length}|${cr.ports.length}`
  const hit = rackCache.get(key)
  if (hit) return hit
  const portFiles = new Set(cr.ports.map((p) => p.file))
  const entry = cr.ports.find((p) => p.dir === 'in')?.file ?? cr.files.slice().sort((a, b) => b.loc - a.loc)[0].path
  const ordered = [
    ...cr.files.filter((f) => f.path === entry),
    ...cr.files.filter((f) => f.path !== entry).sort((a, b) => Number(portFiles.has(b.path)) - Number(portFiles.has(a.path)) || b.loc - a.loc),
  ]
  const rows: RackRow[] = []
  let u = 0
  for (const f of ordered) {
    const n = f.loc >= 300 ? 3 : f.loc >= 120 ? 2 : 1
    rows.push({ path: f.path, label: f.label, loc: f.loc, u: n, uTop: u, y0: 0, y1: 0 })
    u += n
  }
  const RH = RACK_HEAD + u * RACK_U + RACK_FOOT
  for (const r of rows) {
    r.y0 = -RH / 2 + RACK_HEAD + r.uTop * RACK_U
    r.y1 = r.y0 + r.u * RACK_U
  }
  const byPath = new Map(rows.map((r) => [r.path, r]))
  // patch lanes: interval colouring so cords never share a vertical run
  const spans = cr.edges
    .map((e, i) => {
      const A = byPath.get(e.from), B = byPath.get(e.to)
      if (!A || !B) return null
      const ya = (A.y0 + A.y1) / 2, yb = (B.y0 + B.y1) / 2
      return { i, lo: Math.min(ya, yb), hi: Math.max(ya, yb) }
    })
    .filter((s): s is { i: number; lo: number; hi: number } => !!s)
    .sort((a, b) => a.hi - a.lo - (b.hi - b.lo))
  const lane = new Map<number, number>()
  const used: { lo: number; hi: number }[][] = []
  for (const s of spans) {
    let l = 0
    while (used[l]?.some((q) => s.lo <= q.hi + 2 && s.hi >= q.lo - 2)) l++
    ;(used[l] ??= []).push(s)
    lane.set(s.i, l)
  }
  // import paths from the entry file (importer → imported)
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
  const rack = { role: cr, rows, byPath, RW: RACK_W, RH, totalU: u, lane, lanes: used.length, pathTo }
  rackCache.set(key, rack)
  return rack
}

// ---- polyline helpers --------------------------------------------------------
const NORMAL: Record<Side, Pt> = { L: { x: -1, y: 0 }, R: { x: 1, y: 0 }, T: { x: 0, y: -1 }, B: { x: 0, y: 1 } }
const STUB = 20
function orthoRoute(p0: Pt, s0: Side, p1: Pt, s1: Side, off: number): Pt[] {
  const n0 = NORMAL[s0], n1 = NORMAL[s1]
  const a = { x: p0.x + n0.x * STUB, y: p0.y + n0.y * STUB }
  const b = { x: p1.x + n1.x * STUB, y: p1.y + n1.y * STUB }
  const h0 = s0 === 'L' || s0 === 'R'
  const h1 = s1 === 'L' || s1 === 'R'
  let mid: Pt[]
  if (h0 && h1) {
    const forward = n0.x * (b.x - a.x) >= 0 && n1.x * (a.x - b.x) >= 0
    if (forward) {
      const mx = (a.x + b.x) / 2 + off
      mid = [{ x: mx, y: a.y }, { x: mx, y: b.y }]
    } else {
      const my = (a.y + b.y) / 2 + off
      mid = [{ x: a.x, y: my }, { x: b.x, y: my }]
    }
  } else if (!h0 && !h1) {
    const my = (a.y + b.y) / 2 + off
    mid = [{ x: a.x, y: my }, { x: b.x, y: my }]
  } else if (h0) mid = [{ x: b.x, y: a.y }]
  else mid = [{ x: a.x, y: b.y }]
  const pts = [p0, a, ...mid, b, p1]
  // drop zero-length and collinear points
  const out: Pt[] = []
  for (const p of pts) {
    const q = out[out.length - 1]
    if (q && Math.abs(q.x - p.x) < 0.01 && Math.abs(q.y - p.y) < 0.01) continue
    if (out.length >= 2) {
      const o = out[out.length - 2]
      if ((Math.abs(o.x - q.x) < 0.01 && Math.abs(q.x - p.x) < 0.01) || (Math.abs(o.y - q.y) < 0.01 && Math.abs(q.y - p.y) < 0.01)) out.pop()
    }
    out.push(p)
  }
  return out
}
function polyLen(pts: Pt[]): number {
  let L = 0
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  return L
}
function pointAt(pts: Pt[], s: number): { x: number; y: number; dx: number; dy: number } {
  for (let i = 1; i < pts.length; i++) {
    const A = pts[i - 1], B = pts[i]
    const l = Math.hypot(B.x - A.x, B.y - A.y)
    if (s <= l || i === pts.length - 1) {
      const t = l ? clamp(s / l, 0, 1) : 0
      return { x: A.x + (B.x - A.x) * t, y: A.y + (B.y - A.y) * t, dx: l ? (B.x - A.x) / l : 1, dy: l ? (B.y - A.y) / l : 0 }
    }
    s -= l
  }
  return { x: pts[0].x, y: pts[0].y, dx: 1, dy: 0 }
}
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay
  const L = dx * dx + dy * dy || 1
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / L, 0, 1)
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

// ---------------------------------------------------------------------------
export default function NetView(props: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const propsRef = useRef<Props>(props)
  propsRef.current = props

  const bodiesRef = useRef(new Map<string, Body>())
  const linksRef = useRef(new Map<string, LinkR>())
  const ghostsRef = useRef<Ghost[]>([])
  const burstsRef = useRef<{ id: string; age: number; color: string }[]>([])
  const simRef = useRef<Simulation<Body, LinkR> | null>(null)

  const rackOf = (b: Body): Rack | null => {
    const cr = codeFor(propsRef.current.codemap, b.node.role)
    return cr ? rackFor(b.node.role, cr) : null
  }
  const collideRadius = (d: Body) => {
    const r = d.open ? rackOf(d) : null
    if (r) return Math.hypot(r.RW, r.RH) / 2 * 0.82 + 40
    return Math.max(92, d.labelW / 2 + 26)
  }
  const collideRef = useRef(forceCollide<Body>(collideRadius).strength(1).iterations(2))

  if (!simRef.current) {
    simRef.current = forceSimulation<Body, LinkR>([])
      .force('link', forceLink<Body, LinkR>([]).id((d) => d.id).distance(210).strength(0.08))
      .force('charge', forceManyBody<Body>().strength(-420).distanceMax(520))
      .force('collide', collideRef.current)
      .force('x', forceX<Body>((d) => tierOf(d.node.role).x).strength(0.4))
      .force('y', forceY<Body>((d) => tierOf(d.node.role).y).strength(0.16))
      .stop()
  }

  // ---- sync fleet → scene ----------------------------------------------------
  useEffect(() => {
    const fleet = props.fleet
    const bodies = bodiesRef.current
    const links = linksRef.current
    const sim = simRef.current!
    const linkForce = sim.force('link') as ReturnType<typeof forceLink<Body, LinkR>>
    let structural = false
    let relink = false

    if (!fleet) {
      if (bodies.size || links.size) {
        bodies.clear(); links.clear(); sim.nodes([]); linkForce.links([])
      }
      return
    }
    const measure = (n: FleetNode) => Math.max(n.label.length, addrOf(n).length, 10) * 7

    const place = (n: FleetNode): { x: number; y: number; pin: boolean } => {
      const drop = takePlacement(n.id)
      if (drop) return { ...drop, pin: true }
      const saved = n.id.startsWith('pending-') ? null : loadPos(n.label)
      if (saved) return { ...saved, pin: true }
      const jitter = () => (Math.random() - 0.5) * 40
      const t = tierOf(n.role)
      for (const l of fleet.links) {
        const other = l.source === n.id ? l.target : l.target === n.id ? l.source : null
        const ob = other ? bodies.get(other) : undefined
        if (ob && !isControl(l.protocol)) return { x: t.x + jitter(), y: (ob.y ?? 0) + jitter(), pin: false }
      }
      const ar = ANCHOR_ROLE[n.role]
      for (const b of bodies.values()) if (b.node.role === ar) return { x: t.x + jitter(), y: (b.y ?? 0) + 120 + jitter(), pin: false }
      return { x: t.x + jitter(), y: t.y + jitter(), pin: false }
    }

    const seen = new Set<string>()
    for (const n of fleet.nodes) {
      let b = bodies.get(n.id)
      if (!b) {
        const tmp = takeAlias(n.id)
        const old = tmp ? bodies.get(tmp) : undefined
        if (tmp && old) {
          bodies.delete(tmp)
          old.id = n.id
          bodies.set(n.id, old)
          b = old
          if (old.fx != null && old.fy != null) savePos(n.label, old.fx, old.fy)
          structural = true
        }
      }
      if (!b) {
        const p = place(n)
        b = {
          id: n.id, node: n, pending: n.id.startsWith('pending-'), ta: 0, alpha: 0, ex: 0, open: false,
          bootStart: performance.now(), bootPhase: n.status, lastIssueCount: (n.issues ?? []).length,
          labelW: measure(n), x: p.x, y: p.y, fx: p.pin ? p.x : null, fy: p.pin ? p.y : null,
        }
        bodies.set(n.id, b)
        structural = true
      }
      if (b.bootPhase !== n.status) { b.bootPhase = n.status; b.bootStart = performance.now() }
      const ic = (n.issues ?? []).length
      if (ic > b.lastIssueCount) burstsRef.current.push({ id: n.id, age: 0, color: issueLevel(n) === 'amber' ? PAL.amber : PAL.red })
      b.lastIssueCount = ic
      if (b.node.label !== n.label) b.labelW = measure(n)
      b.node = n
      b.pending = n.id.startsWith('pending-')
      seen.add(n.id)
    }
    for (const [id, b] of bodies) {
      if (seen.has(id)) continue
      ghostsRef.current.push({ x: b.x ?? 0, y: b.y ?? 0, role: b.node.role, t: 0 })
      bodies.delete(id)
      structural = true
    }

    const lseen = new Set<string>()
    for (const l of fleet.links) {
      const a = bodies.get(l.source)
      const b = bodies.get(l.target)
      if (!a || !b || a === b) continue
      let lr = links.get(l.id)
      if (!lr || lr.a !== a || lr.b !== b) {
        if (lr) lr.dead = true
        lr = { id: l.id, a, b, source: a, target: b, data: l, sF: 0, sR: 0, phF: 0, phR: 0, dead: false, present: true, goneAt: 0, route: [] }
        links.set(l.id, lr)
        relink = true
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
      if (endsGone || nowMs - l.goneAt > LINK_GRACE_MS) {
        l.dead = true
        links.delete(id)
        relink = true
      }
    }
    if (structural || relink) {
      if (structural) sim.nodes([...bodies.values()])
      linkForce.links([...links.values()].filter((l) => !isControl(l.data.protocol)))
      sim.alpha(Math.max(sim.alpha(), structural ? 0.5 : 0.08))
      if (propsRef.current.reduced) sim.tick(260)
    }
  }, [props.fleet])

  // ---- canvas loop + interaction ---------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const sim = simRef.current!

    let W = window.innerWidth
    let H = window.innerHeight
    let dpr = 1
    const view = { k: 1, tx: W / 2, ty: H / 2 }
    let autoFit = true
    let focusN = -1
    let panTo: Pt | null = null
    let expandedId: string | null = null
    let lastScale = ''

    const pointers = new Map<number, Pt>()
    let press: { x: number; y: number; hit: Hit | null; moved: boolean; lastX: number; lastY: number } | null = null
    let pinch: { dist: number; k: number } | null = null
    let dragBody: Body | null = null
    let mouse: Pt | null = null
    let hover: Hit | null = null
    let hoverLink: LinkR | null = null
    let hits: Hit[] = []
    let visibleLinks = new Set<LinkR>()
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

    const S = (x: number | undefined, y: number | undefined): Pt => ({ x: (x ?? 0) * view.k + view.tx, y: (y ?? 0) * view.k + view.ty })
    const toWorld = (sx: number, sy: number): Pt => ({ x: (sx - view.tx) / view.k, y: (sy - view.ty) / view.k })
    const zoomAround = (sx: number, sy: number, nk: number) => {
      const k = clamp(nk, 0.25, 4)
      view.tx = sx - ((sx - view.tx) * k) / view.k
      view.ty = sy - ((sy - view.ty) * k) / view.k
      view.k = k
    }
    const isOpen = (b: Body) => b.ex > 0.5 && !!rackOf(b)

    // world-space extent of a body (icon + labels, or the rack)
    const extentOf = (b: Body) => {
      const x = b.x ?? 0, y = b.y ?? 0
      const r = b.ex > 0.01 ? rackOf(b) : null
      const iw = Math.max(ICON_HW + 8, b.labelW / 2 + 6)
      const ic = { x0: x - iw, x1: x + iw, y0: y - ICON_HH - 10, y1: y + ICON_HH + 52 }
      if (!r) return ic
      const e = b.ex
      const rk = { x0: x - r.RW / 2 - 6, x1: x + r.RW / 2 + 6, y0: y - r.RH / 2 - 6, y1: y + r.RH / 2 + 6 }
      return { x0: ic.x0 + (rk.x0 - ic.x0) * e, x1: ic.x1 + (rk.x1 - ic.x1) * e, y0: ic.y0 + (rk.y0 - ic.y0) * e, y1: ic.y1 + (rk.y1 - ic.y1) * e }
    }

    const fitTarget = () => {
      const bodies = bodiesRef.current
      if (bodies.size === 0) return null
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      for (const b of bodies.values()) {
        const e = extentOf(b)
        x0 = Math.min(x0, e.x0 - 40); x1 = Math.max(x1, e.x1 + 40)
        y0 = Math.min(y0, e.y0 - 54); y1 = Math.max(y1, e.y1 + 30) // room for zone frames + tabs
      }
      const aw = Math.max(200, W - LEFT_PAD - Math.max(RIGHT_PAD, propsRef.current.rightInset))
      const ah = Math.max(160, H - TOP_PAD - BOTTOM_PAD)
      const k = clamp(Math.min(aw / (x1 - x0), ah / (y1 - y0)), 0.3, 1.5)
      return { k, tx: LEFT_PAD + aw / 2 - ((x0 + x1) / 2) * k, ty: TOP_PAD + ah / 2 - ((y0 + y1) / 2) * k }
    }

    const hitTest = (x: number, y: number): Hit | null => {
      for (let i = hits.length - 1; i >= 0; i--) {
        const h = hits[i]
        if (x >= h.x0 - 3 && x <= h.x1 + 3 && y >= h.y0 - 3 && y <= h.y1 + 3) return h
      }
      return null
    }
    const linkAt = (x: number, y: number): LinkR | null => {
      let best: LinkR | null = null
      let bd = 6
      for (const l of visibleLinks) {
        const r = l.route
        for (let i = 1; i < r.length; i++) {
          const A = S(r[i - 1].x, r[i - 1].y), B = S(r[i].x, r[i].y)
          const d = segDist(x, y, A.x, A.y, B.x, B.y)
          if (d < bd) { bd = d; best = l }
        }
      }
      return best
    }

    // ---- input ---------------------------------------------------------------
    const pos = (e: MouseEvent): Pt => {
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
        if (dragBody) { sim.alphaTarget(0); dragBody = null }
        return
      }
      press = { x: p.x, y: p.y, hit: hitTest(p.x, p.y), moved: false, lastX: p.x, lastY: p.y }
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
        if (h) {
          dragBody = bodiesRef.current.get(h.id) ?? null
          if (dragBody) { sim.alphaTarget(0.1); if (sim.alpha() < 0.1) sim.alpha(0.1) }
        }
        canvas.style.cursor = 'grabbing'
      }
      if (!press.moved) return
      if (dragBody) {
        // snap to the drawing grid while dragging
        const w = toWorld(p.x, p.y)
        const gx = Math.round(w.x / (GRID / 2)) * (GRID / 2)
        const gy = Math.round(w.y / (GRID / 2)) * (GRID / 2)
        dragBody.fx = gx; dragBody.fy = gy; dragBody.x = gx; dragBody.y = gy
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
        const P = propsRef.current
        if (h?.kind === 'file' || h?.kind === 'badge') P.onSelect({ kind: 'node', id: h.id, file: h.file })
        else if (h?.kind === 'node') {
          const same = P.selected?.kind === 'node' && P.selected.id === h.id
          P.onSelect(same ? null : { kind: 'node', id: h.id })
        } else {
          const l = linkAt(press.x, press.y)
          P.onSelect(l ? { kind: 'link', id: l.id } : null)
        }
      }
      if (dragBody) {
        if (!dragBody.pending && dragBody.fx != null && dragBody.fy != null) savePos(dragBody.node.label, dragBody.fx, dragBody.fy)
        sim.alphaTarget(0)
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
      const w = toWorld(p.x, p.y)
      propsRef.current.onDropRole(role, Math.round(w.x / GRID) * GRID, Math.round(w.y / GRID) * GRID)
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

    // ---- drawing helpers -------------------------------------------------------
    const drawIcon = (parts: Part[], sx: number, sy: number, scale: number, faceCol: string, sideCol: string, inkCol: string, dashed: boolean) => {
      ctx.save()
      ctx.translate(sx, sy)
      ctx.scale(scale, scale)
      ctx.lineWidth = 1.35 / scale * clamp(scale, 0.7, 1.3)
      ctx.lineJoin = 'round'
      ctx.lineCap = 'round'
      if (dashed) ctx.setLineDash([3 / scale * scale, 2.5])
      for (const p of parts) {
        const path = path2d(p.d)
        if (p.fill !== 'none') {
          ctx.fillStyle = p.fill === 'face' ? faceCol : p.fill === 'side' ? sideCol : p.fill === 'ink' ? inkCol : PAL.paper
          ctx.fill(path)
        }
        if (p.stroke !== false) {
          ctx.strokeStyle = inkCol
          ctx.stroke(path)
        }
      }
      ctx.restore()
    }
    const intensity = (bps: number) => clamp(Math.log10(1 + bps / 1024) / 3.5, 0, 1)
    const packetSpeed = (bps: number) => (bps < 1 ? 0 : 16 + 58 * intensity(bps)) // world px/s
    const packetGap = (bps: number) => 86 - 58 * intensity(bps) // world px between packets

    // packets: small frames travelling along the route, one lane per direction
    const drawPackets = (route: Pt[], bps: number, phase: number, col: string, filled: boolean, alpha: number) => {
      if (bps < 1 || route.length < 2) return
      const L = polyLen(route)
      const gap = packetGap(bps)
      const k = view.k
      const pw = clamp(8 * k, 5, 10), ph = clamp(5 * k, 3.4, 6)
      const off = clamp(4.2 * k, 3.2, 5.2)
      ctx.globalAlpha = alpha
      for (let s = ((phase % gap) + gap) % gap + 6; s < L - 6; s += gap) {
        const q = pointAt(route, s)
        const p = S(q.x, q.y)
        // right-hand side of travel direction
        const cx = p.x - q.dy * off, cy = p.y + q.dx * off
        ctx.save()
        ctx.translate(cx, cy)
        ctx.rotate(Math.atan2(q.dy, q.dx))
        if (filled) {
          ctx.fillStyle = col
          ctx.fillRect(-pw / 2, -ph / 2, pw, ph)
        } else {
          ctx.fillStyle = PAL.paper
          ctx.fillRect(-pw / 2, -ph / 2, pw, ph)
          ctx.strokeStyle = col
          ctx.lineWidth = 1
          ctx.strokeRect(-pw / 2 + 0.5, -ph / 2 + 0.5, pw - 1, ph - 1)
        }
        ctx.restore()
      }
      ctx.globalAlpha = 1
    }

    const drawTooltip = (lines: { t: string; c?: string; b?: boolean }[], anchor: { x0: number; y0: number; x1: number; y1: number }, side: 'node' | 'cursor') => {
      ctx.font = `400 11px ${MONO}`
      const maxW = Math.min(360, W - 24)
      const shown = lines.map((l) => ({ ...l, t: truncate(ctx, l.t, maxW - 18) }))
      const w = Math.min(maxW, Math.max(...shown.map((l) => ctx.measureText(l.t).width)) + 18)
      const h = shown.length * 16 + 12
      let x: number, y: number
      if (side === 'node') {
        x = anchor.x1 + 12
        if (x + w > W - 8) x = anchor.x0 - 12 - w
        y = (anchor.y0 + anchor.y1) / 2 - h / 2
      } else {
        x = anchor.x0 + 14; y = anchor.y0 + 14
        if (x + w > W - 8) x = anchor.x0 - 14 - w
        if (y + h > H - 8) y = anchor.y0 - 14 - h
      }
      x = clamp(x, 8, W - 8 - w)
      y = clamp(y, 50, H - 8 - h)
      ctx.fillStyle = 'rgba(250,248,241,0.97)'
      ctx.fillRect(x, y, w, h)
      ctx.strokeStyle = PAL.ink
      ctx.lineWidth = 1
      ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h))
      ctx.fillStyle = PAL.ink
      ctx.fillRect(Math.round(x), Math.round(y), 3, Math.round(h) + 1)
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      shown.forEach((l, i) => {
        ctx.font = `${i === 0 ? 600 : 400} 11px ${MONO}`
        ctx.fillStyle = l.c ?? (i === 0 ? PAL.ink : PAL.inkSoft)
        ctx.fillText(l.t, x + 10, y + 7 + i * 16)
      })
    }

    // ---- frame -------------------------------------------------------------------
    let raf = 0
    let last = performance.now()
    const frame = (now: number) => {
      const dt = Math.min(0.25, Math.max(0, (now - last) / 1000))
      last = now
      const P = propsRef.current
      const red = P.reduced
      const pulse = red ? 1 : 0.75 + 0.25 * Math.sin(now / 420)
      const bodies = bodiesRef.current
      const links = linksRef.current
      const sel = P.selected

      const want = sel?.kind === 'node' && bodies.has(sel.id) && codeFor(P.codemap, bodies.get(sel.id)!.node.role) ? sel.id : null
      if (want !== expandedId) {
        expandedId = want
        for (const b of bodies.values()) b.open = b.id === want
        collideRef.current.radius(collideRadius)
        sim.alpha(Math.max(sim.alpha(), 0.3))
        if (red) sim.tick(140)
      }
      let dimAll = 0
      for (const b of bodies.values()) {
        b.ex += ((b.open ? 1 : 0) - b.ex) * (red ? 1 : 1 - Math.exp(-dt * 7))
        if (b.ex < 0.001) b.ex = 0
        dimAll = Math.max(dimAll, b.ex)
      }
      if (sim.alpha() > sim.alphaMin()) sim.tick(clamp(Math.round(dt / 0.016), 1, 12))

      if (P.focus && P.focus.n !== focusN) {
        focusN = P.focus.n
        const b = bodies.get(P.focus.id)
        if (b) { autoFit = false; panTo = { x: b.x ?? 0, y: b.y ?? 0 } }
      }
      if (panTo) {
        const cx = LEFT_PAD + (W - LEFT_PAD - Math.max(RIGHT_PAD, P.rightInset)) / 2
        const cy = TOP_PAD + (H - TOP_PAD - BOTTOM_PAD) / 2
        const t = red ? 1 : 1 - Math.exp(-dt * 6)
        const tx = cx - panTo.x * view.k, ty = cy - panTo.y * view.k
        view.tx += (tx - view.tx) * t
        view.ty += (ty - view.ty) * t
        if (Math.abs(tx - view.tx) + Math.abs(ty - view.ty) < 1) panTo = null
      }
      if (autoFit && !dragBody) {
        const f = fitTarget()
        if (f) {
          const t = red ? 1 : 1 - Math.exp(-dt * 4)
          view.k += (f.k - view.k) * t
          view.tx += (f.tx - view.tx) * t
          view.ty += (f.ty - view.ty) * t
        }
      }
      const k = view.k
      // title block "SCALE" readout = live zoom
      const scaleTxt = k >= 1 ? `${k.toFixed(2)} : 1` : `1 : ${(1 / k).toFixed(2)}`
      if (scaleTxt !== lastScale && P.scaleRef?.current) { P.scaleRef.current.textContent = scaleTxt; lastScale = scaleTxt }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.globalAlpha = 1
      ctx.fillStyle = PAL.paper
      ctx.fillRect(0, 0, W, H)

      // -- drafting grid (world-anchored, minor + major) -------------------------
      {
        const minor = GRID * k
        if (minor > 7) {
          const x0 = ((view.tx % minor) + minor) % minor
          const y0 = ((view.ty % minor) + minor) % minor
          ctx.strokeStyle = rgba(PAL.ink, 0.045)
          ctx.lineWidth = 1
          ctx.beginPath()
          for (let x = x0; x < W; x += minor) { ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, H) }
          for (let y = y0; y < H; y += minor) { ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(W, Math.round(y) + 0.5) }
          ctx.stroke()
        }
        const major = GRID * 5 * k
        const x0 = ((view.tx % major) + major) % major
        const y0 = ((view.ty % major) + major) % major
        ctx.strokeStyle = rgba(PAL.ink, 0.08)
        ctx.beginPath()
        for (let x = x0; x < W; x += major) { ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, H) }
        for (let y = y0; y < H; y += major) { ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(W, Math.round(y) + 0.5) }
        ctx.stroke()
      }

      const newHits: Hit[] = []
      const dimOf = (b: Body) => 1 - 0.55 * Math.max(0, dimAll - b.ex)
      const errTint = P.metrics ? clamp(P.metrics.errorRate / 10, 0, 0.7) : 0

      // -- zones from real addressing ----------------------------------------------
      {
        const priv: Body[] = []
        const ext: Body[] = []
        for (const b of bodies.values()) {
          if (b.pending) continue
          if (isPrivate(b.node.privateIp)) priv.push(b)
          else if (b.node.role === 'internet' || (b.node.publicIp && b.node.publicIp !== '—')) ext.push(b)
        }
        const zones: { bodies: Body[]; label: string; sub: string; strong: boolean }[] = []
        if (priv.length) {
          const regions = [...new Set(priv.map((b) => b.node.region).filter((r) => r && r !== '—'))]
          zones.push({ bodies: priv, label: `PRIVATE NETWORK  ${coveringCidr(priv.map((b) => b.node.privateIp))}`, sub: `${regions.join(' · ')}${regions.length ? ' · ' : ''}${priv.length} hosts`, strong: true })
        }
        for (const b of ext) {
          zones.push(
            b.node.role === 'internet'
              ? { bodies: [b], label: 'PUBLIC INTERNET', sub: '0.0.0.0/0', strong: false }
              : { bodies: [b], label: `${b.node.role.toUpperCase()}`, sub: `${b.node.publicIp}/32`, strong: false },
          )
        }
        for (const z of zones) {
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
          for (const b of z.bodies) {
            const e = extentOf(b)
            x0 = Math.min(x0, e.x0); x1 = Math.max(x1, e.x1); y0 = Math.min(y0, e.y0); y1 = Math.max(y1, e.y1)
          }
          const pad = 26
          const A = S(x0 - pad, y0 - pad - 8), B = S(x1 + pad, y1 + pad - 12)
          ctx.fillStyle = rgba(PAL.ink, z.strong ? 0.025 : 0.015)
          ctx.fillRect(A.x, A.y, B.x - A.x, B.y - A.y)
          ctx.strokeStyle = rgba(PAL.ink, z.strong ? 0.6 : 0.42)
          ctx.lineWidth = z.strong ? 1.3 : 1
          ctx.setLineDash([16, 4, 3, 4]) // phantom line
          ctx.strokeRect(Math.round(A.x) + 0.5, Math.round(A.y) + 0.5, Math.round(B.x - A.x), Math.round(B.y - A.y))
          ctx.setLineDash([])
          // label tab
          ctx.font = `600 10px ${SANS}`
          const tw = ctx.measureText(z.label).width
          ctx.font = `400 9.5px ${MONO}`
          const sw = ctx.measureText(z.sub).width
          const th = 17
          const totalW = tw + sw + 26
          ctx.fillStyle = PAL.ink
          ctx.fillRect(Math.round(A.x), Math.round(A.y) - th, Math.round(tw + 14), th)
          ctx.fillStyle = PAL.paper
          ctx.strokeStyle = PAL.ink
          ctx.fillRect(Math.round(A.x + tw + 14), Math.round(A.y) - th, Math.round(totalW - tw - 14), th)
          ctx.lineWidth = 1
          ctx.strokeRect(Math.round(A.x) + 0.5, Math.round(A.y) - th + 0.5, Math.round(totalW), th)
          ctx.textBaseline = 'middle'
          ctx.textAlign = 'left'
          ctx.font = `600 10px ${SANS}`
          ctx.fillStyle = PAL.paper
          ctx.fillText(z.label, A.x + 7, A.y - th / 2 + 0.5)
          ctx.font = `400 9.5px ${MONO}`
          ctx.fillStyle = PAL.inkSoft
          ctx.fillText(z.sub, A.x + tw + 21, A.y - th / 2 + 0.5)
        }
      }

      // -- check jobs per node ----------------------------------------------------
      for (const r of agentsR.values()) r.active = false
      for (const a of P.agents) {
        if (P.live && a.simulated) continue
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

      // -- link visibility + endpoint assignment -------------------------------------
      const nextVisible = new Set<LinkR>()
      for (const l of links.values()) {
        const s = 1 - Math.exp(-dt / 1.2)
        l.sF += (Math.max(0, l.data.bytesPerSec) - l.sF) * s
        l.sR += (Math.max(0, l.data.bytesPerSecReverse) - l.sR) * s
        if (!red) {
          l.phF += packetSpeed(l.sF) * dt
          l.phR += packetSpeed(l.sR) * dt
        }
        if (!l.present) continue
        const isSel = sel?.kind === 'link' && sel.id === l.id
        const ctlLink = isControl(l.data.protocol) && (l.a.node.role === 'controller' || l.b.node.role === 'controller')
        if (ctlLink && !P.showControl && !isSel) {
          const focusId = (id: string) => hover?.id === id || (sel?.kind === 'node' && sel.id === id) || jobsByNode.has(id)
          if (!focusId(l.a.id) && !focusId(l.b.id)) continue
        }
        nextVisible.add(l)
      }
      visibleLinks = nextVisible

      type End = { l: LinkR; b: Body; other: Body; outgoing: boolean; p: Pt; side: Side; fixed: boolean; file: string | null }
      const ends: End[] = []
      const buckets = new Map<string, End[]>()
      for (const l of visibleLinks) {
        for (const outgoing of [true, false]) {
          const b = outgoing ? l.a : l.b
          const other = outgoing ? l.b : l.a
          const x = b.x ?? 0, y = b.y ?? 0
          const rack = isOpen(b) ? rackOf(b) : null
          let end: End
          if (rack) {
            const dir = outgoing ? 'out' : 'in'
            const pe = rack.role.ports.find((q) => q.port === l.data.port && q.dir === dir) ?? rack.role.ports.find((q) => q.port === l.data.port)
            const row = pe ? rack.byPath.get(pe.file) : undefined
            const side: Side = (pe?.dir ?? dir) === 'in' ? 'L' : 'R'
            const yy = row ? y + (row.y0 + row.y1) / 2 : y - rack.RH / 2 + RACK_HEAD / 2
            end = { l, b, other, outgoing, p: { x: side === 'L' ? x - rack.RW / 2 : x + rack.RW / 2, y: yy }, side, fixed: true, file: row ? row.path : null }
          } else {
            const ox = other.x ?? 0, oy = other.y ?? 0
            const dx = ox - x, dy = oy - y
            const side: Side = Math.abs(dx) >= Math.abs(dy) * 0.55 ? (dx > 0 ? 'R' : 'L') : dy > 0 ? 'B' : 'T'
            end = { l, b, other, outgoing, p: { x, y }, side, fixed: false, file: null }
          }
          ends.push(end)
          const key = `${b.id}|${end.side}|${end.fixed ? `${end.p.y}` : ''}`
          const arr = buckets.get(key) ?? []
          arr.push(end)
          buckets.set(key, arr)
        }
      }
      const laneOff = new Map<End, number>()
      for (const arr of buckets.values()) {
        const horiz = arr[0].side === 'L' || arr[0].side === 'R'
        arr.sort((A, B) => (horiz ? (A.other.y ?? 0) - (B.other.y ?? 0) : (A.other.x ?? 0) - (B.other.x ?? 0)) || A.l.id.localeCompare(B.l.id))
        const n = arr.length
        const gap = horiz ? 10 : 12
        arr.forEach((e, i) => {
          const o = (i - (n - 1) / 2)
          laneOff.set(e, o * 15)
          if (e.fixed) {
            e.p = horiz ? { x: e.p.x, y: e.p.y + o * 5 } : { x: e.p.x + o * 5, y: e.p.y }
            return
          }
          const x = e.b.x ?? 0, y = e.b.y ?? 0
          if (e.side === 'L') e.p = { x: x - ICON_HW - 2, y: y + o * gap }
          else if (e.side === 'R') e.p = { x: x + ICON_HW + 2, y: y + o * gap }
          else if (e.side === 'T') e.p = { x: x + o * gap, y: y - ICON_HH - 2 }
          else e.p = { x: x + o * gap, y: y + ICON_HH + 46 } // below the label block
        })
      }
      const endOf = new Map<string, End>()
      for (const e of ends) endOf.set(`${e.l.id}|${e.outgoing ? 'a' : 'b'}`, e)
      for (const l of visibleLinks) {
        const A = endOf.get(`${l.id}|a`)!, B = endOf.get(`${l.id}|b`)!
        l.route = orthoRoute(A.p, A.side, B.p, B.side, (laneOff.get(A) ?? 0) + (laneOff.get(B) ?? 0) * 0.6)
      }

      // -- draw links (line + packet lanes) -------------------------------------------
      for (const l of visibleLinks) {
        const col = PROTO_COLOR[l.data.protocol] ?? PROTO_COLOR.other
        const control = isControl(l.data.protocol)
        const isSel = sel?.kind === 'link' && sel.id === l.id
        const isHov = hoverLink === l
        const da = Math.min(dimOf(l.a), dimOf(l.b))
        const pts = l.route.map((q) => S(q.x, q.y))
        if (isSel || isHov) {
          ctx.strokeStyle = rgba(PAL.sel, isSel ? 0.22 : 0.14)
          ctx.lineWidth = 7
          ctx.lineJoin = 'round'
          ctx.beginPath(); pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.stroke()
        }
        ctx.strokeStyle = rgba(col, (control ? 0.6 : 0.9) * da)
        ctx.lineWidth = control ? 1 : 1.5
        ctx.lineJoin = 'miter'
        ctx.setLineDash(control ? [5, 4] : [])
        ctx.beginPath(); pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.stroke()
        ctx.setLineDash([])
        // terminals: connection dots at both interfaces
        for (const q of [pts[0], pts[pts.length - 1]]) {
          ctx.fillStyle = PAL.paper
          ctx.strokeStyle = rgba(col, da)
          ctx.lineWidth = 1.2
          ctx.beginPath(); ctx.arc(q.x, q.y, 2.6, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
        }
        if (!control) {
          const http = l.data.protocol === 'http' || l.data.protocol === 'http-app'
          drawPackets(l.route, l.sF, l.phF, http && errTint > 0 ? mix(col, PAL.red, errTint) : col, true, da)
          drawPackets([...l.route].reverse(), l.sR, l.phR, col, false, da)
        }
      }

      // -- ghosts of removed servers --------------------------------------------------
      for (let i = ghostsRef.current.length - 1; i >= 0; i--) {
        const g = ghostsRef.current[i]
        g.t += dt / 0.8
        if (g.t >= 1) { ghostsRef.current.splice(i, 1); continue }
        const p = S(g.x, g.y)
        ctx.globalAlpha = 0.4 * (1 - g.t)
        drawIcon(iconFor(g.role), p.x, p.y, k * ICON_SCALE, PAL.face, PAL.side, PAL.ink, true)
        ctx.globalAlpha = 1
      }

      // -- devices --------------------------------------------------------------------
      const labelJobs: { b: Body; sx: number; sy: number; a: number; prio: number; box: { x0: number; y0: number; x1: number; y1: number } }[] = []
      const badgeJobs: { id: string; file?: string; x: number; y: number; level: Level; n: number; a: number }[] = []
      const iconBoxes: { id: string; x0: number; y0: number; x1: number; y1: number }[] = []
      const order = [...bodies.values()].sort((a, b) => a.ex - b.ex)
      const surge = P.metrics?.mode === 'surge'
      for (const b of order) {
        const n = b.node
        const p = S(b.x, b.y)
        const level = issueLevel(n)
        const nIssues = (n.issues ?? []).length
        const surgeTint = surge && (n.role === 'traffic' || n.role === 'internet')
        b.ta += ((level || surgeTint ? 1 : 0) - b.ta) * (1 - Math.exp(-dt * 6))
        const statusA = n.status === 'deleting' ? 0.25 : n.status === 'provisioning' || n.status === 'booting' ? 0.6 : 1
        b.alpha += (statusA - b.alpha) * (1 - Math.exp(-dt * 4))
        const dim = dimOf(b)
        const a = b.alpha * dim
        const rack = b.ex > 0.01 ? rackOf(b) : null
        const ix0 = p.x - ICON_HW * k, ix1 = p.x + ICON_HW * k, iy0 = p.y - ICON_HH * k, iy1 = p.y + ICON_HH * k
        if (ix1 < -400 || iy1 < -400 || ix0 > W + 400 || iy0 > H + 400) continue
        const isSel = sel?.kind === 'node' && sel.id === b.id
        const isHov = hover?.kind === 'node' && hover.id === b.id

        // ---- symbol
        const pale = level === 'amber' ? PAL.amberPale : PAL.redPale
        const strong = level === 'amber' ? PAL.amber : PAL.red
        const iconA = a * (1 - clamp(b.ex * 1.6, 0, 1))
        if (iconA > 0.01) {
          const t = b.ta * (level === 'red' ? 0.85 + 0.15 * pulse : 0.8)
          const face = t > 0.01 ? mix(PAL.face, pale, t) : PAL.face
          const side = t > 0.01 ? mix(PAL.side, mix(pale, strong, 0.35), t) : PAL.side
          const inkC = n.status === 'offline' ? PAL.red : PAL.ink
          ctx.globalAlpha = iconA
          drawIcon(iconFor(n.role), p.x, p.y, k * ICON_SCALE, face, side, inkC, n.status === 'provisioning' || n.status === 'booting' || b.pending)
          if (n.status === 'offline') {
            ctx.strokeStyle = PAL.red
            ctx.lineWidth = 1.6
            ctx.beginPath(); ctx.moveTo(ix0, iy0); ctx.lineTo(ix1, iy1); ctx.moveTo(ix1, iy0); ctx.lineTo(ix0, iy1); ctx.stroke()
          }
          ctx.globalAlpha = 1
        }
        iconBoxes.push({ id: b.id, x0: ix0, y0: iy0, x1: ix1, y1: iy1 })

        // ---- rack elevation (expanded)
        if (rack && b.ex > 0.01) {
          const e = clamp((b.ex - 0.15) / 0.85, 0, 1)
          const sc = k * (0.82 + 0.18 * e)
          const RW = rack.RW * sc, RH = rack.RH * sc
          const X0 = p.x - RW / 2, Y0 = p.y - RH / 2
          const R = (v: number) => Math.round(v) + 0.5
          ctx.globalAlpha = e
          // cabinet
          ctx.fillStyle = PAL.paper
          ctx.fillRect(X0, Y0, RW, RH)
          ctx.strokeStyle = PAL.ink
          ctx.lineWidth = 1.6
          ctx.strokeRect(R(X0), R(Y0), Math.round(RW), Math.round(RH))
          // rails with holes per U
          ctx.fillStyle = PAL.face
          ctx.fillRect(X0 + 1, Y0 + RACK_HEAD * sc, RAIL * sc, rack.totalU * RACK_U * sc)
          ctx.fillRect(X0 + RW - RAIL * sc - 1, Y0 + RACK_HEAD * sc, RAIL * sc, rack.totalU * RACK_U * sc)
          ctx.lineWidth = 1
          ctx.strokeStyle = PAL.ink
          ctx.beginPath()
          ctx.moveTo(R(X0 + RAIL * sc), Y0 + RACK_HEAD * sc); ctx.lineTo(R(X0 + RAIL * sc), Y0 + RH - RACK_FOOT * sc)
          ctx.moveTo(R(X0 + RW - RAIL * sc), Y0 + RACK_HEAD * sc); ctx.lineTo(R(X0 + RW - RAIL * sc), Y0 + RH - RACK_FOOT * sc)
          ctx.moveTo(X0, R(Y0 + RACK_HEAD * sc)); ctx.lineTo(X0 + RW, R(Y0 + RACK_HEAD * sc))
          ctx.moveTo(X0, R(Y0 + RH - RACK_FOOT * sc)); ctx.lineTo(X0 + RW, R(Y0 + RH - RACK_FOOT * sc))
          ctx.stroke()
          for (let u = 0; u < rack.totalU; u++) {
            const yy = Y0 + (RACK_HEAD + (u + 0.5) * RACK_U) * sc
            for (const xx of [X0 + (RAIL / 2) * sc, X0 + RW - (RAIL / 2) * sc]) {
              ctx.beginPath(); ctx.arc(xx, yy, 1.6 * sc, 0, Math.PI * 2); ctx.stroke()
            }
          }
          // header
          ctx.textAlign = 'left'
          ctx.textBaseline = 'alphabetic'
          ctx.fillStyle = PAL.ink
          ctx.font = `600 ${Math.max(10.5, 15 * sc)}px ${SANS}`
          ctx.fillText(`RACK ELEVATION · ${n.label}`, X0 + 10 * sc, Y0 + 20 * sc)
          ctx.font = `400 ${Math.max(8.5, 12 * sc)}px ${MONO}`
          ctx.fillStyle = PAL.inkSoft
          const totalLoc = rack.rows.reduce((s, r) => s + r.loc, 0)
          ctx.fillText(`${rack.role.root}/ · ${rack.rows.length} modules · ${totalLoc} LOC · ${rack.totalU}U`, X0 + 10 * sc, Y0 + 39 * sc)
          ctx.textAlign = 'right'
          ctx.fillText(addrOf(n), X0 + RW - 10 * sc, Y0 + 20 * sc)
          // modules
          const gutterW = (16 + rack.lanes * 11) * sc
          const bodyX0 = X0 + RAIL * sc + 2 * sc, bodyX1 = X0 + RW - RAIL * sc - 2 * sc
          const gx0 = bodyX1 - gutterW
          const rowY = (r: RackRow) => p.y + ((r.y0 + r.y1) / 2) * sc
          for (const r of rack.rows) {
            const y0 = p.y + r.y0 * sc + 1.5 * sc, y1 = p.y + r.y1 * sc - 1.5 * sc
            const fi = fileIssues(n, r.path)
            const fl = levelOf(fi)
            const isF = sel?.kind === 'node' && sel.id === b.id && sel.file === r.path
            const isH = hover?.kind === 'file' && hover.id === b.id && hover.file === r.path
            ctx.fillStyle = isF ? rgba(PAL.sel, 0.14) : isH ? rgba(PAL.ink, 0.07) : '#fbfaf5'
            ctx.fillRect(bodyX0, y0, gx0 - bodyX0, y1 - y0)
            ctx.strokeStyle = isF ? PAL.sel : PAL.ink
            ctx.lineWidth = isF ? 1.6 : 1
            ctx.strokeRect(R(bodyX0), R(y0), Math.round(gx0 - bodyX0), Math.round(y1 - y0))
            // status LED = file issues
            const ly = (y0 + y1) / 2
            ctx.beginPath(); ctx.arc(bodyX0 + 9 * sc, ly, 3.6 * sc, 0, Math.PI * 2)
            ctx.fillStyle = fl === 'red' ? PAL.red : fl === 'amber' ? PAL.amber : PAL.paper
            ctx.fill(); ctx.strokeStyle = fl === 'red' ? PAL.red : fl === 'amber' ? PAL.amber : PAL.ink; ctx.stroke()
            // U number, module label, ports, loc
            ctx.textBaseline = 'middle'
            ctx.textAlign = 'left'
            ctx.font = `400 ${Math.max(6.5, 10.5 * sc)}px ${MONO}`
            ctx.fillStyle = PAL.dim
            ctx.fillText(`U${r.uTop + 1}`, bodyX0 + 18 * sc, ly)
            ctx.font = `600 ${Math.max(10, 14 * sc)}px ${MONO}`
            ctx.fillStyle = PAL.ink
            const label = truncate(ctx, r.label, (gx0 - bodyX0) * 0.36)
            ctx.fillText(label, bodyX0 + 44 * sc, ly)
            const labelEnd = bodyX0 + 44 * sc + ctx.measureText(label).width
            ctx.textAlign = 'right'
            ctx.font = `400 ${Math.max(8.5, 11 * sc)}px ${MONO}`
            ctx.fillStyle = PAL.inkSoft
            ctx.fillText(`${r.loc} LOC`, gx0 - 8 * sc, ly)
            let tx = gx0 - 8 * sc - ctx.measureText(`${r.loc} LOC`).width - 10 * sc
            for (const pt of rack.role.ports.filter((q) => q.file === r.path)) {
              const tag = `${pt.dir === 'in' ? 'IN' : 'OUT'} :${pt.port}`
              const tw = ctx.measureText(tag).width + 8 * sc
              const th = 16 * sc
              ctx.strokeStyle = PAL.ink
              ctx.lineWidth = 1
              ctx.strokeRect(R(tx - tw), R(ly - th / 2), Math.round(tw), Math.round(th))
              ctx.fillStyle = PAL.ink
              ctx.fillText(tag, tx - 4 * sc, ly + 0.5)
              tx -= tw + 5 * sc
            }
            const tagStart = tx + 5 * sc
            if (e > 0.5) newHits.push({ kind: 'file', id: b.id, file: r.path, x0: bodyX0, y0, x1: gx0, y1 })
            if (fl && e > 0.5) badgeJobs.push({ id: b.id, file: r.path, x: Math.min(labelEnd + 16 * sc + 10, tagStart - 14), y: ly, level: fl, n: fi.length, a: e })
          }
          // patch cords = import edges (importer ● → ▸ imported)
          const hot = new Map<string, { col: string; it: number }>()
          for (const l of visibleLinks) {
            const outgoing = l.a === b
            if (!outgoing && l.b !== b) continue
            const pe = rack.role.ports.find((q) => q.port === l.data.port && q.dir === (outgoing ? 'out' : 'in'))
            if (!pe) continue
            const it = intensity(l.sF + l.sR)
            if (it <= 0.01) continue
            for (const [f, t] of rack.pathTo.get(pe.file) ?? []) {
              const key = `${f}>${t}`
              const prevHot = hot.get(key)
              if (!prevHot || prevHot.it < it) hot.set(key, { col: PROTO_COLOR[l.data.protocol] ?? PAL.ink, it })
            }
          }
          rack.role.edges.forEach((ed, i) => {
            const A = rack.byPath.get(ed.from), B = rack.byPath.get(ed.to)
            const lane = rack.lane.get(i)
            if (!A || !B || lane == null) return
            const ya = rowY(A) - 3 * sc, yb = rowY(B) + 3 * sc
            const lx = gx0 + (10 + lane * 11) * sc
            const h = hot.get(`${ed.from}>${ed.to}`)
            ctx.strokeStyle = h ? h.col : PAL.inkSoft
            ctx.lineWidth = h ? 1.4 + 1.4 * h.it : 1
            ctx.beginPath(); ctx.moveTo(gx0, ya); ctx.lineTo(lx, ya); ctx.lineTo(lx, yb); ctx.lineTo(gx0 + 2, yb); ctx.stroke()
            ctx.fillStyle = ctx.strokeStyle
            ctx.beginPath(); ctx.arc(gx0 + 1, ya, 2.4 * sc, 0, Math.PI * 2); ctx.fill()
            ctx.beginPath(); ctx.moveTo(gx0 + 1, yb); ctx.lineTo(gx0 + 7 * sc, yb - 3.2 * sc); ctx.lineTo(gx0 + 7 * sc, yb + 3.2 * sc); ctx.closePath(); ctx.fill()
          })
          ctx.globalAlpha = 1
          if (b.ex > 0.5) newHits.splice(newHits.length - rack.rows.length, 0, { kind: 'node', id: b.id, x0: X0, y0: Y0, x1: X0 + RW, y1: Y0 + RH })
          iconBoxes[iconBoxes.length - 1] = { id: b.id, x0: X0, y0: Y0, x1: X0 + RW, y1: Y0 + RH }
          if (isSel && e > 0.3) {
            ctx.strokeStyle = PAL.sel
            ctx.lineWidth = 1
            ctx.setLineDash([4, 3])
            ctx.strokeRect(R(X0 - 6), R(Y0 - 6), Math.round(RW + 12), Math.round(RH + 12))
            ctx.setLineDash([])
          }
          if (nIssues > 0 && level && e > 0.5) badgeJobs.push({ id: b.id, x: X0 + RW + 2, y: Y0 - 2, level, n: nIssues, a: dim })
        }

        const open = !!rack && b.ex > 0.5
        if (!open) newHits.push({ kind: 'node', id: b.id, x0: ix0, y0: iy0, x1: ix1, y1: iy1 + 30 * k })

        // ---- boot progress / status tags / check jobs (above the symbol)
        let topY = open && rack ? p.y - (rack.RH / 2) * k - 10 : iy0 - 8
        if (n.status === 'provisioning' || n.status === 'booting') {
          const t = (now - b.bootStart) / 1000
          const prog = n.status === 'provisioning' ? 0.4 * (1 - Math.exp(-t / 3)) : 0.4 + 0.55 * (1 - Math.exp(-t / 5))
          const bw = 56
          ctx.strokeStyle = PAL.ink
          ctx.lineWidth = 1
          ctx.strokeRect(Math.round(p.x - bw / 2) + 0.5, Math.round(topY - 4) + 0.5, bw, 4)
          ctx.fillStyle = PAL.ink
          ctx.fillRect(Math.round(p.x - bw / 2) + 1, Math.round(topY - 4) + 1, (bw - 1) * prog, 3)
          topY -= 8
        }
        const tag = n.status === 'provisioning' || n.status === 'booting' || n.status === 'deleting' || n.status === 'offline' ? n.status.toUpperCase() : ''
        if (tag) {
          ctx.font = `600 9.5px ${SANS}`
          ctx.fillStyle = n.status === 'offline' ? PAL.red : PAL.ink
          ctx.textAlign = 'center'
          ctx.textBaseline = 'bottom'
          ctx.fillText(tag, p.x, topY)
          topY -= 13
        }
        const jobs = jobsByNode.get(b.id) ?? []
        for (const r of jobs) {
          ctx.globalAlpha = r.alpha * dim
          ctx.font = `500 9.5px ${MONO}`
          const txt = `CHECK ${r.type.toUpperCase()} ${Math.round(r.progress * 100)}%`
          const tw = ctx.measureText(txt).width + 12
          const x0 = Math.round(p.x - tw / 2) + 0.5, y0 = Math.round(topY - 15) + 0.5
          ctx.fillStyle = PAL.paper
          ctx.fillRect(x0, y0, tw, 14)
          ctx.strokeStyle = PAL.sel
          ctx.lineWidth = 1
          ctx.strokeRect(x0, y0, tw, 14)
          ctx.fillStyle = rgba(PAL.sel, 0.18)
          ctx.fillRect(x0 + 0.5, y0 + 0.5, (tw - 1) * Math.max(0.04, r.progress), 13)
          ctx.fillStyle = PAL.sel
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(txt, p.x, y0 + 7.5)
          topY -= 18
          ctx.globalAlpha = 1
        }

        // ---- Visio-style selection handles / hover frame
        if ((isSel || isHov) && b.ex < 0.3) {
          const fx0 = ix0 - 8, fy0 = iy0 - 6, fx1 = ix1 + 8, fy1 = iy1 + 6
          ctx.strokeStyle = PAL.sel
          ctx.lineWidth = 1
          ctx.setLineDash([4, 3])
          ctx.strokeRect(Math.round(fx0) + 0.5, Math.round(fy0) + 0.5, Math.round(fx1 - fx0), Math.round(fy1 - fy0))
          ctx.setLineDash([])
          if (isSel) {
            const mx = (fx0 + fx1) / 2, my = (fy0 + fy1) / 2
            for (const [hx, hy] of [[fx0, fy0], [mx, fy0], [fx1, fy0], [fx0, my], [fx1, my], [fx0, fy1], [mx, fy1], [fx1, fy1]]) {
              ctx.fillStyle = PAL.paper
              ctx.fillRect(Math.round(hx) - 2.5, Math.round(hy) - 2.5, 5, 5)
              ctx.strokeRect(Math.round(hx) - 2.5 + 0.5, Math.round(hy) - 2.5 + 0.5, 5, 5)
            }
          }
        }

        if (!open) {
          labelJobs.push({ b, sx: p.x, sy: iy1, a, prio: (isSel || isHov ? 100 : 0) + (level ? 3 : 0) + (n.role === 'lb' || n.role === 'db' ? 2 : 0), box: { x0: ix0, y0: iy0, x1: ix1, y1: iy1 } })
          if (nIssues > 0 && level && b.ta > 0.05) badgeJobs.push({ id: b.id, x: ix1 + 4, y: iy0 - 2, level, n: nIssues, a: dim * (1 - b.ex) })
        }
      }

      // -- new-issue burst: expanding frame ----------------------------------------------
      for (let i = burstsRef.current.length - 1; i >= 0; i--) {
        const bu = burstsRef.current[i]
        bu.age += dt
        const b = bodies.get(bu.id)
        if (bu.age >= 0.9 || !b || red) { burstsRef.current.splice(i, 1); continue }
        const t = bu.age / 0.9
        const p = S(b.x, b.y)
        const g = 8 + t * 26
        ctx.globalAlpha = (1 - t) * 0.8
        ctx.strokeStyle = bu.color
        ctx.lineWidth = 1.5
        ctx.strokeRect(p.x - ICON_HW * k - g, p.y - ICON_HH * k - g, (ICON_HW * k + g) * 2, (ICON_HH * k + g) * 2)
        ctx.globalAlpha = 1
      }

      // -- device labels (hostname, address, cpu/mem) with collision pass --------------
      type Rect = { x0: number; y0: number; x1: number; y1: number }
      const placed: Rect[] = []
      const overlapsAny = (r: Rect, ownId: string | null) => {
        for (const q of placed) if (r.x0 < q.x1 && r.x1 > q.x0 && r.y0 < q.y1 && r.y1 > q.y0) return true
        for (const q of iconBoxes) if (q.id !== ownId && r.x0 < q.x1 && r.x1 > q.x0 && r.y0 < q.y1 && r.y1 > q.y0) return true
        return false
      }
      {
        const showGauge = k > 0.5
        for (const j of labelJobs.sort((a, b) => b.prio - a.prio)) {
          const n = j.b.node
          ctx.font = `600 11px ${MONO}`
          const label = truncate(ctx, n.label, 160)
          const lw = ctx.measureText(label).width
          ctx.font = `400 10px ${MONO}`
          const addr = addrOf(n) || n.role
          const iw = ctx.measureText(addr).width
          const w = Math.max(lw, iw, showGauge ? 72 : 0)
          const top = j.sy + 6
          const h = 13 + 12 + (showGauge && n.status === 'running' && n.memTotal ? 11 : 0)
          const rect = { x0: j.sx - w / 2 - 3, y0: top - 2, x1: j.sx + w / 2 + 3, y1: top + h + 2 }
          if (j.prio < 100 && overlapsAny(rect, j.b.id)) continue
          placed.push(rect)
          const a = Math.max(0.45, j.a)
          ctx.textAlign = 'center'
          ctx.textBaseline = 'top'
          ctx.fillStyle = rgba(PAL.paper, 0.85 * a)
          ctx.fillRect(rect.x0, rect.y0, rect.x1 - rect.x0, rect.y1 - rect.y0)
          ctx.font = `600 11px ${MONO}`
          ctx.fillStyle = rgba(PAL.ink, a)
          ctx.fillText(label, j.sx, top)
          ctx.font = `400 10px ${MONO}`
          ctx.fillStyle = rgba(PAL.inkSoft, a)
          ctx.fillText(addr, j.sx, top + 13)
          if (showGauge && n.status === 'running' && n.memTotal) {
            const gy = top + 28
            const vals: [string, number][] = [['C', n.cpu], ['M', n.memUsed / n.memTotal]]
            vals.forEach(([lab, v], i) => {
              const x = j.sx - 36 + i * 38
              ctx.font = `500 7.5px ${MONO}`
              ctx.textAlign = 'left'
              ctx.textBaseline = 'middle'
              ctx.fillStyle = rgba(PAL.inkSoft, a)
              ctx.fillText(lab, x, gy + 2.5)
              ctx.strokeStyle = rgba(PAL.ink, 0.6 * a)
              ctx.lineWidth = 1
              ctx.strokeRect(x + 7.5, gy + 0.5, 26, 4)
              ctx.fillStyle = v > 0.9 ? PAL.red : v > 0.75 ? PAL.amber : rgba(PAL.ink, 0.8 * a)
              ctx.fillRect(x + 8, gy + 1, 25 * clamp(v, 0, 1), 3)
            })
          }
        }
      }

      // -- interface / port labels at link ends ---------------------------------------
      {
        const jobs: { l: LinkR; at: Pt; next: Pt; text: string; prio: number }[] = []
        for (const l of visibleLinks) {
          if (l.route.length < 2) continue
          const isFocus = (sel?.kind === 'link' && sel.id === l.id) || hoverLink === l || (sel?.kind === 'node' && (sel.id === l.a.id || sel.id === l.b.id))
          const proto = PROTO_SHORT[l.data.protocol] ?? l.data.protocol
          const r = l.route
          const both = isPrivate(l.a.node.privateIp) && isPrivate(l.b.node.privateIp)
          const srcIp = both ? l.a.node.privateIp : l.a.node.publicIp
          const srcTxt = shortIp(srcIp) ? `eth0 ${shortIp(srcIp)} →` : ''
          jobs.push({ l, at: r[r.length - 1], next: r[r.length - 2], text: `:${l.data.port} ${proto}`, prio: isFocus ? 100 : 10 })
          if (srcTxt && (k > 0.7 || isFocus)) jobs.push({ l, at: r[0], next: r[1], text: srcTxt, prio: isFocus ? 90 : 1 })
        }
        ctx.font = `500 9px ${MONO}`
        for (const j of jobs.sort((a, b) => b.prio - a.prio)) {
          if (k < 0.45 && j.prio < 90) continue
          const A = S(j.at.x, j.at.y), B = S(j.next.x, j.next.y)
          const tw = ctx.measureText(j.text).width
          const horiz = Math.abs(B.x - A.x) > Math.abs(B.y - A.y)
          const cands: Pt[] = []
          if (horiz) {
            const dir = Math.sign(B.x - A.x) || 1
            const x = dir > 0 ? A.x + 6 : A.x - 6 - tw
            cands.push({ x, y: A.y - 12 }, { x, y: A.y + 3 })
          } else {
            const dir = Math.sign(B.y - A.y) || 1
            const y = dir > 0 ? A.y + 4 : A.y - 14
            cands.push({ x: A.x + 5, y }, { x: A.x - 5 - tw, y })
          }
          const blocked = (r: Rect) => {
            if (placed.some((q) => r.x0 < q.x1 && r.x1 > q.x0 && r.y0 < q.y1 && r.y1 > q.y0)) return true
            return iconBoxes.some((q) => r.x0 < q.x1 && r.x1 > q.x0 && r.y0 < q.y1 && r.y1 > q.y0)
          }
          const okc = cands.map((c) => ({ c, r: { x0: c.x - 2, y0: c.y - 1, x1: c.x + tw + 2, y1: c.y + 11 } })).find((q) => !blocked(q.r))
          if (!okc) continue
          const x0 = okc.c.x, y0 = okc.c.y
          const rect = okc.r
          placed.push(rect)
          const col = PROTO_COLOR[j.l.data.protocol] ?? PROTO_COLOR.other
          ctx.fillStyle = rgba(PAL.paper, 0.9)
          ctx.fillRect(rect.x0, rect.y0, rect.x1 - rect.x0, rect.y1 - rect.y0)
          ctx.fillStyle = j.prio >= 90 ? PAL.sel : col
          ctx.textAlign = 'left'
          ctx.textBaseline = 'top'
          ctx.fillText(j.text, x0, y0)
        }
      }

      // -- issue badges ("!" / "!n"), relaxed apart ---------------------------------------
      {
        for (let it = 0; it < 10; it++) {
          for (let i = 0; i < badgeJobs.length; i++) {
            for (let j = i + 1; j < badgeJobs.length; j++) {
              const A = badgeJobs[i], B = badgeJobs[j]
              let dx = B.x - A.x, dy = B.y - A.y
              let d = Math.hypot(dx, dy)
              const min = 24
              if (d >= min) continue
              if (d < 0.01) { dx = 1; dy = -0.4; d = 1 }
              const push = (min - d) / 2
              A.x -= (dx / d) * push; A.y -= (dy / d) * push
              B.x += (dx / d) * push; B.y += (dy / d) * push
            }
          }
        }
        for (const bj of badgeJobs) {
          const col = bj.level === 'amber' ? PAL.amber : PAL.red
          const text = bj.n > 1 ? `!${bj.n}` : '!'
          ctx.font = `700 10px ${MONO}`
          const w = Math.max(16, ctx.measureText(text).width + 8)
          ctx.globalAlpha = bj.a * (red || bj.level === 'amber' ? 1 : 0.82 + 0.18 * pulse)
          // tag shape: flag with a leader tick, like a drawing callout
          ctx.fillStyle = col
          ctx.fillRect(Math.round(bj.x - w / 2), Math.round(bj.y - 8), Math.round(w), 16)
          ctx.fillStyle = PAL.paper
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(text, bj.x, bj.y + 0.5)
          ctx.globalAlpha = 1
          newHits.push({ kind: 'badge', id: bj.id, file: bj.file, x0: bj.x - w / 2, y0: bj.y - 8, x1: bj.x + w / 2, y1: bj.y + 8 })
        }
      }

      hits = newHits
      if (hoverLink && !visibleLinks.has(hoverLink)) hoverLink = null
      if (hover) {
        const h = hover
        hover = hits.find((x) => x.kind === h.kind && x.id === h.id && x.file === h.file) ?? null
      }

      // -- tooltips -------------------------------------------------------------------
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
            for (const r of jobsByNode.get(n.id) ?? []) if (r.active) lines.push({ t: `check ${r.type} ${Math.round(r.progress * 100)}%  ${r.note}`, c: PAL.sel })
            const ni = (n.issues ?? []).length
            if (ni) lines.push({ t: `! ${ni} issue${ni > 1 ? 's' : ''} — select for detail`, c: issueLevel(n) === 'amber' ? PAL.amber : PAL.red })
            if (codeFor(P.codemap, n.role) && b.ex < 0.5) lines.push({ t: 'click to open rack elevation (files)', c: PAL.dim })
            drawTooltip(lines, hover, 'node')
          }
        } else if (hover?.kind === 'file') {
          const b = bodies.get(hover.id)
          const rack = b ? rackOf(b) : null
          const f = rack?.role.files.find((x) => x.path === hover!.file)
          if (b && rack && f) {
            const ports = rack.role.ports.filter((q) => q.file === f.path).map((q) => `${q.dir} :${q.port}`)
            const imports = rack.role.edges.filter((e) => e.from === f.path).length
            const lines: { t: string; c?: string }[] = [{ t: f.path }, { t: `${f.loc} loc  ·  imports ${imports}${ports.length ? '  ·  ' + ports.join(', ') : ''}` }]
            for (const i of fileIssues(b.node, f.path).slice(0, 2)) lines.push({ t: `! ${i.severity}  ${i.title}`, c: (SEV_RANK[i.severity] ?? 0) >= 3 ? PAL.red : PAL.amber })
            drawTooltip(lines, hover, 'node')
          }
        } else if (hover?.kind === 'badge') {
          const b = bodies.get(hover.id)
          const src = b ? (hover.file ? fileIssues(b.node, hover.file) : b.node.issues ?? []) : []
          const iss = src.slice().sort((x, y) => (SEV_RANK[y.severity] ?? 0) - (SEV_RANK[x.severity] ?? 0))
          if (b && iss.length) {
            const lines = [{ t: `${iss[0].severity.toUpperCase()}  ${iss[0].title}`, c: (SEV_RANK[iss[0].severity] ?? 0) >= 3 ? PAL.red : PAL.amber }]
            if (iss.length > 1) lines.push({ t: `+${iss.length - 1} more on ${b.node.label}`, c: PAL.dim })
            drawTooltip(lines, hover, 'node')
          }
        } else if (hoverLink) {
          const l = hoverLink
          drawTooltip([
            { t: `${l.data.protocol} :${l.data.port}  ·  ${l.data.conns} conns` },
            { t: `${l.a.node.label} → ${l.b.node.label}  ${fmtRate(l.sF)}` },
            { t: `${l.b.node.label} → ${l.a.node.label}  ${fmtRate(l.sR)}` },
          ], { x0: mouse.x, y0: mouse.y, x1: mouse.x, y1: mouse.y }, 'cursor')
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

  return <canvas ref={canvasRef} className="nd-canvas" />
}
