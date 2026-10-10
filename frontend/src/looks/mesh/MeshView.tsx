import { useEffect, useRef } from 'react'
import type { MutableRefObject } from 'react'
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from 'd3-force'
import type { Simulation, SimulationLinkDatum, SimulationNodeDatum } from 'd3-force'
import { loadPos, savePos, takeAlias, takePlacement } from '../../graph/positions'
import { ACTIVE_AGENT, codeFor, fileIssues, fmtMem, fmtRate, isControl, issueLevel } from '../../graph/GraphView'
import type { Agent, Codemap, CodemapRole, Fleet, FleetIssue, FleetLink, FleetNode, Metrics } from '../../graph/types'

// ---------------------------------------------------------------------------
// Service-mesh traffic graph in the Kiali (Istio console) idiom: shape = kind,
// border = health from real issues, edge colour = request health (HTTP) or
// TCP blue, edge label = real throughput, moving dots = real bytes/s per
// direction (red diamonds = real HTTP error ratio). Light PatternFly canvas.
// ---------------------------------------------------------------------------

export type Sel = { kind: 'node'; id: string; file?: string } | { kind: 'link'; id: string }

export const K = {
  bg: '#ffffff',
  text: '#151515',
  sub: '#6a6e73',
  line: '#d2d2d2',
  idle: '#b8bbbe',
  green: '#3e8635',
  orange: '#ec7a08',
  red: '#c9190b',
  blue: '#0066cc',
  tcp: '#2b9af3',
  ctl: '#8a8d90',
  sel: '#0066cc',
}

export type Shape = 'triangle' | 'circle' | 'square' | 'diamond' | 'roundrect'
export interface KindStyle {
  shape: Shape
  glyph: string
  r: number
  weight: number
  tx: number
  ty: number
  kind: string // Kiali-ish kind word for the panel pill
}
// Kiali conventions: ingress/lb = triangle (service), workloads = circle,
// data stores = square, external = diamond (service entry), control = app box.
export const KIND: Record<string, KindStyle> = {
  internet: { shape: 'diamond', glyph: 'NET', r: 18, weight: 3, tx: -620, ty: 0, kind: 'external' },
  traffic: { shape: 'circle', glyph: 'TRF', r: 18, weight: 3, tx: -430, ty: 0, kind: 'workload' },
  lb: { shape: 'triangle', glyph: 'LB', r: 20, weight: 5, tx: -220, ty: 0, kind: 'ingress' },
  app: { shape: 'circle', glyph: 'APP', r: 19, weight: 3, tx: 20, ty: 0, kind: 'workload' },
  worker: { shape: 'circle', glyph: 'WRK', r: 18, weight: 2, tx: 60, ty: 240, kind: 'workload' },
  cache: { shape: 'square', glyph: 'RDS', r: 18, weight: 4, tx: 300, ty: -130, kind: 'data store' },
  db: { shape: 'square', glyph: 'PG', r: 19, weight: 5, tx: 320, ty: 130, kind: 'data store' },
  controller: { shape: 'roundrect', glyph: 'CTL', r: 18, weight: 4, tx: -80, ty: -210, kind: 'control plane' },
}
export const kindOf = (r: string): KindStyle =>
  KIND[r] ?? { shape: 'circle', glyph: r.slice(0, 3).toUpperCase(), r: 15, weight: 2, tx: 0, ty: 0, kind: 'workload' }

const ANCHOR_ROLE: Record<string, string> = { app: 'lb', worker: 'db', cache: 'app', db: 'app', lb: 'traffic', traffic: 'internet' }
const SEV_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 }
const SANS = '"Red Hat Text", "Overpass", "Helvetica Neue", Arial, sans-serif'
const MONO = '"Red Hat Mono", ui-monospace, Menlo, monospace'
const LINK_GRACE_MS = 30000
const PAD = 36

type Level = 'red' | 'amber'

interface Body extends SimulationNodeDatum {
  id: string
  node: FleetNode
  pending: boolean
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
  seed: number
}

interface FileLayout {
  role: CodemapRole
  entry: string
  hw: number // box half-width (world)
  hh: number // box half-height (world)
  pos: Map<string, { x: number; y: number; r: number }>
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

interface Ghost { x: number; y: number; r: number; shape: Shape; t: number }

type Hit = { kind: 'node' | 'badge' | 'file'; id: string; file?: string; sx: number; sy: number; rs: number; hw?: number; hh?: number }

export interface ViewApi {
  zoom: (f: number) => void
  fit: () => void
}

export interface Display {
  edgeLabels: boolean
  animation: boolean
  showControl: boolean
}

interface Props {
  fleet: Fleet | null
  agents: Agent[]
  metrics: Metrics | null
  codemap: Codemap | null
  live: boolean
  reduced: boolean
  rightInset: number
  leftInset: number
  display: Display
  selected: Sel | null
  focus: { id: string; n: number } | null
  onSelect: (s: Sel | null) => void
  onDropRole: (role: string, x: number, y: number) => void
  apiRef: MutableRefObject<ViewApi | null>
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v)

const rgbCache = new Map<string, [number, number, number]>()
function rgb(hex: string): [number, number, number] {
  let v = rgbCache.get(hex)
  if (!v) {
    const n = parseInt(hex.slice(1), 16)
    v = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
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
function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}
function rand01(n: number): number {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b) >>> 0
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296
}

function levelOf(issues: FleetIssue[]): Level | null {
  let top = 0
  for (const i of issues) top = Math.max(top, SEV_RANK[i.severity] ?? 1)
  return top === 0 ? null : top >= 3 ? 'red' : 'amber'
}
export const healthColor = (n: FleetNode): string => {
  const l = issueLevel(n)
  return l === 'red' ? K.red : l === 'amber' ? K.orange : K.green
}

/** Kiali edge colour: TCP blue, control grey, HTTP by real error-rate thresholds. */
export function edgeColor(proto: string, errPct: number, bps: number): string {
  if (isControl(proto)) return K.ctl
  if (bps < 1) return K.idle
  if (proto === 'http' || proto === 'http-app') return errPct >= 20 ? K.red : errPct >= 0.1 ? K.orange : K.green
  return K.tcp
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

// Expanded workload: Kiali-style compound box, files laid out left→right by
// import depth from the entry file (the one that owns the inbound port).
const COLW = 150
const ROWH = 78
const layoutCache = new Map<string, FileLayout>()
function layoutFor(role: string, cr: CodemapRole): FileLayout {
  const key = `${role}|${cr.files.map((f) => f.path).join(',')}|${cr.edges.length}`
  const hit = layoutCache.get(key)
  if (hit) return hit
  const portFiles = new Set(cr.ports.map((p) => p.file))
  const entry = cr.ports.find((p) => p.dir === 'in')?.file ?? cr.files.slice().sort((a, b) => b.loc - a.loc)[0].path
  const adj = new Map<string, string[]>()
  for (const e of cr.edges) {
    if (!adj.has(e.from)) adj.set(e.from, [])
    adj.get(e.from)!.push(e.to)
  }
  const prev = new Map<string, string>()
  const depth = new Map<string, number>([[entry, 0]])
  const q = [entry]
  while (q.length) {
    const cur = q.shift()!
    for (const nx of adj.get(cur) ?? []) {
      if (depth.has(nx)) continue
      depth.set(nx, depth.get(cur)! + 1)
      prev.set(nx, cur)
      q.push(nx)
    }
  }
  let maxD = 0
  for (const d of depth.values()) maxD = Math.max(maxD, d)
  const cols: string[][] = []
  for (const f of cr.files) {
    const d = depth.get(f.path) ?? maxD + 1
    ;(cols[d] ??= []).push(f.path)
  }
  const locOf = new Map(cr.files.map((f) => [f.path, f.loc]))
  const ncol = cols.length
  let maxRows = 1
  const fr = (loc: number) => clamp(5 + Math.sqrt(loc) / 4, 6, 11)
  const pos = new Map<string, { x: number; y: number; r: number }>()
  cols.forEach((col, ci) => {
    if (!col) return
    col.sort((a, b) => Number(portFiles.has(b)) - Number(portFiles.has(a)) || (locOf.get(b) ?? 0) - (locOf.get(a) ?? 0))
    maxRows = Math.max(maxRows, col.length)
    col.forEach((p, ri) => {
      pos.set(p, { x: (ci - (ncol - 1) / 2) * COLW, y: (ri - (col.length - 1) / 2) * ROWH + 8, r: fr(locOf.get(p) ?? 40) })
    })
  })
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
  const hw = ((ncol - 1) * COLW) / 2 + 74
  const hh = ((maxRows - 1) * ROWH) / 2 + 62
  const lay = { role: cr, entry, hw, hh, pos, pathTo }
  layoutCache.set(key, lay)
  return lay
}
export const layoutOfRole = (cm: Codemap | null, role: string): FileLayout | null => {
  const cr = codeFor(cm, role)
  return cr ? layoutFor(role, cr) : null
}

function shapePath(ctx: CanvasRenderingContext2D, shape: Shape, x: number, y: number, r0: number) {
  const r = Math.max(0.5, r0) // canvas throws on negative radii
  ctx.beginPath()
  if (shape === 'circle') ctx.arc(x, y, r, 0, Math.PI * 2)
  else if (shape === 'square') ctx.rect(x - r * 0.9, y - r * 0.9, r * 1.8, r * 1.8)
  else if (shape === 'diamond') {
    const d = r * 1.22
    ctx.moveTo(x, y - d); ctx.lineTo(x + d, y); ctx.lineTo(x, y + d); ctx.lineTo(x - d, y); ctx.closePath()
  } else if (shape === 'triangle') {
    const R = r * 1.3
    ctx.moveTo(x, y - R)
    ctx.lineTo(x + R * 0.866, y + R * 0.5 + r * 0.12)
    ctx.lineTo(x - R * 0.866, y + R * 0.5 + r * 0.12)
    ctx.closePath()
  } else {
    ctx.roundRect(x - r * 1.15, y - r * 0.85, r * 2.3, r * 1.7, Math.min(5, r * 0.3))
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.roundRect(x, y, Math.max(0, w), Math.max(0, h), Math.max(0, Math.min(r, w / 2, h / 2)))
}

// ---------------------------------------------------------------------------
export default function MeshView(props: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const propsRef = useRef<Props>(props)
  propsRef.current = props

  const bodiesRef = useRef(new Map<string, Body>())
  const linksRef = useRef(new Map<string, LinkR>())
  const ghostsRef = useRef<Ghost[]>([])
  const burstsRef = useRef<{ id: string; age: number; color: string }[]>([])
  const simRef = useRef<Simulation<Body, LinkR> | null>(null)

  const collideRadius = (d: Body) => {
    const lay = d.open ? layoutOfRole(propsRef.current.codemap, d.node.role) : null
    if (lay) return Math.max(lay.hw, lay.hh + 30) + 40
    return Math.max(kindOf(d.node.role).r + 34, d.labelW / 2 + 16)
  }
  const collideRef = useRef(forceCollide<Body>(collideRadius).strength(1).iterations(2))

  if (!simRef.current) {
    simRef.current = forceSimulation<Body, LinkR>([])
      .force('link', forceLink<Body, LinkR>([]).id((d) => d.id).distance(200).strength(0.2))
      .force('charge', forceManyBody<Body>().strength(-1000).distanceMax(900))
      .force('collide', collideRef.current)
      .force('x', forceX<Body>((d) => kindOf(d.node.role).tx).strength(0.12))
      .force('y', forceY<Body>((d) => kindOf(d.node.role).ty).strength(0.06))
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

    const measure = (n: FleetNode) => Math.max(n.label.length * 6.6, n.privateIp.length * 6, 70)

    const place = (n: FleetNode): { x: number; y: number; pin: boolean } => {
      const drop = takePlacement(n.id)
      if (drop) return { ...drop, pin: true }
      const saved = n.id.startsWith('pending-') ? null : loadPos(n.label)
      if (saved) return { ...saved, pin: true }
      const jitter = () => (Math.random() - 0.5) * 60
      for (const l of fleet.links) {
        const other = l.source === n.id ? l.target : l.target === n.id ? l.source : null
        const ob = other ? bodies.get(other) : undefined
        if (ob) return { x: (ob.x ?? 0) + 170 * Math.sign(kindOf(n.role).tx - kindOf(ob.node.role).tx || 1) + jitter(), y: (ob.y ?? 0) + jitter(), pin: false }
      }
      const ar = ANCHOR_ROLE[n.role]
      for (const b of bodies.values()) if (b.node.role === ar) return { x: (b.x ?? 0) + 170 + jitter(), y: (b.y ?? 0) + jitter(), pin: false }
      const st = kindOf(n.role)
      return { x: st.tx + jitter(), y: st.ty + jitter(), pin: false }
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
          id: n.id, node: n, pending: n.id.startsWith('pending-'), alpha: 0, ex: 0, open: false,
          bootStart: performance.now(), bootPhase: n.status, lastIssueCount: (n.issues ?? []).length,
          labelW: measure(n), x: p.x, y: p.y, fx: p.pin ? p.x : null, fy: p.pin ? p.y : null,
        }
        bodies.set(n.id, b)
        structural = true
      }
      if (b.bootPhase !== n.status) {
        b.bootPhase = n.status
        b.bootStart = performance.now()
      }
      const ic = (n.issues ?? []).length
      if (ic > b.lastIssueCount) burstsRef.current.push({ id: n.id, age: 0, color: issueLevel(n) === 'amber' ? K.orange : K.red })
      b.lastIssueCount = ic
      if (b.node.label !== n.label) b.labelW = measure(n)
      b.node = n
      b.pending = n.id.startsWith('pending-')
      seen.add(n.id)
    }
    for (const [id, b] of bodies) {
      if (seen.has(id)) continue
      ghostsRef.current.push({ x: b.x ?? 0, y: b.y ?? 0, r: kindOf(b.node.role).r, shape: kindOf(b.node.role).shape, t: 0 })
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
        lr = { id: l.id, a, b, source: a, target: b, data: l, sF: 0, sR: 0, phF: 0, phR: 0, dead: false, present: true, goneAt: 0, seed: hash(l.id) }
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
  }, [props.fleet])

  // ---- canvas loop + interaction -------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const sim = simRef.current!

    let W = 800
    let H = 600
    let dpr = 1
    const view = { k: 1, tx: W / 2, ty: H / 2 }
    let autoFit = true
    let focusN = -1
    let panTo: { x: number; y: number } | null = null
    let expandedId: string | null = null

    const pointers = new Map<number, { x: number; y: number }>()
    let press: { x: number; y: number; hit: Hit | null; moved: boolean; lastX: number; lastY: number } | null = null
    let pinch: { dist: number; k: number } | null = null
    let dragBody: Body | null = null
    let mouse: { x: number; y: number } | null = null
    let hover: Hit | null = null
    let hoverLink: LinkR | null = null
    let hits: Hit[] = []
    let visibleLinks = new Set<LinkR>()
    const agentsR = new Map<string, AgentR>()

    const resize = () => {
      const host = canvas.parentElement
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      W = Math.max(50, host ? host.clientWidth : window.innerWidth)
      H = Math.max(50, host ? host.clientHeight : window.innerHeight)
      canvas.width = Math.floor(W * dpr)
      canvas.height = Math.floor(H * dpr)
      canvas.style.width = `${W}px`
      canvas.style.height = `${H}px`
    }
    resize()
    const ro = new ResizeObserver(resize)
    if (canvas.parentElement) ro.observe(canvas.parentElement)

    const S = (x: number | undefined, y: number | undefined) => ({ x: (x ?? 0) * view.k + view.tx, y: (y ?? 0) * view.k + view.ty })
    const toWorld = (sx: number, sy: number) => ({ x: (sx - view.tx) / view.k, y: (sy - view.ty) / view.k })
    const zoomAround = (sx: number, sy: number, nk: number) => {
      const k = clamp(nk, 0.25, 4)
      view.tx = sx - ((sx - view.tx) * k) / view.k
      view.ty = sy - ((sy - view.ty) * k) / view.k
      view.k = k
    }
    propsRef.current.apiRef.current = {
      zoom: (f) => { autoFit = false; zoomAround(W / 2, H / 2, view.k * f) },
      fit: () => { autoFit = true },
    }
    const layoutOf = (b: Body): FileLayout | null => layoutOfRole(propsRef.current.codemap, b.node.role)
    // half extents in world units (blend node → box while expanding)
    const extentOf = (b: Body) => {
      const r = kindOf(b.node.role).r * 1.3
      const lay = b.ex > 0.01 ? layoutOf(b) : null
      if (!lay) return { hw: r, hh: r }
      return { hw: lay.hw * b.ex + r * (1 - b.ex), hh: lay.hh * b.ex + r * (1 - b.ex) }
    }

    // a node plus its direct (data-plane) neighbours
    const neighbours = (id: string): Set<string> => {
      const out = new Set([id])
      for (const l of linksRef.current.values()) {
        if (!l.present || isControl(l.data.protocol)) continue
        if (l.a.id === id) out.add(l.b.id)
        if (l.b.id === id) out.add(l.a.id)
      }
      return out
    }
    const fitTarget = () => {
      const bodies = bodiesRef.current
      if (bodies.size === 0) return null
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      // Kiali node graph: while a workload is open, frame it and its neighbours
      const open = expandedId ? bodies.get(expandedId) : undefined
      const only = open && open.ex > 0.2 ? neighbours(open.id) : null
      for (const b of bodies.values()) {
        if (only && !only.has(b.id)) continue
        const e = extentOf(b)
        const hw = Math.max(e.hw, b.labelW / 2) + 12
        x0 = Math.min(x0, (b.x ?? 0) - hw); x1 = Math.max(x1, (b.x ?? 0) + hw)
        y0 = Math.min(y0, (b.y ?? 0) - e.hh - 26); y1 = Math.max(y1, (b.y ?? 0) + e.hh + 46)
      }
      const left = Math.max(PAD, propsRef.current.leftInset)
      const top = PAD
      const aw = Math.max(200, W - left - Math.max(PAD, propsRef.current.rightInset))
      const ah = Math.max(160, H - top - PAD - 30)
      const k = clamp(Math.min(aw / (x1 - x0), ah / (y1 - y0)), 0.3, 1.5)
      return { k, tx: left + aw / 2 - ((x0 + x1) / 2) * k, ty: top + ah / 2 - ((y0 + y1) / 2) * k }
    }

    // Link endpoint: the node centre, or the file that owns the port when expanded.
    const endPos = (b: Body, l: LinkR, outgoing: boolean) => {
      const base = S(b.x, b.y)
      const r0 = kindOf(b.node.role).r * view.k * (1 - 0.85 * b.ex)
      if (b.ex < 0.01) return { ...base, r: r0, file: null as string | null }
      const lay = layoutOf(b)
      if (!lay) return { ...base, r: r0, file: null }
      const dir = outgoing ? 'out' : 'in'
      const pe = lay.role.ports.find((p) => p.port === l.data.port && p.dir === dir) ?? lay.role.ports.find((p) => p.port === l.data.port)
      const fp = pe ? lay.pos.get(pe.file) : undefined
      if (!pe || !fp) return { ...base, r: r0, file: null }
      return { x: base.x + fp.x * b.ex * view.k, y: base.y + fp.y * b.ex * view.k, r: fp.r * view.k, file: pe.file }
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
        if (h.hw != null && h.hh != null) {
          if (Math.abs(x - h.sx) <= h.hw && Math.abs(y - h.sy) <= h.hh) return h
        } else if (Math.hypot(x - h.sx, y - h.sy) <= h.rs + 4) return h
      }
      return null
    }
    const linkAt = (x: number, y: number): LinkR | null => {
      let best: LinkR | null = null
      let bd = 7
      for (const l of linksRef.current.values()) {
        if (!visibleLinks.has(l) || !l.present) continue
        const a = endPos(l.a, l, true), b = endPos(l.b, l, false)
        const d = segDist(x, y, a.x, a.y, b.x, b.y)
        if (d < bd) { bd = d; best = l }
      }
      return best
    }

    // ---- input ---------------------------------------------------------------
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
        const w = toWorld(p.x, p.y)
        dragBody.fx = w.x; dragBody.fy = w.y; dragBody.x = w.x; dragBody.y = w.y
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

    // ---- drawing helpers -----------------------------------------------------
    const intensity = (bps: number) => clamp(Math.log10(1 + bps / 1024) / 3.5, 0, 1)
    const dotSpeed = (bps: number) => (bps < 1 ? 0 : 16 + 56 * intensity(bps))
    const dotGap = (bps: number) => 44 - 26 * intensity(bps)

    const arrow = (x: number, y: number, ux: number, uy: number, size: number, col: string) => {
      ctx.fillStyle = col
      ctx.beginPath()
      ctx.moveTo(x, y)
      ctx.lineTo(x - ux * size - uy * size * 0.55, y - uy * size + ux * size * 0.55)
      ctx.lineTo(x - ux * size + uy * size * 0.55, y - uy * size - ux * size * 0.55)
      ctx.closePath()
      ctx.fill()
    }

    // Kiali traffic animation: dots move source→target along an offset lane;
    // density + speed from real bytes/s (log); HTTP errors as red diamonds at
    // the real error ratio.
    const dots = (ax: number, ay: number, bx: number, by: number, bps: number, col: string, phase: number, alpha: number, off: number, errFrac: number, seed: number) => {
      if (bps < 1) return
      const dx = bx - ax, dy = by - ay
      const L = Math.hypot(dx, dy)
      if (L < 8) return
      const ux = dx / L, uy = dy / L
      const ox = -uy * off, oy = ux * off
      const gap = dotGap(bps)
      const it = intensity(bps)
      const r = 2 + 0.9 * it
      const base = ((phase % gap) + gap) % gap
      const id0 = Math.floor(phase / gap)
      for (let i = 0, s = base; s < L; i++, s += gap) {
        const x = ax + ux * s + ox, y = ay + uy * s + oy
        const edgeFade = Math.min(1, s / 10, (L - s) / 10)
        const isErr = errFrac > 0 && rand01((id0 - i) ^ seed) < errFrac
        ctx.globalAlpha = alpha * edgeFade
        if (isErr) {
          ctx.fillStyle = K.red
          ctx.beginPath(); ctx.moveTo(x, y - r - 1.2); ctx.lineTo(x + r + 1.2, y); ctx.lineTo(x, y + r + 1.2); ctx.lineTo(x - r - 1.2, y); ctx.closePath(); ctx.fill()
        } else {
          ctx.fillStyle = col
          ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill()
        }
      }
      ctx.globalAlpha = 1
    }

    const drawTooltip = (lines: { t: string; c?: string; b?: boolean }[], anchor: { x: number; y: number; r: number }, side: 'node' | 'cursor') => {
      ctx.font = `400 12px ${SANS}`
      const maxW = Math.min(360, W - 24)
      const shown = lines.map((l) => ({ ...l, t: truncate(ctx, l.t, maxW - 20) }))
      const w = Math.min(maxW, Math.max(...shown.map((l) => ctx.measureText(l.t).width)) + 22)
      const h = shown.length * 17 + 12
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
      y = clamp(y, 8, H - 8 - h)
      // PatternFly tooltip: dark, rounded
      ctx.fillStyle = 'rgba(21,21,21,0.94)'
      roundRect(ctx, x, y, w, h, 4); ctx.fill()
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      shown.forEach((l, i) => {
        ctx.font = `${i === 0 || l.b ? 600 : 400} 12px ${SANS}`
        ctx.fillStyle = l.c ?? (i === 0 ? '#ffffff' : '#d2d2d2')
        ctx.fillText(l.t, x + 11, y + 7 + i * 17)
      })
    }

    // ---- frame ---------------------------------------------------------------
    let raf = 0
    let last = performance.now()
    const frame = (now: number) => {
      const dt = Math.min(0.25, Math.max(0, (now - last) / 1000))
      last = now
      const P = propsRef.current
      const red = P.reduced
      const animate = P.display.animation && !red
      const pulse = red ? 1 : 0.75 + 0.25 * Math.sin(now / 380)
      const bodies = bodiesRef.current
      const links = linksRef.current
      const k = view.k
      const sel = P.selected

      const want = sel?.kind === 'node' && bodies.has(sel.id) && codeFor(P.codemap, bodies.get(sel.id)!.node.role) ? sel.id : null
      if (want !== expandedId) {
        expandedId = want
        for (const b of bodies.values()) b.open = b.id === want
        collideRef.current.radius(collideRadius)
        sim.alpha(Math.max(sim.alpha(), 0.3))
        if (red) sim.tick(120)
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
        const cx = Math.max(PAD, P.leftInset) + (W - Math.max(PAD, P.leftInset) - Math.max(PAD, P.rightInset)) / 2
        const cy = H / 2
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

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.globalAlpha = 1
      ctx.globalCompositeOperation = 'source-over'
      ctx.fillStyle = K.bg
      ctx.fillRect(0, 0, W, H)

      const newHits: Hit[] = []
      const errPct = P.metrics ? Math.max(0, P.metrics.errorRate) : 0
      const errTint = clamp(errPct / 10, 0, 0.6)
      const errFrac = clamp(errPct / 100, 0, 1)

      // -- agents → per-node check-job state ------------------------------------
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

      // -- focus set (Kiali: hover/select highlights the node and its neighbours)
      const focusId = hover?.kind === 'node' || hover?.kind === 'file' ? hover.id : sel?.kind === 'node' ? sel.id : null
      const focusLink = hoverLink ?? (sel?.kind === 'link' ? links.get(sel.id) ?? null : null)
      let hi: Set<string> | null = null
      if (focusId && bodies.has(focusId)) hi = neighbours(focusId)
      else if (focusLink) hi = new Set([focusLink.a.id, focusLink.b.id])
      const openSet = expandedId && bodies.has(expandedId) ? neighbours(expandedId) : null
      const dimOf = (b: Body) => {
        let d = 1 - (openSet && openSet.has(b.id) ? 0.1 : 0.6) * Math.max(0, dimAll - b.ex)
        if (hi && !hi.has(b.id)) d *= 0.4
        return d
      }

      // -- compound-box backgrounds go under the edges so links reach their files
      for (const b of bodies.values()) {
        if (b.ex <= 0.01) continue
        const lay = layoutOf(b)
        if (!lay) continue
        const p = S(b.x, b.y)
        const rs0 = Math.max(7, kindOf(b.node.role).r * k)
        const hw = (lay.hw * b.ex + rs0 * (1 - b.ex) / k) * k
        const hh = (lay.hh * b.ex + rs0 * (1 - b.ex) / k) * k
        ctx.globalAlpha = b.ex
        ctx.fillStyle = '#f7f8f9'
        roundRect(ctx, p.x - hw, p.y - hh, hw * 2, hh * 2, 6); ctx.fill()
        ctx.globalAlpha = 1
      }

      // -- links ------------------------------------------------------------------
      const nextVisible = new Set<LinkR>()
      const edgeLabelJobs: { l: LinkR; ax: number; ay: number; bx: number; by: number; text: string; col: string; a: number; prio: number; force: boolean }[] = []
      for (const l of links.values()) {
        const s = 1 - Math.exp(-dt / 1.2)
        l.sF += (Math.max(0, l.data.bytesPerSec) - l.sF) * s
        l.sR += (Math.max(0, l.data.bytesPerSecReverse) - l.sR) * s
        if (animate) {
          l.phF += dotSpeed(l.sF) * dt
          l.phR += dotSpeed(l.sR) * dt
        }
        if (!l.present) continue
        const control = isControl(l.data.protocol)
        const isSel = sel?.kind === 'link' && sel.id === l.id
        const ctlLink = control && (l.a.node.role === 'controller' || l.b.node.role === 'controller')
        if (ctlLink && !P.display.showControl && !isSel) {
          const fid = (id: string) => hover?.id === id || (sel?.kind === 'node' && sel.id === id) || jobsByNode.has(id)
          if (!fid(l.a.id) && !fid(l.b.id)) continue
        }
        nextVisible.add(l)
        const A = endPos(l.a, l, true)
        const B = endPos(l.b, l, false)
        const dx = B.x - A.x, dy = B.y - A.y
        const L = Math.hypot(dx, dy) || 1
        const ux = dx / L, uy = dy / L
        // clip to node outlines
        const ax = A.x + ux * (A.r + 3), ay = A.y + uy * (A.r + 3)
        const bx = B.x - ux * (B.r + 4), by = B.y - uy * (B.r + 4)
        if ((bx - ax) * ux + (by - ay) * uy <= 4) continue
        const isHov = hoverLink === l
        const lit = isSel || isHov || (hi != null && hi.has(l.a.id) && hi.has(l.b.id) && (focusId === l.a.id || focusId === l.b.id || focusLink === l))
        const da = Math.min(dimOf(l.a), dimOf(l.b)) * (hi && !lit ? 0.6 : 1)
        const total = l.sF + l.sR
        const http = l.data.protocol === 'http' || l.data.protocol === 'http-app'
        const col = edgeColor(l.data.protocol, errPct, total)
        ctx.globalAlpha = da
        if (isSel || isHov) {
          ctx.strokeStyle = rgba(K.sel, 0.22)
          ctx.lineWidth = 8
          ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke()
        }
        ctx.strokeStyle = control ? rgba(col, 0.75) : col
        ctx.lineWidth = control ? 1 : lit ? 2.6 : 1.8
        ctx.setLineDash(control ? [4, 4] : [])
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx - ux * 6, by - uy * 6); ctx.stroke()
        ctx.setLineDash([])
        arrow(bx, by, ux, uy, control ? 7 : 9, ctx.strokeStyle as string)
        ctx.globalAlpha = 1
        if (!control) {
          const dotCol = http && errTint > 0 ? mix(mix(col, '#000000', 0.25), K.red, errTint) : mix(col, '#000000', 0.25)
          dots(ax, ay, bx - ux * 8, by - uy * 8, l.sF, dotCol, l.phF, da, 4.2, http ? errFrac : 0, l.seed)
          dots(bx - ux * 8, by - uy * 8, ax, ay, l.sR, mix(col, '#000000', 0.1), l.phR, da * 0.8, 4.2, 0, l.seed ^ 0x55)
        }
        if (P.display.edgeLabels && !control && total >= 1) {
          edgeLabelJobs.push({ l, ax, ay, bx, by, text: fmtRate(total), col, a: da, prio: (lit ? 100 : 0) + intensity(total), force: isSel || isHov })
        } else if (P.display.edgeLabels && control && (isSel || isHov)) {
          edgeLabelJobs.push({ l, ax, ay, bx, by, text: `ssh :${l.data.port}`, col, a: da, prio: 100, force: true })
        }
      }
      visibleLinks = nextVisible

      // -- ghosts --------------------------------------------------------------
      for (let i = ghostsRef.current.length - 1; i >= 0; i--) {
        const g = ghostsRef.current[i]
        g.t += dt / 0.8
        if (g.t >= 1) { ghostsRef.current.splice(i, 1); continue }
        const p = S(g.x, g.y)
        ctx.globalAlpha = 0.4 * (1 - g.t)
        shapePath(ctx, g.shape, p.x, p.y, g.r * k * (1 - 0.3 * g.t))
        ctx.strokeStyle = K.ctl
        ctx.lineWidth = 1.5
        ctx.stroke()
        ctx.globalAlpha = 1
      }

      // -- nodes ------------------------------------------------------------------
      const surge = P.metrics?.mode === 'surge'
      const order = [...bodies.values()].sort((a, b) => a.ex - b.ex)
      const labelJobs: { b: Body; sx: number; sy: number; hh: number; a: number; prio: number; tag: string; tagCol: string }[] = []
      const badgeJobs: { id: string; file?: string; x: number; y: number; level: Level; n: number; a: number }[] = []
      const obstacles: { x0: number; y0: number; x1: number; y1: number }[] = []
      const fileLabels: { x0: number; y0: number; x1: number; y1: number }[] = []
      for (const b of order) {
        const n = b.node
        const st = kindOf(n.role)
        const p = S(b.x, b.y)
        const rs0 = Math.max(7, st.r * k)
        const level = issueLevel(n)
        const nIssues = (n.issues ?? []).length
        const statusA = n.status === 'deleting' ? 0.3 : n.status === 'provisioning' || n.status === 'booting' ? 0.65 : 1
        b.alpha += (statusA - b.alpha) * (1 - Math.exp(-dt * 4))
        const dim = dimOf(b)
        const a = b.alpha * dim
        if (p.x < -600 || p.y < -600 || p.x > W + 600 || p.y > H + 600) continue
        const lay = b.ex > 0 ? layoutOf(b) : null
        const rs = rs0 * (1 - 0.85 * b.ex)
        const isSel = sel?.kind === 'node' && sel.id === b.id
        const isHov = hover?.kind === 'node' && hover.id === b.id
        const running = n.status === 'running'
        const hcol = running ? healthColor(n) : n.status === 'offline' ? K.red : K.ctl
        let ext = { hw: rs0 * 1.3, hh: rs0 * 1.3 }

        // expanded: Kiali compound box with the workload's files
        if (lay && b.ex > 0.01) {
          const e = b.ex
          const hw = (lay.hw * e + rs0 * (1 - e) / k) * k
          const hh = (lay.hh * e + rs0 * (1 - e) / k) * k
          ext = { hw, hh }
          ctx.globalAlpha = e * dim
          roundRect(ctx, p.x - hw, p.y - hh, hw * 2, hh * 2, 6)
          ctx.strokeStyle = isSel ? K.sel : '#b8bbbe'
          ctx.lineWidth = isSel ? 2 : 1
          ctx.stroke()
          // health strip on the left edge
          ctx.fillStyle = hcol
          ctx.fillRect(p.x - hw, p.y - hh + 6, 3, hh * 2 - 12)
          if (e > 0.6) {
            ctx.globalAlpha = ((e - 0.6) / 0.4) * dim
            ctx.font = `600 11px ${SANS}`
            ctx.textAlign = 'left'
            ctx.textBaseline = 'top'
            ctx.fillStyle = K.text
            const head = truncate(ctx, `${n.label}`, hw * 2 - 24)
            ctx.fillText(head, p.x - hw + 12, p.y - hh + 8)
            const hwid = ctx.measureText(head).width
            ctx.font = `400 10px ${MONO}`
            ctx.fillStyle = K.sub
            ctx.fillText(truncate(ctx, `${n.privateIp}  ·  ${lay.role.root}`, Math.max(0, hw * 2 - 36 - hwid)), p.x - hw + 20 + hwid, p.y - hh + 9)
          }
          const fpos = (path: string) => {
            const f = lay.pos.get(path)
            return f ? { x: p.x + f.x * e * k, y: p.y + f.y * e * k, r: f.r * k * (0.4 + 0.6 * e) } : null
          }
          // import edges (grey arrows) + entry→port-file paths lit by the link's real rate
          const lit = new Map<string, { col: string; it: number }>()
          for (const l of links.values()) {
            const outgoing = l.a === b
            if (!l.present || (!outgoing && l.b !== b)) continue
            const pe = lay.role.ports.find((q) => q.port === l.data.port && q.dir === (outgoing ? 'out' : 'in'))
            if (!pe) continue
            const it = intensity(l.sF + l.sR)
            if (it <= 0.01) continue
            const pc = edgeColor(l.data.protocol, errPct, l.sF + l.sR)
            for (const [f, t] of lay.pathTo.get(pe.file) ?? []) {
              const key = `${f}>${t}`
              const prev = lit.get(key)
              if (!prev || prev.it < it) lit.set(key, { col: pc, it })
            }
          }
          for (const ed of lay.role.edges) {
            const A = fpos(ed.from), B = fpos(ed.to)
            if (!A || !B) continue
            const dx = B.x - A.x, dy = B.y - A.y
            const L = Math.hypot(dx, dy) || 1
            const ux = dx / L, uy = dy / L
            const L2 = lit.get(`${ed.from}>${ed.to}`)
            const col = L2 ? L2.col : '#8a8d90'
            ctx.globalAlpha = e * dim * (L2 ? 0.55 + 0.45 * L2.it : 0.7)
            ctx.strokeStyle = col
            ctx.lineWidth = L2 ? 1.2 + 1.6 * L2.it : 1
            const sx = A.x + ux * (A.r + 2), sy = A.y + uy * (A.r + 2)
            const ex2 = B.x - ux * (B.r + 3), ey2 = B.y - uy * (B.r + 3)
            ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex2 - ux * 5, ey2 - uy * 5); ctx.stroke()
            arrow(ex2, ey2, ux, uy, 6, col)
          }
          // files: small workload circles, health border from file-tied issues
          for (const f of lay.role.files) {
            const fp = fpos(f.path)
            if (!fp) continue
            const fi = fileIssues(n, f.path)
            const fl = levelOf(fi)
            const isF = sel?.kind === 'node' && sel.id === b.id && sel.file === f.path
            const isH = hover?.kind === 'file' && hover.id === b.id && hover.file === f.path
            ctx.globalAlpha = e * dim
            if (isF || isH) {
              ctx.fillStyle = rgba(K.sel, isF ? 0.18 : 0.1)
              ctx.beginPath(); ctx.arc(fp.x, fp.y, fp.r + 6, 0, Math.PI * 2); ctx.fill()
            }
            ctx.beginPath(); ctx.arc(fp.x, fp.y, fp.r, 0, Math.PI * 2)
            ctx.fillStyle = '#ffffff'
            ctx.fill()
            ctx.strokeStyle = isF ? K.sel : fl === 'red' ? K.red : fl === 'amber' ? K.orange : '#6a6e73'
            ctx.lineWidth = isF ? 2.5 : fl ? 2.5 : 1.3
            ctx.stroke()
            const isPort = lay.role.ports.some((q) => q.file === f.path)
            if (isPort) {
              ctx.fillStyle = '#6a6e73'
              ctx.beginPath(); ctx.arc(fp.x, fp.y, Math.max(1.5, fp.r * 0.3), 0, Math.PI * 2); ctx.fill()
            }
            if (e > 0.6) {
              ctx.globalAlpha = ((e - 0.6) / 0.4) * dim
              ctx.textAlign = 'center'
              ctx.textBaseline = 'top'
              const ports = lay.role.ports.filter((q) => q.file === f.path).map((q) => `${q.dir}:${q.port}`).join(' ')
              const t1 = (ctx.font = `500 11px ${SANS}`, truncate(ctx, f.label, COLW * k - 14))
              const w1 = ctx.measureText(t1).width
              const t2 = `${f.loc} loc${ports ? ' · ' + ports : ''}`
              ctx.font = `400 9.5px ${MONO}`
              const w2 = ctx.measureText(t2).width
              const lw = Math.max(w1, w2) + 8
              ctx.fillStyle = 'rgba(247,248,249,0.9)'
              roundRect(ctx, fp.x - lw / 2, fp.y + fp.r + 2, lw, 29, 3); ctx.fill()
              fileLabels.push({ x0: fp.x - lw / 2, y0: fp.y - fp.r - 4, x1: fp.x + lw / 2, y1: fp.y + fp.r + 31 })
              ctx.font = `500 11px ${SANS}`
              ctx.fillStyle = K.text
              ctx.fillText(t1, fp.x, fp.y + fp.r + 4)
              ctx.font = `400 9.5px ${MONO}`
              ctx.fillStyle = K.sub
              ctx.fillText(t2, fp.x, fp.y + fp.r + 18)
            }
            ctx.globalAlpha = 1
            if (e > 0.5) newHits.push({ kind: 'file', id: b.id, file: f.path, sx: fp.x, sy: fp.y, rs: Math.max(fp.r, 8) })
            if (fl && e > 0.5) badgeJobs.push({ id: b.id, file: f.path, x: fp.x + fp.r * 0.8 + 7, y: fp.y - fp.r * 0.8 - 6, level: fl, n: fi.length, a: e * dim })
          }
          ctx.globalAlpha = 1
        }

        // node shape: white fill, health-coloured border (Kiali)
        if (rs > 1.5 && b.ex < 0.98) {
          const fade = 1 - b.ex
          ctx.globalAlpha = a * fade
          if (isSel || isHov) {
            shapePath(ctx, st.shape, p.x, p.y, rs + 5)
            ctx.fillStyle = rgba(K.sel, isSel ? 0.16 : 0.09)
            ctx.fill()
          }
          shapePath(ctx, st.shape, p.x, p.y, rs)
          ctx.fillStyle = '#ffffff'
          ctx.fill()
          ctx.lineWidth = isSel ? 3 : level && running ? 3 : 2
          ctx.strokeStyle = isSel ? K.sel : hcol
          if (n.status === 'offline' || b.pending) ctx.setLineDash([3, 3])
          ctx.stroke()
          ctx.setLineDash([])
          if (isSel && level && rs > 6) {
            // keep health visible while selected: inner ring in health colour
            shapePath(ctx, st.shape, p.x, p.y, rs - 3.5)
            ctx.lineWidth = 1.5
            ctx.strokeStyle = hcol
            ctx.stroke()
          }
          if (rs >= 10) {
            ctx.font = `700 ${Math.round(clamp(rs * 0.5, 7, 11))}px ${SANS}`
            ctx.fillStyle = '#4f5255'
            ctx.textAlign = 'center'
            ctx.textBaseline = 'middle'
            ctx.fillText(st.glyph, p.x, p.y + (st.shape === 'triangle' ? rs * 0.28 : 0.5))
          }
          ctx.globalAlpha = 1
        }

        // boot progress + check-job arcs (PatternFly blue)
        const ringR = (b.ex > 0.01 ? Math.max(ext.hw, ext.hh) : rs0 * 1.3) + 6
        if ((n.status === 'provisioning' || n.status === 'booting') && b.ex < 0.3) {
          const t = (now - b.bootStart) / 1000
          const prog = n.status === 'provisioning' ? 0.4 * (1 - Math.exp(-t / 3)) : 0.4 + 0.55 * (1 - Math.exp(-t / 5))
          ctx.strokeStyle = '#e0e0e0'
          ctx.lineWidth = 3
          ctx.beginPath(); ctx.arc(p.x, p.y, ringR, 0, Math.PI * 2); ctx.stroke()
          ctx.strokeStyle = K.blue
          ctx.beginPath(); ctx.arc(p.x, p.y, ringR, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * prog); ctx.stroke()
        }
        const jobs = jobsByNode.get(b.id) ?? []
        if (b.ex < 0.3) {
          jobs.forEach((r, i) => {
            const rr = ringR + 4 + i * 5
            const end = -Math.PI / 2 + Math.PI * 2 * Math.max(0.06, r.progress)
            ctx.globalAlpha = r.alpha * dim
            ctx.strokeStyle = rgba(K.blue, 0.18)
            ctx.lineWidth = 2.5
            ctx.beginPath(); ctx.arc(p.x, p.y, rr, 0, Math.PI * 2); ctx.stroke()
            ctx.strokeStyle = K.blue
            ctx.beginPath(); ctx.arc(p.x, p.y, rr, -Math.PI / 2, end); ctx.stroke()
            ctx.globalAlpha = 1
          })
        }
        let tag = ''
        let tagCol = K.blue
        if (n.status === 'provisioning' || n.status === 'booting' || n.status === 'deleting' || n.status === 'offline') {
          tag = n.status
          tagCol = n.status === 'offline' || n.status === 'deleting' ? K.red : K.blue
        } else if (jobs.some((r) => r.active)) {
          const j = jobs.find((r) => r.active)!
          tag = `check ${j.type} ${Math.round(j.progress * 100)}%`
        } else if (surge && n.role === 'traffic') {
          tag = 'surge'
          tagCol = K.orange
        }

        // the box sits beneath its files in hit order (files win)
        if (b.ex > 0.5 && lay) newHits.splice(newHits.length - lay.role.files.length, 0, { kind: 'node', id: b.id, sx: p.x, sy: p.y, rs: 0, hw: ext.hw, hh: ext.hh })
        else newHits.push({ kind: 'node', id: b.id, sx: p.x, sy: p.y, rs: rs0 * 1.15 })
        obstacles.push({ x0: p.x - ext.hw, y0: p.y - ext.hh, x1: p.x + ext.hw, y1: p.y + ext.hh })
        labelJobs.push({ b, sx: p.x, sy: p.y, hh: b.ex > 0.01 ? ext.hh : rs0 * (st.shape === 'triangle' ? 1.0 : st.shape === 'diamond' ? 1.22 : 1), a, prio: (isSel || isHov ? 100 : 0) + st.weight + (level ? 3 : 0), tag, tagCol })
        if (nIssues > 0 && level) {
          const bx = b.ex > 0.5 ? p.x + ext.hw - 4 : p.x + rs0 * 0.95 + 5
          const by = b.ex > 0.5 ? p.y - ext.hh + 2 : p.y - rs0 * 0.95 - 5
          badgeJobs.push({ id: b.id, x: bx, y: by, level, n: nIssues, a: dim })
        }
      }

      // -- burst ring when a node gains a new real issue ------------------------
      for (let i = burstsRef.current.length - 1; i >= 0; i--) {
        const bu = burstsRef.current[i]
        bu.age += dt
        const b = bodies.get(bu.id)
        if (bu.age >= 0.9 || !b || red) { burstsRef.current.splice(i, 1); continue }
        const t = bu.age / 0.9
        const p = S(b.x, b.y)
        ctx.globalAlpha = (1 - t) * 0.7
        ctx.strokeStyle = bu.color
        ctx.lineWidth = 2
        ctx.beginPath(); ctx.arc(p.x, p.y, kindOf(b.node.role).r * k + 6 + t * 30, 0, Math.PI * 2); ctx.stroke()
        ctx.globalAlpha = 1
      }

      // -- node labels (Kiali: white label box under the node) ---------------------
      type Rect = { x0: number; y0: number; x1: number; y1: number }
      const placed: Rect[] = []
      const hitsRect = (r: Rect, list: Rect[]) => list.some((q) => r.x0 < q.x1 && r.x1 > q.x0 && r.y0 < q.y1 && r.y1 > q.y0)
      {
        for (const j of labelJobs.sort((a, b) => b.prio - a.prio)) {
          const n = j.b.node
          ctx.font = `600 11.5px ${SANS}`
          const label = truncate(ctx, n.label, 160)
          const lw = ctx.measureText(label).width
          ctx.font = `400 10px ${MONO}`
          const ip = truncate(ctx, n.privateIp, 160)
          const iw = ctx.measureText(ip).width
          const w = Math.max(lw, iw) + 12
          const top = j.sy + j.hh + 7
          const h = 31
          const rect = { x0: j.sx - w / 2, y0: top, x1: j.sx + w / 2, y1: top + h }
          const own = obstacles.find((o) => Math.abs((o.x0 + o.x1) / 2 - j.sx) < 0.5 && Math.abs((o.y0 + o.y1) / 2 - j.sy) < 0.5)
          if (j.prio < 100 && (hitsRect(rect, placed) || hitsRect(rect, obstacles.filter((o) => o !== own)))) continue
          const a = Math.max(0.45, j.a)
          ctx.globalAlpha = a
          if (j.b.ex < 0.5) {
            placed.push(rect)
            ctx.fillStyle = 'rgba(255,255,255,0.92)'
            roundRect(ctx, rect.x0, rect.y0, w, h, 3); ctx.fill()
            ctx.textAlign = 'center'
            ctx.textBaseline = 'top'
            ctx.font = `600 11.5px ${SANS}`
            ctx.fillStyle = K.text
            ctx.fillText(label, j.sx, top + 3)
            ctx.font = `400 10px ${MONO}`
            ctx.fillStyle = K.sub
            ctx.fillText(ip, j.sx, top + 17)
          }
          ctx.textAlign = 'center'
          if (j.tag) {
            ctx.font = `600 9.5px ${SANS}`
            const tw = ctx.measureText(j.tag).width + 10
            const others = obstacles.filter((o) => o !== own)
            const cands = [j.b.ex > 0.5 ? j.sy - j.hh - 20 : j.sy - j.hh - 30, top + h + 2]
            const ty = cands.find((y) => {
              const r = { x0: j.sx - tw / 2, y0: y, x1: j.sx + tw / 2, y1: y + 15 }
              return !hitsRect(r, placed) && !hitsRect(r, others)
            })
            if (ty === undefined) { ctx.globalAlpha = 1; continue }
            const tr = { x0: j.sx - tw / 2, y0: ty, x1: j.sx + tw / 2, y1: ty + 15 }
            placed.push(tr)
            ctx.fillStyle = rgba(j.tagCol, 0.12)
            roundRect(ctx, tr.x0, ty, tw, 15, 7.5); ctx.fill()
            ctx.strokeStyle = rgba(j.tagCol, 0.6)
            ctx.lineWidth = 1
            ctx.stroke()
            ctx.fillStyle = j.tagCol
            ctx.textBaseline = 'middle'
            ctx.fillText(j.tag, j.sx, ty + 8)
          }
          ctx.globalAlpha = 1
        }
      }

      // -- edge labels (Kiali: throughput chip on the edge) ------------------------
      for (const ej of edgeLabelJobs.sort((a, b) => b.prio - a.prio)) {
        ctx.font = `500 10px ${SANS}`
        const tw = ctx.measureText(ej.text).width + 10
        const th = 15
        let done = false
        for (const t of [0.5, 0.4, 0.6, 0.32, 0.68, 0.24, 0.76]) {
          const cx = ej.ax + (ej.bx - ej.ax) * t
          const cy = ej.ay + (ej.by - ej.ay) * t
          const r = { x0: cx - tw / 2, y0: cy - th / 2, x1: cx + tw / 2, y1: cy + th / 2 }
          if (!ej.force && (hitsRect(r, placed) || hitsRect(r, obstacles) || hitsRect(r, fileLabels))) continue
          placed.push(r)
          ctx.globalAlpha = Math.max(0.5, ej.a)
          ctx.fillStyle = '#ffffff'
          roundRect(ctx, r.x0, r.y0, tw, th, 3); ctx.fill()
          ctx.strokeStyle = rgba(ej.col, 0.55)
          ctx.lineWidth = 1
          ctx.stroke()
          ctx.fillStyle = '#3c3f42'
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(ej.text, cx, cy + 0.5)
          ctx.globalAlpha = 1
          done = true
          break
        }
        void done
      }

      // -- issue badges ("!" / "!3"), red = critical/high, amber = medium/low ----
      {
        for (let it = 0; it < 8; it++) {
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
          const col = bj.level === 'amber' ? '#f0ab00' : K.red
          const text = bj.n > 1 ? `!${bj.n}` : '!'
          ctx.font = `700 10px ${SANS}`
          const w = Math.max(16, ctx.measureText(text).width + 9)
          ctx.globalAlpha = bj.a * (red ? 1 : bj.level === 'red' ? 0.85 + 0.15 * pulse : 1)
          ctx.fillStyle = col
          roundRect(ctx, bj.x - w / 2, bj.y - 8, w, 16, 8); ctx.fill()
          ctx.strokeStyle = '#ffffff'
          ctx.lineWidth = 1.5
          ctx.stroke()
          ctx.fillStyle = bj.level === 'amber' ? '#151515' : '#ffffff'
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

      // -- tooltips ----------------------------------------------------------------
      if (!press && mouse) {
        if (hover?.kind === 'node') {
          const b = bodies.get(hover.id)
          if (b && b.ex < 0.5) {
            const n = b.node
            const lines: { t: string; c?: string }[] = [
              { t: `${n.label}` },
              { t: `${kindOf(n.role).kind} · ${n.role} · ${n.status}` },
              { t: `${n.privateIp}  /  ${n.publicIp}` },
            ]
            if (n.status === 'running') lines.push({ t: `cpu ${Math.round(n.cpu * 100)}%  ·  mem ${fmtMem(n.memUsed, n.memTotal)}  ·  load ${n.load1}` })
            for (const r of jobsByNode.get(n.id) ?? []) if (r.active) lines.push({ t: `check ${r.type} ${Math.round(r.progress * 100)}%  ${r.note}`, c: '#73bcf7' })
            const ni = (n.issues ?? []).length
            if (ni) lines.push({ t: `${ni} issue${ni > 1 ? 's' : ''} — click for detail`, c: issueLevel(n) === 'amber' ? '#f4c145' : '#f9a8a8' })
            if (codeFor(P.codemap, n.role)) lines.push({ t: 'click to open workload detail', c: '#b8bbbe' })
            drawTooltip(lines, { x: hover.sx, y: hover.sy, r: hover.rs + 8 }, 'node')
          }
        } else if (hover?.kind === 'file') {
          const b = bodies.get(hover.id)
          const lay = b ? layoutOf(b) : null
          const f = lay?.role.files.find((x) => x.path === hover!.file)
          if (b && lay && f) {
            const ports = lay.role.ports.filter((q) => q.file === f.path).map((q) => `${q.dir} :${q.port}`)
            const imports = lay.role.edges.filter((e) => e.from === f.path).length
            const lines: { t: string; c?: string }[] = [{ t: f.path }, { t: `${f.loc} loc  ·  imports ${imports}${ports.length ? '  ·  ' + ports.join(', ') : ''}` }]
            for (const i of fileIssues(b.node, f.path).slice(0, 2)) lines.push({ t: `${i.severity}  ${i.title}`, c: (SEV_RANK[i.severity] ?? 0) >= 3 ? '#f9a8a8' : '#f4c145' })
            drawTooltip(lines, { x: hover.sx, y: hover.sy, r: hover.rs + 6 }, 'node')
          }
        } else if (hover?.kind === 'badge') {
          const b = bodies.get(hover.id)
          const src = b ? (hover.file ? fileIssues(b.node, hover.file) : b.node.issues ?? []) : []
          const iss = src.slice().sort((x, y) => (SEV_RANK[y.severity] ?? 0) - (SEV_RANK[x.severity] ?? 0))
          if (b && iss.length) {
            const lines = [{ t: `${iss[0].severity.toUpperCase()}  ${iss[0].title}`, c: (SEV_RANK[iss[0].severity] ?? 0) >= 3 ? '#f9a8a8' : '#f4c145' }]
            if (iss.length > 1) lines.push({ t: `+${iss.length - 1} more on ${b.node.label}`, c: '#d2d2d2' })
            drawTooltip(lines, { x: hover.sx, y: hover.sy, r: hover.rs + 2 }, 'node')
          }
        } else if (hoverLink) {
          const l = hoverLink
          drawTooltip([
            { t: `${l.data.protocol} :${l.data.port}  ·  ${l.data.conns} conn${l.data.conns === 1 ? '' : 's'}` },
            { t: `${l.a.node.label} → ${l.b.node.label}   ${fmtRate(l.sF)}` },
            { t: `${l.b.node.label} → ${l.a.node.label}   ${fmtRate(l.sR)}` },
          ], { x: mouse.x, y: mouse.y, r: 0 }, 'cursor')
        }
      }

      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
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

  return <canvas ref={canvasRef} className="mx-canvas" />
}
