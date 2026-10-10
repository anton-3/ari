import { useEffect, useRef } from 'react'
import { forceLink, forceManyBody, forceSimulation, forceX, forceY } from 'd3-force'
import type { Simulation, SimulationLinkDatum, SimulationNodeDatum } from 'd3-force'
import { loadPos, savePos, takeAlias, takePlacement } from '../../graph/positions'
import { ACTIVE_AGENT, codeFor, fileIssues, fmtMem, fmtRate, isControl, issueLevel } from '../../graph/GraphView'
import type { Agent, Codemap, CodemapRole, Fleet, FleetIssue, FleetLink, FleetNode, Metrics } from '../../graph/types'

// ---------------------------------------------------------------------------
// The fleet as a printed circuit board (black FR-4, clear mask, ENIG pads,
// white silkscreen). Servers are IC packages with one pin per real port, links
// are copper differential pairs routed at 45/90 degrees between those pins, and
// traffic is current: pulses whose spacing/brightness come from real bytes/s.
// Every mark maps to fleet data; layout is d3-force, same as src/graph.
// ---------------------------------------------------------------------------

export type Sel = { kind: 'node'; id: string; file?: string } | { kind: 'link'; id: string }

export const P = {
  outside: '#050506',
  board: '#0f1110',
  silk: '#ece8dc',
  silkDim: '#8e8b82',
  copper: '#6b4f30', // copper seen through clear mask, unlit
  copperLit: '#e6ad62',
  gold: '#d9b56c', // ENIG pads / bond wires
  goldHi: '#f6dc9c',
  body: '#17181a',
  laser: '#8f9298',
  sel: '#ffe9b8',
  red: '#ff4b3e',
  amber: '#f2a93b',
  green: '#5fe08a',
  die: '#262b38',
}

// Current colour per net class (the copper is the same; the "current" differs).
export const NET_COLOR: Record<string, string> = {
  http: '#ffe2a0',
  'http-app': '#ffe2a0',
  postgres: '#a6d6ff',
  redis: '#d2c0ff',
  ssh: '#9a9890',
  control: '#9a9890',
  other: '#9a9890',
}

interface PartStyle {
  glyph: string
  prefix: string
  w: number
  h: number
  weight: number
  tx: number
  ty: number
  conn?: boolean
}
export const PART: Record<string, PartStyle> = {
  internet: { glyph: 'RJ45', prefix: 'J', w: 70, h: 84, weight: 3, tx: -630, ty: 0, conn: true },
  traffic: { glyph: 'TRF', prefix: 'U', w: 96, h: 66, weight: 3, tx: -440, ty: 0 },
  lb: { glyph: 'LB', prefix: 'U', w: 124, h: 88, weight: 5, tx: -220, ty: 0 },
  app: { glyph: 'APP', prefix: 'U', w: 108, h: 78, weight: 3, tx: 50, ty: 0 },
  worker: { glyph: 'WRK', prefix: 'U', w: 96, h: 66, weight: 2, tx: 90, ty: 220 },
  cache: { glyph: 'RDS', prefix: 'U', w: 112, h: 78, weight: 4, tx: 350, ty: -130 },
  db: { glyph: 'PG', prefix: 'U', w: 128, h: 92, weight: 5, tx: 370, ty: 140 },
  controller: { glyph: 'CTL', prefix: 'U', w: 108, h: 72, weight: 4, tx: -70, ty: -230 },
}
export const partOf = (r: string): PartStyle =>
  PART[r] ?? { glyph: r.slice(0, 3).toUpperCase(), prefix: 'U', w: 96, h: 66, weight: 2, tx: 0, ty: 0 }

const ANCHOR_ROLE: Record<string, string> = { app: 'lb', worker: 'db', cache: 'app', db: 'app', lb: 'traffic', traffic: 'internet' }
const SEV_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 }
const MONO = '"IBM Plex Mono", "JetBrains Mono", ui-monospace, Menlo, monospace'
const LINK_GRACE_MS = 30000
const TOP_PAD = 104
const BOTTOM_PAD = 186
const LEFT_PAD = 206
const RIGHT_PAD = 40
const PITCH = 16 // pin pitch (world)
const LEAD = 10 // lead length beyond body (world)
const STUB = 14 // straight fan-out before the first bend
const LABEL_BELOW = 48 // world space reserved under a package for its silkscreen

type Level = 'red' | 'amber'

interface Body extends SimulationNodeDatum {
  id: string
  node: FleetNode
  des: string
  pending: boolean
  ta: number
  alpha: number
  ex: number
  open: boolean
  bootStart: number
  bootPhase: string
  lastIssueCount: number
  labelW: number
  pinsIn: number[]
  pinsOut: number[]
  w: number // current (eased) package size, world
  h: number
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
}

interface Block {
  x: number
  y: number
  w: number
  h: number
}
interface DieLayout {
  role: CodemapRole
  entry: string
  Dw: number
  Dh: number
  blocks: Map<string, Block>
  pathTo: Map<string, [string, string][]>
}

interface AgentR {
  id: string
  type: string
  label: string
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
  w: number
  h: number
  t: number
}

type Pt = { x: number; y: number }
type Hit = { kind: 'node' | 'badge' | 'file'; id: string; file?: string; x0: number; y0: number; x1: number; y1: number }
interface Geo {
  full: Pt[] // screen path used by current pulses (die block → … → die block)
  board: Pt[] // screen path of the copper on the board (pin tip → pin tip)
  control: boolean
}

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

// ---- die layout: files as blocks, in-port owners left, out-port owners right
const BW = 108
const COL_GAP = 36
const ROW_GAP = 24
const DIE_MX = 30 // package margin around the die (x)
const DIE_MY = 30
const layoutCache = new Map<string, DieLayout>()
function dieFor(role: string, cr: CodemapRole): DieLayout {
  const key = `${role}|${cr.files.map((f) => f.path).join(',')}|${cr.edges.length}|${cr.ports.length}`
  const hit = layoutCache.get(key)
  if (hit) return hit
  const inF = new Set(cr.ports.filter((p) => p.dir === 'in').map((p) => p.file))
  const outF = new Set(cr.ports.filter((p) => p.dir !== 'in').map((p) => p.file))
  const byLoc = cr.files.slice().sort((a, b) => b.loc - a.loc)
  const entry = cr.ports.find((p) => p.dir === 'in')?.file ?? byLoc[0].path
  const colIn = byLoc.filter((f) => inF.has(f.path))
  const colOut = byLoc.filter((f) => outF.has(f.path) && !inF.has(f.path))
  const mid = byLoc.filter((f) => !inF.has(f.path) && !outF.has(f.path))
  const mids = mid.length > 5 ? [mid.slice(0, Math.ceil(mid.length / 2)), mid.slice(Math.ceil(mid.length / 2))] : [mid]
  const cols = [colIn, ...mids, colOut].filter((c) => c.length > 0)
  const bh = (loc: number) => Math.round(30 + clamp(Math.sqrt(loc), 0, 26) * 0.5)
  const colH = cols.map((c) => c.reduce((s, f) => s + bh(f.loc), 0) + ROW_GAP * (c.length - 1))
  const Dw = cols.length * BW + (cols.length - 1) * COL_GAP
  const Dh = Math.max(...colH)
  const blocks = new Map<string, Block>()
  cols.forEach((c, ci) => {
    const x = -Dw / 2 + ci * (BW + COL_GAP)
    let y = -colH[ci] / 2
    for (const f of c) {
      const h = bh(f.loc)
      blocks.set(f.path, { x, y, w: BW, h })
      y += h + ROW_GAP
    }
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
  const lay = { role: cr, entry, Dw, Dh, blocks, pathTo }
  layoutCache.set(key, lay)
  return lay
}

// package size, collapsed and fully decapped
function dims0(b: Body) {
  const st = partOf(b.node.role)
  const n = Math.max(b.pinsIn.length, b.pinsOut.length)
  return { w: st.w, h: Math.max(st.h, n * PITCH + 24) }
}
function dims1(b: Body, lay: DieLayout | null) {
  const d0 = dims0(b)
  if (!lay) return d0
  const n = Math.max(b.pinsIn.length, b.pinsOut.length)
  return { w: Math.max(d0.w, lay.Dw + 2 * DIE_MX), h: Math.max(d0.h, lay.Dh + 2 * DIE_MY, n * PITCH + 24) }
}

// ---- geometry helpers ------------------------------------------------------
// Octilinear route from a pin heading east (P) to a pin entered heading east (Q).
// `bias` places the 45° run: 0 = right after the source fan-out, 1 = just before
// the destination (so several traces into one pin arrive as parallel diagonals).
function route(Pp: Pt, Q: Pt, stubA: number, stubB: number, bias: number): Pt[] {
  const s1 = { x: Pp.x + stubA, y: Pp.y }
  const s2 = { x: Q.x - stubB, y: Q.y }
  const dx = s2.x - s1.x
  const dy = s2.y - s1.y
  const ady = Math.abs(dy)
  const sg = Math.sign(dy) || 1
  if (dx >= ady) {
    const h = (dx - ady) * bias
    return [Pp, s1, { x: s1.x + h, y: s1.y }, { x: s1.x + h + ady, y: s2.y }, s2, Q]
  }
  if (dx > 0) {
    const d1 = dx * (1 - bias)
    return [Pp, s1, { x: s1.x + d1, y: s1.y + sg * d1 }, { x: s1.x + d1, y: s2.y - sg * (dx - d1) }, s2, Q]
  }
  // backward: out east, along a channel between the two pins, back in from the west
  const midY = Math.abs(dy) > 60 ? (s1.y + s2.y) / 2 : Math.min(s1.y, s2.y) - 70
  const c = Math.min(10, Math.abs(midY - s1.y) / 2, Math.abs(midY - s2.y) / 2, Math.abs(dx) / 2 + 4)
  const v1 = Math.sign(midY - s1.y) || 1
  const v2 = Math.sign(s2.y - midY) || 1
  return [
    Pp, s1,
    { x: s1.x + c, y: s1.y + v1 * c }, { x: s1.x + c, y: midY - v1 * c }, { x: s1.x, y: midY },
    { x: s2.x, y: midY }, { x: s2.x - c, y: midY + v2 * c }, { x: s2.x - c, y: s2.y - v2 * c },
    s2, Q,
  ]
}

function dedupe(pts: Pt[]): Pt[] {
  const out: Pt[] = []
  for (const p of pts) {
    const l = out[out.length - 1]
    if (!l || Math.hypot(p.x - l.x, p.y - l.y) > 0.01) out.push(p)
  }
  return out
}

// parallel offset with mitred joins (differential pair lanes)
function offsetPath(pts: Pt[], d: number): Pt[] {
  if (pts.length < 2) return pts
  const n = pts.length
  const out: Pt[] = []
  const nrm = (a: Pt, b: Pt) => {
    const dx = b.x - a.x, dy = b.y - a.y
    const l = Math.hypot(dx, dy) || 1
    return { x: -dy / l, y: dx / l }
  }
  for (let i = 0; i < n; i++) {
    if (i === 0) { const m = nrm(pts[0], pts[1]); out.push({ x: pts[0].x + m.x * d, y: pts[0].y + m.y * d }); continue }
    if (i === n - 1) { const m = nrm(pts[n - 2], pts[n - 1]); out.push({ x: pts[i].x + m.x * d, y: pts[i].y + m.y * d }); continue }
    const m1 = nrm(pts[i - 1], pts[i]), m2 = nrm(pts[i], pts[i + 1])
    let mx = m1.x + m2.x, my = m1.y + m2.y
    const ml = Math.hypot(mx, my)
    if (ml < 1e-3) { out.push({ x: pts[i].x + m1.x * d, y: pts[i].y + m1.y * d }); continue }
    mx /= ml; my /= ml
    const cos = mx * m1.x + my * m1.y
    const s = d / Math.max(0.35, cos)
    out.push({ x: pts[i].x + mx * s, y: pts[i].y + my * s })
  }
  return out
}

function pathLen(pts: Pt[]): number {
  let L = 0
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  return L
}

function quad(a: Pt, b: Pt, bend: number, steps = 10): Pt[] {
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
  const dx = b.x - a.x, dy = b.y - a.y
  const cx = mx - dy * bend, cy = my + dx * bend
  const out: Pt[] = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const u = 1 - t
    out.push({ x: u * u * a.x + 2 * u * t * cx + t * t * b.x, y: u * u * a.y + 2 * u * t * cy + t * t * b.y })
  }
  return out
}

// point where the segment from a rect's centre towards `to` leaves the rect
function rectExit(r: { x: number; y: number; w: number; h: number }, to: Pt): Pt {
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2
  const dx = to.x - cx, dy = to.y - cy
  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return { x: cx, y: cy }
  const sx = Math.abs(dx) > 1e-6 ? r.w / 2 / Math.abs(dx) : Infinity
  const sy = Math.abs(dy) > 1e-6 ? r.h / 2 / Math.abs(dy) : Infinity
  const s = Math.min(sx, sy)
  return { x: cx + dx * s, y: cy + dy * s }
}

// log scale tuned for this fleet's real rates: ~300 B/s ≈ 0.2, ~12 KB/s ≈ 0.57, ≥1 MB/s = 1
const intensity = (bps: number) => clamp(Math.log10(1 + bps / 64) / 4.2, 0, 1)
const pulseSpeed = (bps: number) => (bps < 1 ? 0 : 16 + 52 * intensity(bps))

// ---------------------------------------------------------------------------
export default function PcbView(props: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const propsRef = useRef<Props>(props)
  propsRef.current = props

  const bodiesRef = useRef(new Map<string, Body>())
  const linksRef = useRef(new Map<string, LinkR>())
  const ghostsRef = useRef<Ghost[]>([])
  const burstsRef = useRef<{ id: string; age: number; color: string }[]>([])
  const desRef = useRef({ map: new Map<string, string>(), next: new Map<string, number>() })
  const simRef = useRef<Simulation<Body, LinkR> | null>(null)

  const layoutOfNode = (n: FleetNode): DieLayout | null => {
    const cr = codeFor(propsRef.current.codemap, n.role)
    return cr ? dieFor(n.role, cr) : null
  }
  // rectangular collision (packages are rectangles, not circles): parts keep a
  // routing channel around their pins and room for their silkscreen.
  const boxOf = (d: Body) => {
    const target = d.open ? dims1(d, layoutOfNode(d.node)) : dims0(d)
    const w = Math.max(d.w, target.w), h = Math.max(d.h, target.h)
    const hw = Math.max(w / 2 + LEAD + STUB + 18, d.labelW / 2 + 10)
    return { hw, top: h / 2 + 34, bot: h / 2 + LABEL_BELOW + 6 }
  }
  const rectCollide = useRef((() => {
    let nodes: Body[] = []
    const f = (alpha: number) => {
      const s = alpha > 0.5 ? 0.9 : 1 // full correction once the layout cools
      for (let it = 0; it < 2; it++) {
        for (let i = 0; i < nodes.length; i++) {
          for (let j = i + 1; j < nodes.length; j++) {
            const A = nodes[i], B = nodes[j]
            const ba = boxOf(A), bb = boxOf(B)
            const ax = (A.x ?? 0) + (A.vx ?? 0), ay = (A.y ?? 0) + (A.vy ?? 0)
            const bx = (B.x ?? 0) + (B.vx ?? 0), by = (B.y ?? 0) + (B.vy ?? 0)
            const ox = Math.min(ax + ba.hw, bx + bb.hw) - Math.max(ax - ba.hw, bx - bb.hw)
            const oy = Math.min(ay + ba.bot, by + bb.bot) - Math.max(ay - ba.top, by - bb.top)
            if (ox <= 0 || oy <= 0) continue
            const aFix = A.fx != null, bFix = B.fx != null
            if (aFix && bFix) continue
            const wa = aFix ? 0 : bFix ? 1 : 0.5
            const wb = 1 - wa
            if (ox < oy) {
              const d = ox * s * (ax < bx || (ax === bx && i < j) ? 1 : -1)
              A.vx = (A.vx ?? 0) - d * wa
              B.vx = (B.vx ?? 0) + d * wb
            } else {
              const d = oy * s * (ay < by || (ay === by && i < j) ? 1 : -1)
              A.vy = (A.vy ?? 0) - d * wa
              B.vy = (B.vy ?? 0) + d * wb
            }
          }
        }
      }
    }
    f.initialize = (ns: Body[]) => { nodes = ns }
    return f
  })())

  if (!simRef.current) {
    simRef.current = forceSimulation<Body, LinkR>([])
      .force('link', forceLink<Body, LinkR>([]).id((d) => d.id).distance(230).strength(0.2))
      .force('charge', forceManyBody<Body>().strength(-1200).distanceMax(1100))
      .force('collide', rectCollide.current)
      .force('x', forceX<Body>((d) => partOf(d.node.role).tx).strength(0.08))
      .force('y', forceY<Body>((d) => partOf(d.node.role).ty).strength((d) => (d.node.role === 'controller' ? 0.22 : 0.07)))
      .stop()
  }

  // ---- sync fleet → scene --------------------------------------------------
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
        bodies.clear()
        links.clear()
        sim.nodes([])
        linkForce.links([])
      }
      return
    }

    const measure = (n: FleetNode) => Math.max(n.label.length, n.privateIp.length, 11) * 6.4

    const place = (n: FleetNode): { x: number; y: number; pin: boolean } => {
      const drop = takePlacement(n.id)
      if (drop) return { ...drop, pin: true }
      const saved = n.id.startsWith('pending-') ? null : loadPos(n.label)
      if (saved) return { ...saved, pin: true }
      const jitter = () => (Math.random() - 0.5) * 60
      for (const l of fleet.links) {
        const other = l.source === n.id ? l.target : l.target === n.id ? l.source : null
        const ob = other ? bodies.get(other) : undefined
        if (ob) return { x: (ob.x ?? 0) + 200 * Math.sign(partOf(n.role).tx - partOf(ob.node.role).tx || 1) + jitter(), y: (ob.y ?? 0) + jitter(), pin: false }
      }
      const ar = ANCHOR_ROLE[n.role]
      for (const b of bodies.values()) if (b.node.role === ar) return { x: (b.x ?? 0) + 200 + jitter(), y: (b.y ?? 0) + jitter(), pin: false }
      const st = partOf(n.role)
      return { x: st.tx + jitter(), y: st.ty + jitter(), pin: false }
    }

    // reference designators: stable per node id, assigned in board order
    const des = desRef.current
    const designate = (n: FleetNode) => {
      const have = des.map.get(n.id)
      if (have) return have
      const pre = partOf(n.role).prefix
      const k = (des.next.get(pre) ?? 1)
      des.next.set(pre, k + 1)
      const d = `${pre}${k}`
      des.map.set(n.id, d)
      return d
    }
    const ordered = fleet.nodes.slice().sort((a, b) => partOf(a.role).tx - partOf(b.role).tx || partOf(a.role).ty - partOf(b.role).ty || a.label.localeCompare(b.label))

    // ports per node: listening ports → west pins; ports it dials → east pins
    const pinsIn = new Map<string, Set<number>>()
    const pinsOut = new Map<string, Set<number>>()
    const addTo = (m: Map<string, Set<number>>, id: string, p: number) => {
      if (!(p > 0)) return
      if (!m.has(id)) m.set(id, new Set())
      m.get(id)!.add(p)
    }
    for (const n of fleet.nodes) for (const pr of n.processes) for (const p of pr.ports) addTo(pinsIn, n.id, p)
    for (const l of fleet.links) { addTo(pinsIn, l.target, l.port); addTo(pinsOut, l.source, l.port) }

    const seen = new Set<string>()
    for (const n of ordered) {
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
          des.map.set(n.id, old.des)
          structural = true
        }
      }
      if (!b) {
        const p = place(n)
        const st = partOf(n.role)
        b = {
          id: n.id, node: n, des: designate(n), pending: n.id.startsWith('pending-'), ta: 0, alpha: 0, ex: 0, open: false,
          bootStart: performance.now(), bootPhase: n.status, lastIssueCount: (n.issues ?? []).length,
          labelW: measure(n), pinsIn: [], pinsOut: [], w: st.w, h: st.h,
          x: p.x, y: p.y, fx: p.pin ? p.x : null, fy: p.pin ? p.y : null,
        }
        bodies.set(n.id, b)
        structural = true
      }
      if (b.bootPhase !== n.status) {
        b.bootPhase = n.status
        b.bootStart = performance.now()
      }
      const ic = (n.issues ?? []).length
      if (ic > b.lastIssueCount) burstsRef.current.push({ id: n.id, age: 0, color: issueLevel(n) === 'amber' ? P.amber : P.red })
      b.lastIssueCount = ic
      if (b.node.label !== n.label) b.labelW = measure(n)
      b.node = n
      b.pending = n.id.startsWith('pending-')
      const pi = [...(pinsIn.get(n.id) ?? [])].sort((x, y) => x - y)
      const po = [...(pinsOut.get(n.id) ?? [])].sort((x, y) => x - y)
      if (pi.join() !== b.pinsIn.join() || po.join() !== b.pinsOut.join()) {
        b.pinsIn = pi
        b.pinsOut = po
        relink = true
      }
      seen.add(n.id)
    }
    for (const [id, b] of bodies) {
      if (seen.has(id)) continue
      ghostsRef.current.push({ x: b.x ?? 0, y: b.y ?? 0, w: b.w, h: b.h, t: 0 })
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
        lr = { id: l.id, a, b, source: a, target: b, data: l, sF: 0, sR: 0, phF: 0, phR: 0, dead: false, present: true, goneAt: 0 }
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
      const endsGone = !bodies.has(l.a.id) || !bodies.has(l.b.id) || bodies.get(l.a.id) !== l.a || bodies.get(l.b.id) !== l.b
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
      sim.alpha(Math.max(sim.alpha(), structural ? 0.45 : 0.08))
      if (propsRef.current.reduced) sim.tick(240)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.fleet])

  // ---- canvas loop + interaction -------------------------------------------
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
    let panTo: { x: number; y: number } | null = null
    let expandedId: string | null = null
    const board = { x0: -400, y0: -300, x1: 400, y1: 300, init: false }

    const pointers = new Map<number, Pt>()
    let press: { x: number; y: number; hit: Hit | null; moved: boolean; lastX: number; lastY: number } | null = null
    let pinch: { dist: number; k: number } | null = null
    let dragBody: Body | null = null
    let mouse: Pt | null = null
    let hover: Hit | null = null
    let hoverLink: LinkR | null = null
    let hits: Hit[] = []
    let geos = new Map<LinkR, Geo>()
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
    const toWorld = (sx: number, sy: number) => ({ x: (sx - view.tx) / view.k, y: (sy - view.ty) / view.k })
    const zoomAround = (sx: number, sy: number, nk: number) => {
      const k = clamp(nk, 0.25, 4)
      view.tx = sx - ((sx - view.tx) * k) / view.k
      view.ty = sy - ((sy - view.ty) * k) / view.k
      view.k = k
    }
    const layoutOf = (b: Body): DieLayout | null => layoutOfNode(b.node)

    const extentOf = (b: Body) => {
      const d = b.ex > 0.01 ? { w: b.w, h: b.h } : dims0(b)
      return { hw: Math.max(d.w / 2 + LEAD + STUB, b.labelW / 2) + 8, top: d.h / 2 + 26, bot: d.h / 2 + LABEL_BELOW }
    }
    const worldBounds = () => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      for (const b of bodiesRef.current.values()) {
        const e = extentOf(b)
        x0 = Math.min(x0, (b.x ?? 0) - e.hw); x1 = Math.max(x1, (b.x ?? 0) + e.hw)
        y0 = Math.min(y0, (b.y ?? 0) - e.top); y1 = Math.max(y1, (b.y ?? 0) + e.bot)
      }
      return { x0, y0, x1, y1 }
    }
    const fitTarget = () => {
      if (bodiesRef.current.size === 0) return null
      const { x0, y0, x1, y1 } = worldBounds()
      const aw = Math.max(200, W - LEFT_PAD - Math.max(RIGHT_PAD, propsRef.current.rightInset))
      const ah = Math.max(160, H - TOP_PAD - BOTTOM_PAD)
      const pad = 16
      const k = clamp(Math.min(aw / (x1 - x0 + pad * 2), ah / (y1 - y0 + pad * 2)), 0.3, 1.5)
      return { k, tx: LEFT_PAD + aw / 2 - ((x0 + x1) / 2) * k, ty: TOP_PAD + ah / 2 - ((y0 + y1) / 2) * k }
    }

    // pin tip (world) for a port on a side
    const pinY = (n: number, i: number) => (i - (n - 1) / 2) * PITCH
    const pinTip = (b: Body, port: number, out: boolean): Pt | null => {
      const arr = out ? b.pinsOut : b.pinsIn
      const i = arr.indexOf(port)
      if (i < 0) return null
      return { x: (b.x ?? 0) + (out ? 1 : -1) * (b.w / 2 + LEAD), y: (b.y ?? 0) + pinY(arr.length, i) }
    }
    const pinInner = (b: Body, port: number, out: boolean): Pt | null => {
      const t = pinTip(b, port, out)
      return t ? { x: t.x - (out ? 1 : -1) * LEAD, y: t.y } : null
    }
    // die block that owns a port while decapped (world rect)
    const ownerBlock = (b: Body, port: number, out: boolean) => {
      if (b.ex < 0.35) return null
      const lay = layoutOf(b)
      if (!lay) return null
      const dir = out ? 'out' : 'in'
      const pe = lay.role.ports.find((p) => p.port === port && p.dir === dir) ?? lay.role.ports.find((p) => p.port === port)
      const bl = pe ? lay.blocks.get(pe.file) : undefined
      if (!pe || !bl) return null
      const e = b.ex
      return { file: pe.file, x: (b.x ?? 0) + bl.x * e, y: (b.y ?? 0) + bl.y * e, w: bl.w * e, h: bl.h * e }
    }

    // traces sharing a pin fan out with staggered stubs (farthest partner = shortest stub)
    let fan = new Map<LinkR, { sa: number; sb: number; bias: number }>()
    const computeFan = (ls: LinkR[]) => {
      const groups = new Map<string, { l: LinkR; d: number }[]>()
      const push = (key: string, l: LinkR, d: number) => {
        const g = groups.get(key) ?? []
        g.push({ l, d })
        groups.set(key, g)
      }
      for (const l of ls) {
        const dy = Math.abs((l.a.y ?? 0) - (l.b.y ?? 0))
        push(`o|${l.a.id}|${l.data.port}`, l, dy)
        push(`i|${l.b.id}|${l.data.port}`, l, dy)
      }
      const next = new Map<LinkR, { sa: number; sb: number; bias: number }>()
      for (const l of ls) next.set(l, { sa: STUB, sb: STUB, bias: 0.5 })
      for (const [key, g] of groups) {
        if (g.length < 2) continue
        g.sort((x, y) => y.d - x.d)
        g.forEach((e, i) => {
          const f = next.get(e.l)!
          if (key.startsWith('o')) f.sa = STUB + i * 12
          else f.sb = STUB + i * 12
        })
      }
      for (const l of ls) {
        const f = next.get(l)!
        const outShared = f.sa !== STUB || (groups.get(`o|${l.a.id}|${l.data.port}`)?.length ?? 0) > 1
        const inShared = f.sb !== STUB || (groups.get(`i|${l.b.id}|${l.data.port}`)?.length ?? 0) > 1
        f.bias = inShared && !outShared ? 1 : outShared && !inShared ? 0 : 0.5
      }
      fan = next
    }

    const buildGeo = (l: LinkR): Geo | null => {
      const control = isControl(l.data.protocol)
      const A = pinTip(l.a, l.data.port, true)
      const B = pinTip(l.b, l.data.port, false)
      if (!A || !B) return null
      const sc = (p: Pt) => S(p.x, p.y)
      if (control) {
        const s = [sc(A), sc(B)]
        return { full: s, board: s, control }
      }
      const fo = fan.get(l) ?? { sa: STUB, sb: STUB, bias: 0.5 }
      const boardW = dedupe(route(A, B, fo.sa, fo.sb, fo.bias))
      const full: Pt[] = []
      const oa = ownerBlock(l.a, l.data.port, true)
      if (oa) {
        const inner = pinInner(l.a, l.data.port, true)!
        const st = { x: oa.x + oa.w, y: oa.y + oa.h / 2 }
        full.push(...quad(st, inner, 0.12))
      }
      full.push(...boardW)
      const ob = ownerBlock(l.b, l.data.port, false)
      if (ob) {
        const inner = pinInner(l.b, l.data.port, false)!
        full.push(...quad(inner, { x: ob.x, y: ob.y + ob.h / 2 }, 0.12))
      }
      return { full: dedupe(full).map(sc), board: boardW.map(sc), control }
    }

    const segDist = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
      const dx = bx - ax, dy = by - ay
      const L = dx * dx + dy * dy || 1
      const t = clamp(((px - ax) * dx + (py - ay) * dy) / L, 0, 1)
      return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
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
      let bd = 7
      for (const [l, g] of geos) {
        const pts = g.full
        for (let i = 1; i < pts.length; i++) {
          const d = segDist(x, y, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y)
          if (d < bd) { bd = d; best = l }
        }
      }
      return best
    }

    // ---- input ----------------------------------------------------------------
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
          if (dragBody) { sim.alphaTarget(0.12); if (sim.alpha() < 0.12) sim.alpha(0.12) }
        }
        canvas.style.cursor = 'grabbing'
      }
      if (!press.moved) return
      if (dragBody) {
        const w0 = toWorld(press.lastX, press.lastY)
        const w1 = toWorld(p.x, p.y)
        const nx = (dragBody.fx ?? dragBody.x ?? 0) + (w1.x - w0.x)
        const ny = (dragBody.fy ?? dragBody.y ?? 0) + (w1.y - w0.y)
        dragBody.fx = nx; dragBody.fy = ny; dragBody.x = nx; dragBody.y = ny
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
      propsRef.current.onDropRole(role, w.x, w.y)
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

    // ---- drawing helpers ---------------------------------------------------------
    const rrect = (x: number, y: number, w: number, h: number, r: number) => {
      const rr = Math.min(r, w / 2, h / 2)
      ctx.beginPath()
      ctx.moveTo(x + rr, y)
      ctx.arcTo(x + w, y, x + w, y + h, rr)
      ctx.arcTo(x + w, y + h, x, y + h, rr)
      ctx.arcTo(x, y + h, x, y, rr)
      ctx.arcTo(x, y, x + w, y, rr)
      ctx.closePath()
    }
    const strokePath = (pts: Pt[]) => {
      if (pts.length < 2) return
      ctx.beginPath()
      ctx.moveTo(pts[0].x, pts[0].y)
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
      ctx.stroke()
    }
    const font = (weight: number, px: number) => `${weight} ${px}px ${MONO}`

    // current pulses along a lane: spacing + brightness from smoothed bytes/s
    const pulses = (pts: Pt[], bps: number, col: string, phase: number, alpha: number, k: number) => {
      if (bps < 1 || pts.length < 2) return
      const it = intensity(bps)
      const L = pathLen(pts)
      const gap = (74 - 46 * it) * clamp(k, 0.6, 1.4)
      const r = clamp((1.4 + 1.6 * it) * k, 1.2, 3.6)
      let s = ((phase % gap) + gap) % gap
      let seg = 1
      let acc = 0
      ctx.globalCompositeOperation = 'lighter'
      while (s < L && seg < pts.length) {
        let sl = Math.hypot(pts[seg].x - pts[seg - 1].x, pts[seg].y - pts[seg - 1].y)
        while (seg < pts.length && acc + sl < s) {
          acc += sl
          seg++
          if (seg < pts.length) sl = Math.hypot(pts[seg].x - pts[seg - 1].x, pts[seg].y - pts[seg - 1].y)
        }
        if (seg >= pts.length) break
        const t = sl > 0 ? (s - acc) / sl : 0
        const x = pts[seg - 1].x + (pts[seg].x - pts[seg - 1].x) * t
        const y = pts[seg - 1].y + (pts[seg].y - pts[seg - 1].y) * t
        ctx.fillStyle = rgba(col, (0.16 + 0.2 * it) * alpha)
        ctx.beginPath(); ctx.arc(x, y, r * 2.3, 0, Math.PI * 2); ctx.fill()
        ctx.fillStyle = rgba(col, (0.55 + 0.45 * it) * alpha)
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill()
        s += gap
      }
      ctx.globalCompositeOperation = 'source-over'
    }

    const drawTooltip = (lines: { t: string; c?: string }[], anchor: { x: number; y: number; r: number }, side: 'node' | 'cursor') => {
      ctx.font = font(400, 11)
      const maxW = Math.min(360, W - 24)
      const shown = lines.map((l) => ({ t: truncate(ctx, l.t, maxW - 18), c: l.c }))
      const w = Math.min(maxW, Math.max(...shown.map((l) => ctx.measureText(l.t).width)) + 18)
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
      y = clamp(y, 48, H - 8 - h)
      ctx.fillStyle = 'rgba(10,11,11,0.96)'
      ctx.fillRect(x, y, w, h)
      ctx.strokeStyle = rgba(P.gold, 0.45)
      ctx.lineWidth = 1
      ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h))
      ctx.fillStyle = P.gold
      ctx.fillRect(Math.round(x), Math.round(y), 2, Math.round(h) + 1)
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      shown.forEach((l, i) => {
        ctx.fillStyle = l.c ?? (i === 0 ? P.silk : P.silkDim)
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
      const sel = Pp.selected

      const want = sel?.kind === 'node' && bodies.has(sel.id) && codeFor(Pp.codemap, bodies.get(sel.id)!.node.role) ? sel.id : null
      if (want !== expandedId) {
        expandedId = want
        for (const b of bodies.values()) b.open = b.id === want
          sim.alpha(Math.max(sim.alpha(), 0.3))
        if (red) sim.tick(120)
      }
      let dimAll = 0
      for (const b of bodies.values()) {
        b.ex += ((b.open ? 1 : 0) - b.ex) * (red ? 1 : 1 - Math.exp(-dt * 7))
        if (b.ex < 0.001) b.ex = 0
        if (b.ex > 0.999) b.ex = 1
        dimAll = Math.max(dimAll, b.ex)
        const d0 = dims0(b)
        const d1 = b.ex > 0 ? dims1(b, layoutOf(b)) : d0
        b.w = d0.w + (d1.w - d0.w) * b.ex
        b.h = d0.h + (d1.h - d0.h) * b.ex
      }

      if (sim.alpha() > sim.alphaMin()) sim.tick(clamp(Math.round(dt / 0.016), 1, 12))

      if (Pp.focus && Pp.focus.n !== focusN) {
        focusN = Pp.focus.n
        const b = bodies.get(Pp.focus.id)
        if (b) { autoFit = false; panTo = { x: b.x ?? 0, y: b.y ?? 0 } }
      }
      if (panTo) {
        const cx = LEFT_PAD + (W - LEFT_PAD - Math.max(RIGHT_PAD, Pp.rightInset)) / 2
        const cy = TOP_PAD + (H - TOP_PAD - BOTTOM_PAD) / 2
        const t = red ? 1 : 1 - Math.exp(-dt * 6)
        const tx = cx - panTo.x * view.k
        const ty = cy - panTo.y * view.k
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

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.globalAlpha = 1
      ctx.globalCompositeOperation = 'source-over'
      ctx.fillStyle = P.outside
      ctx.fillRect(0, 0, W, H)

      // -- board outline (Edge.Cuts) around the placed parts --------------------
      if (bodies.size) {
        const wb = worldBounds()
        const pad = 46
        const tgt = { x0: wb.x0 - pad, y0: wb.y0 - pad, x1: wb.x1 + pad, y1: wb.y1 + pad + 18 }
        const t = !board.init || red ? 1 : 1 - Math.exp(-dt * 5)
        board.x0 += (tgt.x0 - board.x0) * t; board.y0 += (tgt.y0 - board.y0) * t
        board.x1 += (tgt.x1 - board.x1) * t; board.y1 += (tgt.y1 - board.y1) * t
        board.init = true
        const a = S(board.x0, board.y0), b = S(board.x1, board.y1)
        const g = ctx.createRadialGradient((a.x + b.x) / 2, (a.y + b.y) / 2, 10, (a.x + b.x) / 2, (a.y + b.y) / 2, Math.max(b.x - a.x, b.y - a.y) * 0.75)
        g.addColorStop(0, '#141715')
        g.addColorStop(1, P.board)
        ctx.fillStyle = g
        rrect(a.x, a.y, b.x - a.x, b.y - a.y, 16 * k)
        ctx.fill()
        ctx.strokeStyle = 'rgba(200,172,112,0.28)'
        ctx.lineWidth = 1
        ctx.stroke()
        // title block (silkscreen, real counts)
        const fs = 9 * k
        if (fs >= 5.5 && Pp.fleet) {
          const nets = Pp.fleet.links.filter((l) => !isControl(l.protocol)).length
          ctx.font = font(500, fs)
          ctx.fillStyle = rgba(P.silk, 0.62)
          ctx.textAlign = 'left'
          ctx.textBaseline = 'bottom'
          ctx.fillText(`ARI-NET FLEET  ·  ${Pp.fleet.nodes.length} PARTS  ·  ${nets} NETS  ·  REV ${Pp.live ? 'LIVE' : 'SIM'}`, a.x + 36 * k, b.y - 12 * k)
        }
      }

      // -- layout-editor dot grid (world anchored) -------------------------------
      {
        let step = 20
        while (step * k < 9) step *= 5
        const s = step * k
        const ox = ((view.tx % s) + s) % s
        const oy = ((view.ty % s) + s) % s
        ctx.fillStyle = 'rgba(225,222,210,0.075)'
        const sz = Math.max(1, Math.min(1.5, k))
        for (let x = ox; x < W; x += s) for (let y = oy; y < H; y += s) ctx.fillRect(x - sz / 2, y - sz / 2, sz, sz)
        const S5 = s * 5
        const mx = ((view.tx % S5) + S5) % S5, my = ((view.ty % S5) + S5) % S5
        ctx.strokeStyle = 'rgba(225,222,210,0.09)'
        ctx.lineWidth = 1
        ctx.beginPath()
        for (let x = mx; x < W; x += S5) for (let y = my; y < H; y += S5) {
          ctx.moveTo(x - 3, y); ctx.lineTo(x + 3, y); ctx.moveTo(x, y - 3); ctx.lineTo(x, y + 3)
        }
        ctx.stroke()
      }

      const newHits: Hit[] = []
      const dimOf = (b: Body) => 1 - 0.55 * Math.max(0, dimAll - b.ex)
      const errTint = Pp.metrics ? clamp(Pp.metrics.errorRate / 10, 0, 0.75) : 0

      // -- agents → per-node check jobs ---------------------------------------
      for (const r of agentsR.values()) r.active = false
      for (const a of Pp.agents) {
        if (Pp.live && a.simulated) continue
        if (!bodies.has(a.targetNodeId)) continue
        let r = agentsR.get(a.id)
        if (!r) {
          if (!ACTIVE_AGENT.has(a.status)) continue
          r = { id: a.id, type: a.type, label: a.label, note: a.note ?? '', status: a.status, progress: a.progress, target: a.targetNodeId, alpha: 0, active: true }
          agentsR.set(a.id, r)
        }
        r.type = a.type; r.label = a.label; r.note = a.note ?? ''; r.status = a.status
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

      // -- traces: copper differential pairs + current pulses -------------------
      const nextGeo = new Map<LinkR, Geo>()
      const traceW = clamp(2.4 * k, 1.6, 4.5)
      const gapW = clamp(1.9 * k, 1.1, 3.6)
      const laneJobs: { l: LinkR; g: Geo; da: number; col: string; http: boolean }[] = []
      computeFan([...links.values()].filter((l) => l.present && !isControl(l.data.protocol)))
      for (const l of links.values()) {
        const s = 1 - Math.exp(-dt / 1.2)
        l.sF += (Math.max(0, l.data.bytesPerSec) - l.sF) * s
        l.sR += (Math.max(0, l.data.bytesPerSecReverse) - l.sR) * s
        if (!red) {
          l.phF += pulseSpeed(l.sF) * dt
          l.phR += pulseSpeed(l.sR) * dt
        }
        if (!l.present) continue
        const control = isControl(l.data.protocol)
        const isSel = sel?.kind === 'link' && sel.id === l.id
        const ctlLink = control && (l.a.node.role === 'controller' || l.b.node.role === 'controller')
        if (ctlLink && !Pp.showControl && !isSel) {
          const focusId = (id: string) => hover?.id === id || (sel?.kind === 'node' && sel.id === id) || jobsByNode.has(id)
          if (!focusId(l.a.id) && !focusId(l.b.id)) continue
        }
        const g = buildGeo(l)
        if (!g) continue
        nextGeo.set(l, g)
        const da = Math.min(dimOf(l.a), dimOf(l.b))
        const isHov = hoverLink === l
        if (control) {
          // ratsnest air-wire: unrouted, no copper, no current
          ctx.strokeStyle = rgba('#d8d4c8', (0.22 + (isSel || isHov ? 0.45 : 0)) * da)
          ctx.lineWidth = isSel || isHov ? 1.4 : 0.9
          ctx.setLineDash([4, 4])
          strokePath(g.board)
          ctx.setLineDash([])
          continue
        }
        const http = l.data.protocol === 'http' || l.data.protocol === 'http-app'
        laneJobs.push({ l, g, da, col: NET_COLOR[l.data.protocol] ?? NET_COLOR.other, http })
      }
      geos = nextGeo
      // copper first (all pairs), then vias, then current on top
      const laneCache = new Map<LinkR, { bF: Pt[]; bR: Pt[]; fF: Pt[]; fR: Pt[] }>()
      for (const j of laneJobs) {
        const off = (traceW + gapW) / 2
        const bF = offsetPath(j.g.board, -off)
        const bR = offsetPath(j.g.board, off)
        const fF = offsetPath(j.g.full, -off)
        const fR = offsetPath(j.g.full, off).reverse()
        laneCache.set(j.l, { bF, bR, fF, fR })
        const isSel = sel?.kind === 'link' && sel.id === j.l.id
        const isHov = hoverLink === j.l
        ctx.lineJoin = 'round'
        ctx.lineCap = 'round'
        if (isSel || isHov) {
          ctx.strokeStyle = rgba(P.sel, isSel ? 0.35 : 0.2)
          ctx.lineWidth = traceW * 2 + gapW + 6
          strokePath(j.g.board)
        }
        const lanes: [Pt[], number, boolean][] = [[bF, j.l.sF, j.http], [bR, j.l.sR, false]]
        for (const [pts, bps, warm] of lanes) {
          const it = intensity(bps)
          let c = mix(P.copper, P.copperLit, 0.1 + 0.75 * it)
          if (warm && errTint > 0) c = mix(c, P.red, errTint)
          ctx.strokeStyle = rgba(c, (0.85 + 0.15 * it) * j.da)
          ctx.lineWidth = traceW
          strokePath(pts)
          if (it > 0.02) {
            // faint lit sheen on carrying copper
            ctx.strokeStyle = rgba(mix(c, '#fff3d6', 0.5), 0.18 * it * j.da)
            ctx.lineWidth = Math.max(0.6, traceW * 0.35)
            strokePath(pts)
          }
        }
        ctx.lineCap = 'butt'
        ctx.lineJoin = 'miter'
      }
      for (const j of laneJobs) {
        const lc = laneCache.get(j.l)!
        // forward current; the http lane is tinted toward red by the real error rate
        const fc = j.http && errTint > 0 ? mix(j.col, P.red, errTint) : j.col
        pulses(lc.fF, j.l.sF, fc, j.l.phF, j.da, k)
        pulses(lc.fR, j.l.sR, j.col, j.l.phR, j.da * 0.85, k)
      }

      // -- ghosts of removed parts --------------------------------------------
      for (let i = ghostsRef.current.length - 1; i >= 0; i--) {
        const gh = ghostsRef.current[i]
        gh.t += dt / 0.8
        if (gh.t >= 1) { ghostsRef.current.splice(i, 1); continue }
        const p = S(gh.x, gh.y)
        ctx.globalAlpha = 0.4 * (1 - gh.t)
        ctx.strokeStyle = P.silk
        ctx.setLineDash([3, 3])
        ctx.strokeRect(p.x - (gh.w / 2) * k, p.y - (gh.h / 2) * k, gh.w * k, gh.h * k)
        ctx.setLineDash([])
        ctx.globalAlpha = 1
      }

      // -- parts -------------------------------------------------------------
      const surge = Pp.metrics?.mode === 'surge'
      const order = [...bodies.values()].sort((a, b) => a.ex - b.ex)
      const labelJobs: { b: Body; sx: number; sy: number; hh: number; hw: number; a: number; prio: number }[] = []
      const badgeJobs: { id: string; file?: string; x: number; y: number; level: Level; n: number; a: number; fs: number }[] = []
      for (const b of order) {
        const n = b.node
        const st = partOf(n.role)
        const p = S(b.x, b.y)
        const level = issueLevel(n)
        const nIssues = (n.issues ?? []).length
        const surgeTint = surge && (n.role === 'traffic' || n.role === 'internet')
        b.ta += ((level || surgeTint ? 1 : 0) - b.ta) * (1 - Math.exp(-dt * 6))
        const statusA = n.status === 'deleting' ? 0.22 : n.status === 'provisioning' || n.status === 'booting' ? 0.55 : n.status === 'offline' ? 0.75 : 1
        b.alpha += (statusA - b.alpha) * (1 - Math.exp(-dt * 4))
        const dim = dimOf(b)
        const a = b.alpha * dim
        const w = b.w * k, h = b.h * k
        const x0 = p.x - w / 2, y0 = p.y - h / 2
        if (p.x + w < -300 || p.y + h < -300 || p.x - w > W + 300 || p.y - h > H + 300) continue
        const lay = b.ex > 0 ? layoutOf(b) : null
        const booting = n.status === 'provisioning' || n.status === 'booting'
        const tcol = level === 'amber' ? P.amber : P.red

        // pads (ENIG) + leads for every pin
        const lead = LEAD * k
        const padH = clamp(7 * k, 2, 12)
        const drawPins = (arr: number[], out: boolean) => {
          arr.forEach((port, i) => {
            const py = p.y + pinY(arr.length, i) * k
            const ex = out ? p.x + w / 2 : p.x - w / 2
            const tip = out ? ex + lead : ex - lead
            const padX = out ? ex + lead * 0.25 : tip - lead * 0.15
            const padW = lead * 0.9
            ctx.globalAlpha = a
            const gg = ctx.createLinearGradient(0, py - padH / 2, 0, py + padH / 2)
            gg.addColorStop(0, P.goldHi)
            gg.addColorStop(1, mix(P.gold, '#000000', 0.25))
            ctx.fillStyle = gg
            ctx.fillRect(padX, py - padH / 2, padW, padH)
            if (!booting) {
              // gull-wing lead (tinned)
              ctx.fillStyle = '#b9bcbf'
              const lw = clamp(3 * k, 1, 6)
              ctx.fillRect(Math.min(ex, ex + (out ? 1 : -1) * lead * 0.85), py - lw / 2, lead * 0.85, lw)
            }
            ctx.globalAlpha = 1
            void port
          })
        }
        drawPins(b.pinsIn, false)
        drawPins(b.pinsOut, true)

        // body
        if (booting) {
          // unpopulated footprint: courtyard + placement progress
          const t = (now - b.bootStart) / 1000
          const prog = n.status === 'provisioning' ? 0.4 * (1 - Math.exp(-t / 3)) : 0.4 + 0.55 * (1 - Math.exp(-t / 5))
          ctx.strokeStyle = rgba(P.silk, 0.7 * dim)
          ctx.lineWidth = 1
          ctx.setLineDash([4, 3])
          ctx.strokeRect(x0, y0, w, h)
          ctx.setLineDash([])
          ctx.fillStyle = rgba(P.body, 0.85 * prog * dim)
          ctx.fillRect(x0, y0 + h * (1 - prog), w, h * prog)
        } else {
          ctx.globalAlpha = a
          const bg = ctx.createLinearGradient(0, y0, 0, y0 + h)
          if (st.conn) {
            bg.addColorStop(0, '#c9ccd0'); bg.addColorStop(0.5, '#8f9397'); bg.addColorStop(1, '#5d6064')
          } else {
            bg.addColorStop(0, '#26272a'); bg.addColorStop(0.12, P.body); bg.addColorStop(1, '#0d0d0e')
          }
          ctx.fillStyle = bg
          rrect(x0, y0, w, h, 3 * k)
          ctx.fill()
          ctx.strokeStyle = st.conn ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.08)'
          ctx.lineWidth = 1
          ctx.stroke()
          if (st.conn) {
            // RJ45 jack opening
            const ow = w * 0.56, oh = h * 0.42
            ctx.fillStyle = '#16171a'
            ctx.fillRect(p.x - ow / 2, p.y - oh / 2, ow, oh)
            ctx.fillStyle = rgba(P.gold, 0.8)
            for (let i = 0; i < 8; i++) ctx.fillRect(p.x - ow / 2 + ow * (0.1 + i * 0.105), p.y - oh / 2 + 2 * k, ow * 0.05, oh * 0.35)
          }
          ctx.globalAlpha = 1
        }

        // decap: die cavity, blocks, bond wires
        if (lay && b.ex > 0.01) {
          const e = b.ex
          const fa = clamp((e - 0.35) / 0.65, 0, 1)
          const cw = (lay.Dw + 2 * DIE_MX * 0.55) * e * k, ch = (lay.Dh + 2 * DIE_MY * 0.55) * e * k
          ctx.globalAlpha = fa
          const dg = ctx.createLinearGradient(p.x - cw / 2, p.y - ch / 2, p.x + cw / 2, p.y + ch / 2)
          dg.addColorStop(0, '#2f3445'); dg.addColorStop(0.45, '#1f2330'); dg.addColorStop(0.7, '#2a2a3c'); dg.addColorStop(1, '#1b1e28')
          ctx.fillStyle = dg
          ctx.fillRect(p.x - cw / 2, p.y - ch / 2, cw, ch)
          ctx.strokeStyle = 'rgba(170,180,210,0.35)'
          ctx.lineWidth = 1
          ctx.strokeRect(p.x - cw / 2 + 0.5, p.y - ch / 2 + 0.5, cw - 1, ch - 1)
          const bpos = (path: string) => {
            const bl = lay.blocks.get(path)
            return bl ? { x: p.x + bl.x * e * k, y: p.y + bl.y * e * k, w: bl.w * e * k, h: bl.h * e * k } : null
          }
          // bond wires: imports (file → file)
          const bondW = clamp(0.9 * k, 0.6, 1.6)
          const hot = new Map<string, { it: number; col: string }>()
          for (const l of links.values()) {
            const outgoing = l.a === b
            if (!l.present || (!outgoing && l.b !== b)) continue
            const pe = lay.role.ports.find((q) => q.port === l.data.port && q.dir === (outgoing ? 'out' : 'in'))
            if (!pe) continue
            const it = intensity(l.sF + l.sR)
            if (it <= 0.01) continue
            for (const [f, t] of lay.pathTo.get(pe.file) ?? []) {
              const key = `${f}>${t}`
              const prev = hot.get(key)
              if (!prev || prev.it < it) hot.set(key, { it, col: NET_COLOR[l.data.protocol] ?? P.gold })
            }
          }
          for (const ed of lay.role.edges) {
            const A = bpos(ed.from), B = bpos(ed.to)
            if (!A || !B) continue
            const ca = { x: A.x + A.w / 2, y: A.y + A.h / 2 }, cb = { x: B.x + B.w / 2, y: B.y + B.h / 2 }
            const pa = rectExit(A, cb), pb = rectExit(B, ca)
            const pts = quad(pa, pb, 0.18, 14)
            const hh = hot.get(`${ed.from}>${ed.to}`)
            ctx.strokeStyle = hh ? rgba(mix(P.gold, hh.col, 0.5), 0.6 + 0.4 * hh.it) : rgba(P.gold, 0.55)
            ctx.lineWidth = hh ? bondW * (1.3 + hh.it) : bondW
            strokePath(pts)
            ctx.fillStyle = P.goldHi
            for (const q of [pa, pb]) { ctx.beginPath(); ctx.arc(q.x, q.y, bondW * 1.6, 0, Math.PI * 2); ctx.fill() }
          }
          // bond wires: package leads → the die block that owns that port
          const portBond = (arr: number[], out: boolean) => {
            arr.forEach((port, i) => {
              const pe = lay.role.ports.find((q) => q.port === port && q.dir === (out ? 'out' : 'in'))
              const B = pe ? bpos(pe.file) : null
              if (!B) return
              const inner = { x: out ? p.x + w / 2 - 3 * k : p.x - w / 2 + 3 * k, y: p.y + pinY(arr.length, i) * k }
              const land = out ? { x: B.x + B.w, y: B.y + B.h / 2 } : { x: B.x, y: B.y + B.h / 2 }
              const pts = quad(inner, land, 0.12, 12)
              let it = 0
              for (const l of links.values()) {
                if (!l.present || l.data.port !== port) continue
                if ((out && l.a === b) || (!out && l.b === b)) it = Math.max(it, intensity(l.sF + l.sR))
              }
              ctx.strokeStyle = rgba(mix(P.gold, P.goldHi, it), 0.75 + 0.25 * it)
              ctx.lineWidth = bondW * (1.4 + it)
              strokePath(pts)
              ctx.fillStyle = P.goldHi
              ctx.beginPath(); ctx.arc(land.x, land.y, bondW * 1.8, 0, Math.PI * 2); ctx.fill()
              ctx.fillRect(inner.x - bondW * 1.5, inner.y - bondW * 1.5, bondW * 3, bondW * 3)
            })
          }
          portBond(b.pinsIn, false)
          portBond(b.pinsOut, true)
          // die blocks
          for (const f of lay.role.files) {
            const B = bpos(f.path)
            if (!B) continue
            const fi = fileIssues(n, f.path)
            const fl = levelOf(fi)
            const isF = sel?.kind === 'node' && sel.id === b.id && sel.file === f.path
            const isH = hover?.kind === 'file' && hover.id === b.id && hover.file === f.path
            const bgc = ctx.createLinearGradient(B.x, B.y, B.x + B.w, B.y + B.h)
            bgc.addColorStop(0, '#3b4358'); bgc.addColorStop(1, '#2a3042')
            ctx.fillStyle = bgc
            ctx.fillRect(B.x, B.y, B.w, B.h)
            // metal-layer hatching
            ctx.save()
            ctx.beginPath(); ctx.rect(B.x, B.y, B.w, B.h); ctx.clip()
            ctx.strokeStyle = 'rgba(190,200,230,0.06)'
            ctx.lineWidth = 1
            ctx.beginPath()
            for (let xx = B.x - B.h; xx < B.x + B.w; xx += 5 * k) { ctx.moveTo(xx, B.y + B.h); ctx.lineTo(xx + B.h, B.y) }
            ctx.stroke()
            ctx.restore()
            ctx.strokeStyle = fl ? (fl === 'red' ? P.red : P.amber) : isF ? P.sel : isH ? rgba(P.sel, 0.7) : 'rgba(170,182,214,0.55)'
            ctx.lineWidth = isF || fl ? 1.5 : 1
            ctx.strokeRect(B.x + 0.5, B.y + 0.5, B.w - 1, B.h - 1)
            const fs = Math.max(9.5 * k, 8.5)
            if (fs >= 5 && fa > 0.3) {
              ctx.font = font(500, fs)
              ctx.fillStyle = rgba('#e7ebf5', fa)
              ctx.textAlign = 'left'
              ctx.textBaseline = 'top'
              ctx.fillText(truncate(ctx, f.label, B.w - 10 * k), B.x + 5 * k, B.y + 4 * k)
              ctx.font = font(400, fs * 0.82)
              ctx.fillStyle = rgba('#9aa3bd', fa)
              const ports = lay.role.ports.filter((q) => q.file === f.path).map((q) => `${q.dir}:${q.port}`).join(' ')
              ctx.fillText(`${f.loc} loc${ports ? '  ' + ports : ''}`, B.x + 5 * k, B.y + 4 * k + fs * 1.2)
            }
            if (e > 0.5) newHits.push({ kind: 'file', id: b.id, file: f.path, x0: B.x, y0: B.y, x1: B.x + B.w, y1: B.y + B.h })
            if (fl && e > 0.5) badgeJobs.push({ id: b.id, file: f.path, x: B.x + B.w, y: B.y - 10, level: fl, n: fi.length, a: fa, fs: 9 })
          }
          ctx.globalAlpha = 1
        }

        if (!booting && b.ex < 0.6) {
          const la = a * (1 - b.ex / 0.6)
          // pin-1 dot
          if (!st.conn) {
            ctx.fillStyle = rgba('#3a3b3f', la)
            ctx.beginPath(); ctx.arc(x0 + 8 * k, y0 + 8 * k, 2.6 * k, 0, Math.PI * 2); ctx.fill()
          }
          // laser marking: role + main process
          const fs = 11 * k
          if (fs >= 5 && !st.conn) {
            ctx.textAlign = 'center'
            ctx.textBaseline = 'middle'
            ctx.font = font(600, fs)
            ctx.fillStyle = rgba(P.laser, la)
            const proc = n.processes.find((q) => q.ports.length && q.name !== 'sshd' && q.name !== 'systemd' && q.name !== 'systemd-resolve')?.name
              ?? n.processes.find((q) => q.name !== 'sshd' && q.name !== 'systemd' && q.name !== 'systemd-resolve')?.name ?? ''
            ctx.fillText(st.glyph, p.x, p.y - (proc ? 5 * k : 0))
            if (proc) {
              ctx.font = font(400, fs * 0.66)
              ctx.fillStyle = rgba(P.laser, 0.75 * la)
              ctx.fillText(truncate(ctx, proc, w - 44 * k), p.x, p.y + 8 * k)
            }
          }
          // pin numbers (laser-marked next to each lead)
          const ps = 7.2 * k
          if (ps >= 4.5) {
            ctx.font = font(500, ps)
            ctx.textBaseline = 'middle'
            ctx.fillStyle = st.conn ? rgba('#1b1c1f', la) : rgba('#b6b8bd', 0.85 * la)
            b.pinsIn.forEach((port, i) => {
              ctx.textAlign = 'left'
              ctx.fillText(String(port), x0 + 4 * k, p.y + pinY(b.pinsIn.length, i) * k)
            })
            b.pinsOut.forEach((port, i) => {
              ctx.textAlign = 'right'
              ctx.fillText(String(port), x0 + w - 4 * k, p.y + pinY(b.pinsOut.length, i) * k)
            })
          }
        }

        // status LEDs on the package: PWR (running) + FLT (issues)
        if (!booting && !st.conn) {
          const lw = 7 * k, lh = 3.6 * k
          const ly = y0 + 5 * k
          const leds: [number, string | null][] = [
            [x0 + w - 22 * k, n.status === 'running' ? P.green : null],
            [x0 + w - 11 * k, level && b.ta > 0.05 ? tcol : null],
          ]
          for (const [lx, on] of leds) {
            ctx.globalAlpha = a
            ctx.fillStyle = '#c9c4b5'
            ctx.fillRect(lx - 0.6 * k, ly, 0.9 * k + 0.4, lh)
            ctx.fillRect(lx + lw - 0.3 * k, ly, 0.9 * k + 0.4, lh)
            ctx.fillStyle = on ? on : '#2a1d1b'
            ctx.fillRect(lx + 0.6 * k, ly, lw - 1.2 * k, lh)
            if (on) {
              const glow = on === P.green ? 0.35 : 0.55 * pulse
              ctx.globalCompositeOperation = 'lighter'
              const gr = ctx.createRadialGradient(lx + lw / 2, ly + lh / 2, 0, lx + lw / 2, ly + lh / 2, 9 * k)
              gr.addColorStop(0, rgba(on, glow * a))
              gr.addColorStop(1, rgba(on, 0))
              ctx.fillStyle = gr
              ctx.beginPath(); ctx.arc(lx + lw / 2, ly + lh / 2, 9 * k, 0, Math.PI * 2); ctx.fill()
              ctx.globalCompositeOperation = 'source-over'
            }
          }
          ctx.globalAlpha = 1
        }

        // silkscreen package outline (just outside the body) + selection
        const isSel = sel?.kind === 'node' && sel.id === b.id
        const isHov = hover?.kind === 'node' && hover.id === b.id
        {
          const m = 4 * k
          ctx.strokeStyle = rgba(P.silk, 0.5 * a)
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.moveTo(x0 - m, y0 - m + 6 * k); ctx.lineTo(x0 - m, y0 - m); ctx.lineTo(x0 + w + m, y0 - m); ctx.lineTo(x0 + w + m, y0 - m + 6 * k)
          ctx.moveTo(x0 - m, y0 + h + m - 6 * k); ctx.lineTo(x0 - m, y0 + h + m); ctx.lineTo(x0 + w + m, y0 + h + m); ctx.lineTo(x0 + w + m, y0 + h + m - 6 * k)
          ctx.stroke()
          // pin-1 marker on silkscreen
          ctx.fillStyle = rgba(P.silk, 0.7 * a)
          ctx.beginPath(); ctx.arc(x0 - m - 4 * k, y0 - m - 1 * k, 1.6 * k, 0, Math.PI * 2); ctx.fill()
        }
        if (isSel || isHov) {
          const m = LEAD * k + 5
          ctx.strokeStyle = rgba(P.sel, isSel ? 0.95 : 0.55)
          ctx.lineWidth = isSel ? 1.5 : 1
          ctx.setLineDash(isSel ? [] : [3, 3])
          ctx.strokeRect(x0 - m, y0 - 7 * k - 3, w + 2 * m, h + 14 * k + 6)
          ctx.setLineDash([])
        }
        // issue glow under a faulty part
        if (b.ta > 0.02 && (level || surgeTint) && b.ex < 0.5) {
          ctx.globalCompositeOperation = 'lighter'
          ctx.strokeStyle = rgba(level ? tcol : P.amber, 0.35 * b.ta * pulse * dim)
          ctx.lineWidth = 2
          ctx.strokeRect(x0 - 1, y0 - 1, w + 2, h + 2)
          ctx.globalCompositeOperation = 'source-over'
        }

        // designator + check-job test points above the part
        const topY = y0 - 7 * k - 4
        const dfs = clamp(11 * k, 8, 14)
        ctx.font = font(700, dfs)
        ctx.textAlign = 'left'
        ctx.textBaseline = 'bottom'
        ctx.fillStyle = rgba(P.silk, Math.max(0.5, a))
        ctx.fillText(b.des, x0 - 4 * k, topY)
        let tpx = x0 - 4 * k + ctx.measureText(b.des).width + 10
        const jobs = jobsByNode.get(b.id) ?? []
        for (const r of jobs) {
          const cy = topY - dfs * 0.4
          const rr = clamp(5 * k, 4, 7)
          ctx.globalAlpha = r.alpha * dim
          ctx.fillStyle = rgba(P.gold, 0.9)
          ctx.beginPath(); ctx.arc(tpx + rr, cy, rr * 0.55, 0, Math.PI * 2); ctx.fill()
          ctx.strokeStyle = rgba(P.silk, 0.25)
          ctx.lineWidth = 1.5
          ctx.beginPath(); ctx.arc(tpx + rr, cy, rr + 1.5, 0, Math.PI * 2); ctx.stroke()
          ctx.strokeStyle = '#e9fff2'
          ctx.beginPath(); ctx.arc(tpx + rr, cy, rr + 1.5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0.06, r.progress)); ctx.stroke()
          ctx.font = font(500, clamp(9 * k, 7, 11))
          ctx.fillStyle = '#e9fff2'
          ctx.textBaseline = 'middle'
          // label only where it cannot run into the warning marker at the right
          const room = (nIssues > 0 && level ? x0 + w - 46 : x0 + w + LEAD * k + 60) - (tpx + rr * 2 + 5)
          const tl = room > 24 ? truncate(ctx, `TP ${r.type}`, room) : ''
          if (tl) ctx.fillText(tl, tpx + rr * 2 + 5, cy)
          tpx += rr * 2 + 5 + ctx.measureText(tl).width + 10
          ctx.textBaseline = 'bottom'
          ctx.globalAlpha = 1
        }
        const tag = booting || n.status === 'deleting' || n.status === 'offline' ? (booting ? `DNP · ${n.status.toUpperCase()}` : n.status === 'deleting' ? 'REMOVING' : 'OFFLINE') : ''
        if (tag) {
          ctx.font = font(600, clamp(9 * k, 7, 11))
          ctx.fillStyle = n.status === 'offline' ? P.red : P.gold
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(tag, p.x, booting ? p.y : y0 + h / 2)
        }

        newHits.splice(newHits.length - (lay && b.ex > 0.5 ? lay.role.files.length : 0), 0, { kind: 'node', id: b.id, x0: x0 - lead, y0, x1: x0 + w + lead, y1: y0 + h })
        labelJobs.push({ b, sx: p.x, sy: p.y, hh: h / 2, hw: w / 2, a, prio: (isSel || isHov ? 100 : 0) + st.weight + (level ? 3 : 0) })
        if (nIssues > 0 && level && b.ta > 0.05) badgeJobs.push({ id: b.id, x: x0 + w + 4 * k, y: topY - dfs * 0.45 - 6, level, n: nIssues, a: dim, fs: 10 })
      }

      // -- burst ring when a part gains a new real issue ------------------------
      for (let i = burstsRef.current.length - 1; i >= 0; i--) {
        const bu = burstsRef.current[i]
        bu.age += dt
        const b = bodies.get(bu.id)
        if (bu.age >= 0.9 || !b || red) { burstsRef.current.splice(i, 1); continue }
        const t = bu.age / 0.9
        const p = S(b.x, b.y)
        const g = 6 + t * 26
        ctx.globalAlpha = (1 - t) * 0.7
        ctx.strokeStyle = bu.color
        ctx.lineWidth = 1.5
        ctx.strokeRect(p.x - (b.w / 2) * k - g, p.y - (b.h / 2) * k - g, b.w * k + 2 * g, b.h * k + 2 * g)
        ctx.globalAlpha = 1
      }

      // -- silkscreen labels under parts (collision pass) ------------------------
      {
        type Rect = { x0: number; y0: number; x1: number; y1: number }
        const placed: Rect[] = []
        const boxes = labelJobs.map((j) => ({ id: j.b.id, x0: j.sx - j.hw - LEAD * k, y0: j.sy - j.hh - 8 * k, x1: j.sx + j.hw + LEAD * k, y1: j.sy + j.hh + 6 * k }))
        const overlaps = (r: Rect, ownId: string) => {
          for (const q of placed) if (r.x0 < q.x1 && r.x1 > q.x0 && r.y0 < q.y1 && r.y1 > q.y0) return true
          for (const c of boxes) if (c.id !== ownId && r.x0 < c.x1 && r.x1 > c.x0 && r.y0 < c.y1 && r.y1 > c.y0) return true
          return false
        }
        const showGauge = k > 0.5
        for (const j of labelJobs.sort((x, y) => y.prio - x.prio)) {
          const n = j.b.node
          const f1 = clamp(11 * k, 9, 13)
          const f2 = clamp(9.5 * k, 8, 11)
          ctx.font = font(500, f1)
          const label = truncate(ctx, n.label, 170)
          const lw = ctx.measureText(label).width
          ctx.font = font(400, f2)
          const ip = truncate(ctx, n.privateIp, 170)
          const iw = ctx.measureText(ip).width
          const w = Math.max(lw, iw, showGauge ? 70 : 0)
          const top = j.sy + j.hh + 9 * k + 3
          const h = f1 + 3 + f2 + (showGauge ? 10 : 0)
          const rect = { x0: j.sx - w / 2 - 3, y0: top - 2, x1: j.sx + w / 2 + 3, y1: top + h + 2 }
          if (j.prio < 100 && overlaps(rect, j.b.id)) continue
          placed.push(rect)
          const a = Math.max(0.5, j.a)
          ctx.textAlign = 'center'
          ctx.textBaseline = 'top'
          ctx.font = font(500, f1)
          ctx.fillStyle = rgba(P.silk, a)
          ctx.fillText(label, j.sx, top)
          ctx.font = font(400, f2)
          ctx.fillStyle = rgba(P.silkDim, a)
          ctx.fillText(ip, j.sx, top + f1 + 3)
          if (showGauge && n.status === 'running') {
            const gy = top + f1 + 3 + f2 + 5
            const vals = [n.cpu, n.memTotal ? n.memUsed / n.memTotal : 0]
            vals.forEach((v, i) => {
              const x = j.sx - 34 + i * 36
              ctx.strokeStyle = rgba(P.silk, 0.35 * a)
              ctx.lineWidth = 1
              ctx.strokeRect(x + 0.5, gy + 0.5, 32, 4)
              ctx.fillStyle = v > 0.9 ? P.red : v > 0.75 ? P.amber : rgba(P.silk, 0.8 * a)
              ctx.fillRect(x + 1.5, gy + 1.5, 30 * clamp(v, 0, 1), 2)
            })
          }
        }
      }

      // -- silkscreen warning markers: "!" / "!3", kept apart ---------------------
      {
        ctx.font = font(700, 10)
        const sized = badgeJobs.map((bj) => {
          const text = bj.n > 1 ? `!${bj.n}` : '!'
          const w = ctx.measureText(text).width + 22
          return { ...bj, text, w, x: bj.x - w, y: bj.y }
        })
        for (let it = 0; it < 10; it++) {
          for (let i = 0; i < sized.length; i++) {
            for (let j = i + 1; j < sized.length; j++) {
              const A = sized[i], B = sized[j]
              const ox = Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x) + 4
              const oy = Math.min(A.y + 8, B.y + 8) - Math.max(A.y - 8, B.y - 8) + 4
              if (ox <= 0 || oy <= 0) continue
              if (oy < ox) { const s = (A.y <= B.y ? -1 : 1) * oy / 2; A.y += s; B.y -= s }
              else { const s = (A.x <= B.x ? -1 : 1) * ox / 2; A.x += s; B.x -= s }
            }
          }
        }
        for (const bj of sized) {
          const col = bj.level === 'amber' ? P.amber : P.red
          ctx.globalAlpha = bj.a * (red ? 1 : 0.82 + 0.18 * pulse)
          ctx.fillStyle = 'rgba(10,11,10,0.85)'
          ctx.fillRect(bj.x, bj.y - 8, bj.w, 16)
          ctx.strokeStyle = col
          ctx.lineWidth = 1
          ctx.strokeRect(bj.x + 0.5, bj.y - 7.5, bj.w - 1, 15)
          // warning triangle
          const tx = bj.x + 9, ty = bj.y
          ctx.fillStyle = col
          ctx.beginPath(); ctx.moveTo(tx, ty - 5.5); ctx.lineTo(tx + 5.5, ty + 4.5); ctx.lineTo(tx - 5.5, ty + 4.5); ctx.closePath(); ctx.fill()
          ctx.fillStyle = '#0a0b0a'
          ctx.fillRect(tx - 0.6, ty - 2, 1.3, 3.6)
          ctx.fillRect(tx - 0.6, ty + 2.4, 1.3, 1.2)
          ctx.fillStyle = col
          ctx.font = font(700, 10)
          ctx.textAlign = 'left'
          ctx.textBaseline = 'middle'
          ctx.fillText(bj.text, bj.x + 17, bj.y + 0.5)
          ctx.globalAlpha = 1
          newHits.push({ kind: 'badge', id: bj.id, file: bj.file, x0: bj.x, y0: bj.y - 8, x1: bj.x + bj.w, y1: bj.y + 8 })
        }
      }
      hits = newHits
      if (hoverLink && !geos.has(hoverLink)) hoverLink = null
      if (hover) {
        const h = hover
        hover = hits.find((x) => x.kind === h.kind && x.id === h.id && x.file === h.file) ?? null
      }

      // -- tooltips -----------------------------------------------------------------
      if (!press && mouse) {
        const anchorOf = (h: Hit) => ({ x: (h.x0 + h.x1) / 2, y: (h.y0 + h.y1) / 2, r: (h.x1 - h.x0) / 2 + 8 })
        if (hover?.kind === 'node') {
          const b = bodies.get(hover.id)
          if (b) {
            const n = b.node
            const lines: { t: string; c?: string }[] = [
              { t: `${b.des}  ${n.label}  ·  ${n.role}  ·  ${n.status}` },
              { t: `${n.privateIp}  /  ${n.publicIp}` },
              { t: `${n.region}  ·  ${n.type}` },
            ]
            if (n.status === 'running') lines.push({ t: `cpu ${Math.round(n.cpu * 100)}%  mem ${fmtMem(n.memUsed, n.memTotal)}  load ${n.load1}` })
            for (const pr of n.processes.slice(0, 4)) lines.push({ t: `  ${pr.name}${pr.ports.length ? ':' + pr.ports.join(',') : ''}` })
            if (n.processes.length > 4) lines.push({ t: `  +${n.processes.length - 4} more (select for detail)` })
            for (const r of jobsByNode.get(n.id) ?? []) if (r.active) lines.push({ t: `TP check ${r.type} ${Math.round(r.progress * 100)}%  ${r.note}`, c: '#bff5d6' })
            const ni = (n.issues ?? []).length
            if (ni) lines.push({ t: `! ${ni} issue${ni > 1 ? 's' : ''} — select for detail`, c: issueLevel(n) === 'amber' ? P.amber : P.red })
            if (codeFor(Pp.codemap, n.role) && b.ex < 0.5) lines.push({ t: 'click to decap (files)', c: P.silkDim })
            drawTooltip(lines, anchorOf(hover), 'node')
          }
        } else if (hover?.kind === 'file') {
          const b = bodies.get(hover.id)
          const lay = b ? layoutOf(b) : null
          const f = lay?.role.files.find((x) => x.path === hover!.file)
          if (b && lay && f) {
            const ports = lay.role.ports.filter((q) => q.file === f.path).map((q) => `${q.dir} :${q.port}`)
            const imports = lay.role.edges.filter((e) => e.from === f.path).length
            const lines: { t: string; c?: string }[] = [{ t: f.path }, { t: `${f.loc} loc  ·  imports ${imports}${ports.length ? '  ·  ' + ports.join(', ') : ''}` }]
            for (const i of fileIssues(b.node, f.path).slice(0, 2)) lines.push({ t: `! ${i.severity}  ${i.title}`, c: (SEV_RANK[i.severity] ?? 0) >= 3 ? P.red : P.amber })
            drawTooltip(lines, anchorOf(hover), 'node')
          }
        } else if (hover?.kind === 'badge') {
          const b = bodies.get(hover.id)
          const src = b ? (hover.file ? fileIssues(b.node, hover.file) : b.node.issues ?? []) : []
          const iss = src.slice().sort((x, y) => (SEV_RANK[y.severity] ?? 0) - (SEV_RANK[x.severity] ?? 0))
          if (b && iss.length) {
            const lines = [{ t: `${iss[0].severity.toUpperCase()}  ${iss[0].title}`, c: (SEV_RANK[iss[0].severity] ?? 0) >= 3 ? P.red : P.amber }]
            if (iss.length > 1) lines.push({ t: `+${iss.length - 1} more on ${b.node.label}`, c: P.silkDim })
            drawTooltip(lines, anchorOf(hover), 'node')
          }
        } else if (hoverLink) {
          const l = hoverLink
          drawTooltip([
            { t: `NET ${l.data.protocol.toUpperCase()} :${l.data.port}  ·  ${l.data.conns} conns` },
            { t: `${l.a.des} ${l.a.node.label} → ${l.b.des} ${l.b.node.label}  ${fmtRate(l.sF)}` },
            { t: `${l.b.des} ${l.b.node.label} → ${l.a.des} ${l.a.node.label}  ${fmtRate(l.sR)}` },
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return <canvas ref={canvasRef} className="pcb-canvas" />
}
