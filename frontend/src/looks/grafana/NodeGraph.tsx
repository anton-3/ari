import { useEffect, useRef } from 'react'
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from 'd3-force'
import type { Simulation, SimulationLinkDatum, SimulationNodeDatum } from 'd3-force'
import { ACTIVE_AGENT, codeFor, fileIssues, fmtMem, fmtRate, isControl, issueLevel, roleOf } from '../../graph/GraphView'
import type { Sel } from '../../graph/GraphView'
import { loadPos, savePos, takeAlias, takePlacement } from '../../graph/positions'
import type { Agent, Codemap, CodemapRole, Fleet, FleetIssue, FleetLink, FleetNode, Metrics } from '../../graph/types'

// ---------------------------------------------------------------------------
// Grafana "Node graph" panel rendition of the fleet map. Same data/function as
// src/graph/GraphView: d3-force layout, real links, per-direction bytes/s flow,
// codemap expansion, issue badges, check jobs. Drawn the way Grafana draws its
// node graph: panel-background disc, arc ring of proportions (here: the node's
// real issue-severity mix), main stat + secondary stat inside, title/subtitle
// below; thin edges with arrowheads, a throughput label at the midpoint.
// ---------------------------------------------------------------------------

export const G = {
  canvas: '#111217',
  panel: '#181b1f',
  panel2: '#22252b',
  border: 'rgba(204,204,220,0.12)',
  border2: 'rgba(204,204,220,0.2)',
  text: '#ccccdc',
  text2: 'rgba(204,204,220,0.65)',
  text3: 'rgba(204,204,220,0.45)',
  blue: '#5794F2',
  blueText: '#6e9fff',
  green: '#73BF69',
  yellow: '#FADE2A',
  orange: '#FF9830',
  red: '#F2495C',
  purple: '#B877D9',
  edge: '#999999',
}

// Grafana classic-palette colours per protocol (edge `color` field)
export const PROTO: Record<string, string> = {
  http: '#73BF69',
  'http-app': '#73BF69',
  postgres: '#5794F2',
  redis: '#B877D9',
  ssh: '#8e8e9a',
  control: '#8e8e9a',
  other: '#8e8e9a',
}

// arc__ sections: issue severity mix
export const SEV_COLOR: Record<string, string> = { critical: '#F2495C', high: '#FF7383', medium: '#FF9830', low: '#FADE2A' }
const SEV_ORDER = ['critical', 'high', 'medium', 'low']
const SEV_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 }

// Layered, left → right (Grafana's default node-graph layout reads this way)
const TIER: Record<string, { x: number; y: number }> = {
  internet: { x: -450, y: 10 },
  controller: { x: -300, y: -115 },
  traffic: { x: -300, y: 10 },
  lb: { x: -150, y: 10 },
  app: { x: 15, y: 0 },
  worker: { x: 15, y: 130 },
  cache: { x: 185, y: -75 },
  db: { x: 185, y: 75 },
}
const tierOf = (role: string) => TIER[role] ?? { x: 0, y: 0 }

const FONT = 'Inter, "Helvetica Neue", Arial, sans-serif'
const R = 30 // node radius (world)
const LINK_GRACE_MS = 30000
const PAD = 28
const BOTTOM = 56 // legend strip + zoom buttons

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
}

interface FileLayout {
  role: CodemapRole
  entry: string
  R: number
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

type Hit = { kind: 'node' | 'badge' | 'file'; id: string; file?: string; sx: number; sy: number; rs: number }

export interface GraphCmd {
  zoom: (f: number) => void
  fit: () => void
}

interface Props {
  fleet: Fleet | null
  agents: Agent[]
  metrics: Metrics | null
  codemap: Codemap | null
  live: boolean
  reduced: boolean
  showControl: boolean
  selected: Sel | null
  focus: { id: string; n: number } | null
  onSelect: (s: Sel | null) => void
  onDropRole: (role: string, x: number, y: number) => void
  cmdRef: { current: GraphCmd | null }
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

function levelOf(issues: FleetIssue[]): Level | null {
  let top = 0
  for (const i of issues) top = Math.max(top, SEV_RANK[i.severity] ?? 1)
  return top === 0 ? null : top >= 3 ? 'red' : 'amber'
}

/** Arc sections (value sums to 1) from the real issue-severity mix. */
function arcSections(issues: FleetIssue[]): { color: string; v: number }[] {
  if (!issues.length) return []
  const c: Record<string, number> = {}
  for (const i of issues) {
    const s = SEV_ORDER.includes(i.severity) ? i.severity : 'low'
    c[s] = (c[s] ?? 0) + 1
  }
  return SEV_ORDER.filter((s) => c[s]).map((s) => ({ color: SEV_COLOR[s], v: c[s] / issues.length }))
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

function rrect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

// Codemap cluster: entry file in the centre, the rest on one ring (two if many).
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
  const fr = (loc: number) => clamp(9 + Math.sqrt(loc) / 3.4, 9, 15)
  const pos = new Map<string, { x: number; y: number; r: number }>()
  const ef = cr.files.find((f) => f.path === entry)
  pos.set(entry, { x: 0, y: 0, r: fr(ef?.loc ?? 50) })
  const inner = others.slice(0, 10)
  const outer = others.slice(10)
  const R1 = Math.max(100, (inner.length * 100) / (2 * Math.PI))
  inner.forEach((f, i) => {
    const a = -Math.PI / 2 + (i / Math.max(1, inner.length)) * Math.PI * 2
    pos.set(f.path, { x: Math.cos(a) * R1, y: Math.sin(a) * R1, r: fr(f.loc) })
  })
  const R2 = R1 + 80
  outer.forEach((f, i) => {
    const a = -Math.PI / 2 + ((i + 0.5) / Math.max(1, outer.length)) * Math.PI * 2
    pos.set(f.path, { x: Math.cos(a) * R2, y: Math.sin(a) * R2, r: fr(f.loc) })
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
  const lay = { role: cr, entry, R: (outer.length ? R2 : R1) + 44, pos, pathTo }
  layoutCache.set(key, lay)
  return lay
}

/** main stat / secondary stat, as Grafana's node graph shows them inside the circle */
function statsOf(n: FleetNode): [string, string] {
  if (n.status !== 'running') return [n.status === 'provisioning' ? 'prov…' : n.status, '']
  if (!n.memTotal) return [roleOf(n.role).glyph, '']
  return [`${(n.cpu * 100).toFixed(1)}%`, `mem ${Math.round((n.memUsed / n.memTotal) * 100)}%`]
}

// ---------------------------------------------------------------------------
export default function NodeGraph(props: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const propsRef = useRef<Props>(props)
  propsRef.current = props

  const bodiesRef = useRef(new Map<string, Body>())
  const linksRef = useRef(new Map<string, LinkR>())
  const ghostsRef = useRef<{ x: number; y: number; t: number }[]>([])
  const burstsRef = useRef<{ id: string; age: number; color: string }[]>([])
  const simRef = useRef<Simulation<Body, LinkR> | null>(null)
  const firstLayout = useRef(true)

  const collideRadius = (d: Body) => {
    const cr = d.open ? codeFor(propsRef.current.codemap, d.node.role) : null
    if (cr) return layoutFor(d.node.role, cr).R + 30
    return Math.max(R + 30, d.labelW / 2 + 10)
  }
  const collideRef = useRef(forceCollide<Body>(collideRadius).strength(1).iterations(2))

  if (!simRef.current) {
    simRef.current = forceSimulation<Body, LinkR>([])
      .force('link', forceLink<Body, LinkR>([]).id((d) => d.id).distance(150).strength(0.15))
      .force('charge', forceManyBody<Body>().strength(-380).distanceMax(380))
      .force('collide', collideRef.current)
      .force('x', forceX<Body>((d) => tierOf(d.node.role).x).strength(0.18))
      .force('y', forceY<Body>((d) => tierOf(d.node.role).y).strength(0.12))
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
        bodies.clear()
        links.clear()
        sim.nodes([])
        linkForce.links([])
      }
      return
    }

    const measure = (n: FleetNode) => Math.max(n.label.length * 6.4, n.privateIp.length * 5.8, 70)

    const place = (n: FleetNode): { x: number; y: number; pin: boolean } => {
      const drop = takePlacement(n.id)
      if (drop) return { ...drop, pin: true }
      const saved = n.id.startsWith('pending-') ? null : loadPos(n.label)
      if (saved) return { ...saved, pin: true }
      const jitter = () => (Math.random() - 0.5) * 60
      for (const l of fleet.links) {
        const other = l.source === n.id ? l.target : l.target === n.id ? l.source : null
        const ob = other ? bodies.get(other) : undefined
        if (ob) return { x: (ob.x ?? 0) + 140 * Math.sign(tierOf(n.role).x - tierOf(ob.node.role).x || 1) + jitter(), y: (ob.y ?? 0) + jitter(), pin: false }
      }
      const st = tierOf(n.role)
      return { x: st.x + jitter(), y: st.y + jitter(), pin: false }
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
      if (ic > b.lastIssueCount) burstsRef.current.push({ id: n.id, age: 0, color: issueLevel(n) === 'amber' ? G.orange : G.red })
      b.lastIssueCount = ic
      if (b.node.label !== n.label) b.labelW = measure(n)
      b.node = n
      b.pending = n.id.startsWith('pending-')
      seen.add(n.id)
    }
    for (const [id, b] of bodies) {
      if (seen.has(id)) continue
      ghostsRef.current.push({ x: b.x ?? 0, y: b.y ?? 0, t: 0 })
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
      sim.alpha(Math.max(sim.alpha(), structural ? 0.45 : 0.08))
      // first frame: settle synchronously so the map appears laid out (and a
      // deep-linked expansion starts from a settled layout)
      if (propsRef.current.reduced || firstLayout.current) sim.tick(firstLayout.current ? 300 : 240)
      firstLayout.current = false
    }
  }, [props.fleet])

  // ---- canvas loop + interaction -------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const sim = simRef.current!
    const host = canvas.parentElement!

    let W = 800
    let H = 500
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
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      const r = host.getBoundingClientRect()
      W = Math.max(50, Math.floor(r.width))
      H = Math.max(50, Math.floor(r.height))
      canvas.width = Math.floor(W * dpr)
      canvas.height = Math.floor(H * dpr)
      canvas.style.width = `${W}px`
      canvas.style.height = `${H}px`
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(host)

    const S = (x: number | undefined, y: number | undefined) => ({ x: (x ?? 0) * view.k + view.tx, y: (y ?? 0) * view.k + view.ty })
    const toWorld = (sx: number, sy: number) => ({ x: (sx - view.tx) / view.k, y: (sy - view.ty) / view.k })
    const zoomAround = (sx: number, sy: number, nk: number) => {
      const k = clamp(nk, 0.25, 4)
      view.tx = sx - ((sx - view.tx) * k) / view.k
      view.ty = sy - ((sy - view.ty) * k) / view.k
      view.k = k
    }
    propsRef.current.cmdRef.current = {
      zoom: (f) => { autoFit = false; zoomAround(W / 2, (H - BOTTOM) / 2, view.k * f) },
      fit: () => { autoFit = true },
    }
    const layoutOf = (b: Body): FileLayout | null => {
      const cr = codeFor(propsRef.current.codemap, b.node.role)
      return cr ? layoutFor(b.node.role, cr) : null
    }
    const extentOf = (b: Body) => {
      const lay = b.ex > 0.01 ? layoutOf(b) : null
      return lay ? lay.R * b.ex + R * (1 - b.ex) : R
    }

    const fitTarget = () => {
      const bodies = bodiesRef.current
      if (bodies.size === 0) return null
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      for (const b of bodies.values()) {
        const r = extentOf(b)
        const hw = Math.max(r, b.labelW / 2) + 12
        x0 = Math.min(x0, (b.x ?? 0) - hw); x1 = Math.max(x1, (b.x ?? 0) + hw)
        y0 = Math.min(y0, (b.y ?? 0) - r - 22); y1 = Math.max(y1, (b.y ?? 0) + r + 40)
      }
      const aw = Math.max(200, W - PAD * 2)
      const ah = Math.max(160, H - PAD - BOTTOM)
      const k = clamp(Math.min(aw / (x1 - x0), ah / (y1 - y0)), 0.3, 1.6)
      return { k, tx: PAD + aw / 2 - ((x0 + x1) / 2) * k, ty: PAD + ah / 2 - ((y0 + y1) / 2) * k }
    }

    // When a node is expanded, its real link attaches to the file that owns the port.
    const endPos = (b: Body, l: LinkR, outgoing: boolean) => {
      const base = S(b.x, b.y)
      const lay = b.ex >= 0.01 ? layoutOf(b) : null
      if (!lay) return { ...base, r: R * view.k, file: null as string | null }
      const dir = outgoing ? 'out' : 'in'
      const pe = lay.role.ports.find((p) => p.port === l.data.port && p.dir === dir) ?? lay.role.ports.find((p) => p.port === l.data.port)
      const fp = pe ? lay.pos.get(pe.file) : undefined
      if (!pe || !fp) return { ...base, r: R * view.k * (1 - 0.85 * b.ex), file: null }
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
        if (Math.hypot(x - h.sx, y - h.sy) <= h.rs + 4) return h
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

    // ---- drawing helpers -----------------------------------------------------------
    // Grafana's node: panel-coloured disc + arc ring of sections (sum to 1).
    const drawGNode = (sx: number, sy: number, rs: number, sections: { color: string; v: number }[], fallback: string, a: number) => {
      const sw = Math.max(1.5, Math.ceil(rs * 0.075 * 1.3))
      ctx.globalAlpha = a
      ctx.fillStyle = G.panel
      ctx.beginPath(); ctx.arc(sx, sy, rs, 0, Math.PI * 2); ctx.fill()
      ctx.lineWidth = sw
      if (!sections.length) {
        ctx.strokeStyle = fallback
        ctx.beginPath(); ctx.arc(sx, sy, rs, 0, Math.PI * 2); ctx.stroke()
      } else {
        let acc = 0
        for (const s of sections) {
          const a0 = -Math.PI / 2 + acc * Math.PI * 2
          const a1 = -Math.PI / 2 + Math.min(1, acc + s.v) * Math.PI * 2
          ctx.strokeStyle = s.color
          ctx.beginPath(); ctx.arc(sx, sy, rs, a0, a1); ctx.stroke()
          acc += s.v
        }
      }
      ctx.globalAlpha = 1
    }
    const textBg = (s: string, x: number, y: number, h: number, a: number) => {
      const w = ctx.measureText(s).width
      ctx.fillStyle = `rgba(17,18,23,${0.6 * a})`
      ctx.fillRect(x - w / 2 - 3, y - 1, w + 6, h)
    }

    // Moving dashes per direction: density + speed from bytes/s on a log scale.
    const intensity = (bps: number) => clamp(Math.log10(1 + bps / 1024) / 3.5, 0, 1)
    const laneSpeed = (bps: number) => (bps < 1 ? 0 : 10 + 36 * intensity(bps))
    const flowLane = (ax: number, ay: number, bx: number, by: number, bps: number, col: string, phase: number, alpha: number, off: number) => {
      if (bps < 1) return
      const it = intensity(bps)
      const dx = bx - ax, dy = by - ay
      const dl = Math.hypot(dx, dy) || 1
      const ox = (-dy / dl) * off, oy = (dx / dl) * off
      ctx.setLineDash([5, 22 - 12 * it])
      ctx.lineDashOffset = -phase
      ctx.lineCap = 'round'
      ctx.lineWidth = 1.5
      ctx.strokeStyle = rgba(col, (0.5 + 0.45 * it) * alpha)
      ctx.beginPath(); ctx.moveTo(ax + ox, ay + oy); ctx.lineTo(bx + ox, by + oy); ctx.stroke()
      ctx.setLineDash([])
      ctx.lineDashOffset = 0
      ctx.lineCap = 'butt'
    }
    const arrowHead = (x: number, y: number, ux: number, uy: number, size: number, col: string) => {
      ctx.fillStyle = col
      ctx.beginPath()
      ctx.moveTo(x, y)
      ctx.lineTo(x - ux * size - uy * size * 0.45, y - uy * size + ux * size * 0.45)
      ctx.lineTo(x - ux * size + uy * size * 0.45, y - uy * size - ux * size * 0.45)
      ctx.closePath()
      ctx.fill()
    }

    // Grafana tooltip / context-menu card
    const drawTooltip = (title: string, rows: { k: string; v: string; c?: string }[], anchor: { x: number; y: number; r: number }, side: 'node' | 'cursor') => {
      ctx.font = `500 12px ${FONT}`
      const maxW = Math.min(360, W - 16)
      const tw = ctx.measureText(title).width
      ctx.font = `400 12px ${FONT}`
      const kw = Math.max(0, ...rows.map((r) => ctx.measureText(r.k).width))
      const vw = Math.max(0, ...rows.map((r) => ctx.measureText(r.v).width))
      const w = Math.min(maxW, Math.max(tw, kw + vw + (kw ? 18 : 0)) + 20)
      const h = 30 + rows.length * 19 + 6
      let x: number, y: number
      if (side === 'node') {
        x = anchor.x + anchor.r + 12
        if (x + w > W - 6) x = anchor.x - anchor.r - 12 - w
        y = anchor.y - h / 2
      } else {
        x = anchor.x + 14; y = anchor.y + 14
        if (x + w > W - 6) x = anchor.x - 14 - w
        if (y + h > H - 6) y = anchor.y - 14 - h
      }
      x = clamp(x, 6, W - 6 - w)
      y = clamp(y, 6, H - 6 - h)
      ctx.shadowColor = 'rgba(0,0,0,0.6)'
      ctx.shadowBlur = 16
      ctx.shadowOffsetY = 4
      ctx.fillStyle = G.panel2
      rrect(ctx, x, y, w, h, 4); ctx.fill()
      ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0
      ctx.strokeStyle = G.border2
      ctx.lineWidth = 1
      rrect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 4); ctx.stroke()
      ctx.fillStyle = G.border
      ctx.fillRect(x, y + 28, w, 1)
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      ctx.font = `500 12px ${FONT}`
      ctx.fillStyle = G.text
      ctx.fillText(truncate(ctx, title, w - 20), x + 10, y + 15)
      ctx.font = `400 12px ${FONT}`
      rows.forEach((r, i) => {
        const ry = y + 40 + i * 19
        ctx.fillStyle = G.text2
        ctx.fillText(r.k, x + 10, ry)
        ctx.fillStyle = r.c ?? G.text
        ctx.textAlign = r.k ? 'right' : 'left'
        ctx.fillText(truncate(ctx, r.v, w - 28 - (r.k ? kw : 0)), r.k ? x + w - 10 : x + 10, ry)
        ctx.textAlign = 'left'
      })
    }

    // ---- frame --------------------------------------------------------------------
    let raf = 0
    let last = performance.now()
    const frame = (now: number) => {
      const dt = Math.min(0.25, Math.max(0, (now - last) / 1000))
      last = now
      const P = propsRef.current
      const red = P.reduced
      const bodies = bodiesRef.current
      const links = linksRef.current
      const k = view.k
      const sel = P.selected
      const fz = clamp(k, 0.8, 1.25) // font scale

      const want = sel?.kind === 'node' && bodies.has(sel.id) && codeFor(P.codemap, bodies.get(sel.id)!.node.role) ? sel.id : null
      if (want !== expandedId) {
        expandedId = want
        for (const b of bodies.values()) b.open = b.id === want
        collideRef.current.radius(collideRadius)
        // make room for the opened cluster: shift the other tiers outwards
        const eb = want ? bodies.get(want) : undefined
        const ecr = eb ? codeFor(P.codemap, eb.node.role) : null
        const Rc = eb && ecr ? layoutFor(eb.node.role, ecr).R : 0
        const exT = eb ? tierOf(eb.node.role) : { x: 0, y: 0 }
        const fx = sim.force('x') as ReturnType<typeof forceX<Body>>
        const fy = sim.force('y') as ReturnType<typeof forceY<Body>>
        fx.x((d) => {
          const t = tierOf(d.node.role).x
          if (!eb || d === eb) return t
          return t + (t > exT.x + 1 ? Rc * 1.3 : t < exT.x - 1 ? -Rc * 1.1 : 0)
        })
        fy.y((d) => {
          const t = tierOf(d.node.role).y
          if (!eb || d === eb || Math.abs(tierOf(d.node.role).x - exT.x) > 1) return t
          const side = Math.sign(t - exT.y) || Math.sign((d.y ?? 0) - (eb.y ?? 0)) || 1
          return exT.y + side * (Rc + R + 40)
        })
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
        const t = red ? 1 : 1 - Math.exp(-dt * 6)
        const tx = W / 2 - panTo.x * view.k
        const ty = (H - BOTTOM) / 2 - panTo.y * view.k
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
      ctx.clearRect(0, 0, W, H)

      const newHits: Hit[] = []
      const errTint = P.metrics ? clamp(P.metrics.errorRate / 10, 0, 0.6) : 0

      // hover focus (Grafana dims everything not connected to the hovered node)
      const hovNode = hover?.kind === 'node' && !press ? hover.id : null
      const adj = new Set<string>()
      if (hovNode) {
        adj.add(hovNode)
        for (const l of links.values()) if (l.present && (l.a.id === hovNode || l.b.id === hovNode)) { adj.add(l.a.id); adj.add(l.b.id) }
      }
      const dimOf = (b: Body) => (1 - 0.55 * Math.max(0, dimAll - b.ex)) * (hovNode && !adj.has(b.id) ? 0.5 : 1)

      // -- check jobs per node -------------------------------------------------
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

      // -- edges ---------------------------------------------------------------
      const nextVisible = new Set<LinkR>()
      const edgeLabels: { x: number; y: number; t: string; a: number; prio: number; col: string }[] = []
      for (const l of links.values()) {
        const s = 1 - Math.exp(-dt / 1.2)
        l.sF += (Math.max(0, l.data.bytesPerSec) - l.sF) * s
        l.sR += (Math.max(0, l.data.bytesPerSecReverse) - l.sR) * s
        if (!red) {
          l.phF += laneSpeed(l.sF) * dt
          l.phR += laneSpeed(l.sR) * dt
        }
        if (!l.present) continue
        const col = PROTO[l.data.protocol] ?? PROTO.other
        const control = isControl(l.data.protocol)
        const isSel = sel?.kind === 'link' && sel.id === l.id
        const ctlLink = control && (l.a.node.role === 'controller' || l.b.node.role === 'controller')
        if (ctlLink && !P.showControl && !isSel) {
          const focusId = (id: string) => hover?.id === id || (sel?.kind === 'node' && sel.id === id) || jobsByNode.has(id)
          if (!focusId(l.a.id) && !focusId(l.b.id)) continue
        }
        nextVisible.add(l)
        const A0 = endPos(l.a, l, true)
        const B0 = endPos(l.b, l, false)
        const dx = B0.x - A0.x, dy = B0.y - A0.y
        const dl = Math.hypot(dx, dy) || 1
        const ux = dx / dl, uy = dy / dl
        const ah = 7 + (isSel ? 2 : 0)
        const A = { x: A0.x + ux * (A0.r + 3), y: A0.y + uy * (A0.r + 3) }
        const B = { x: B0.x - ux * (B0.r + 3), y: B0.y - uy * (B0.r + 3) }
        if (dl < A0.r + B0.r + ah + 8) continue
        const isHov = hoverLink === l
        const da = Math.min(dimOf(l.a), dimOf(l.b))
        const base = control ? G.edge : col
        ctx.globalAlpha = da
        ctx.lineWidth = 1 + (isSel || isHov ? 1 : 0)
        ctx.strokeStyle = rgba(base, control ? 0.4 : isSel || isHov ? 0.9 : 0.5)
        ctx.setLineDash(control ? [4, 4] : [])
        ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x - ux * ah, B.y - uy * ah); ctx.stroke()
        ctx.setLineDash([])
        arrowHead(B.x, B.y, ux, uy, ah, rgba(base, control ? 0.6 : isSel || isHov ? 1 : 0.8))
        ctx.globalAlpha = 1
        if (!control) {
          const http = l.data.protocol === 'http' || l.data.protocol === 'http-app'
          const fcol = http && errTint > 0 ? mix(col, G.red, errTint) : col
          flowLane(A.x, A.y, B.x - ux * ah, B.y - uy * ah, l.sF, mix(fcol, '#ffffff', 0.25), l.phF, da, 2.5)
          flowLane(B.x - ux * ah, B.y - uy * ah, A.x, A.y, l.sR, mix(col, '#ffffff', 0.25), l.phR, da, 2.5)
          if (k > 0.45) edgeLabels.push({ x: (A.x + B.x) / 2, y: (A.y + B.y) / 2, t: fmtRate(l.sF + l.sR), a: da, prio: (isSel || isHov ? 1e12 : 0) + l.sF + l.sR, col })
        }
      }
      visibleLinks = nextVisible

      // -- ghosts ----------------------------------------------------------------
      for (let i = ghostsRef.current.length - 1; i >= 0; i--) {
        const g = ghostsRef.current[i]
        g.t += dt / 0.8
        if (g.t >= 1) { ghostsRef.current.splice(i, 1); continue }
        const p = S(g.x, g.y)
        drawGNode(p.x, p.y, R * k * (1 - 0.3 * g.t), [], 'rgba(204,204,220,0.4)', 0.5 * (1 - g.t))
      }

      // -- nodes --------------------------------------------------------------------
      const order = [...bodies.values()].sort((a, b) => a.ex - b.ex)
      const labelJobs: { b: Body; sx: number; sy: number; rs: number; a: number; prio: number }[] = []
      const badgeJobs: { id: string; file?: string; x: number; y: number; level: Level; n: number; a: number }[] = []
      const circles: { id: string; x: number; y: number; r: number }[] = []
      const fileRects: { x0: number; y0: number; x1: number; y1: number }[] = []
      for (const b of order) {
        const n = b.node
        const p = S(b.x, b.y)
        const rs0 = Math.max(10, R * k)
        const level = issueLevel(n)
        const nIssues = (n.issues ?? []).length
        const statusA = n.status === 'deleting' ? 0.3 : n.status === 'provisioning' || n.status === 'booting' ? 0.6 : 1
        b.alpha += (statusA - b.alpha) * (1 - Math.exp(-dt * 4))
        const dim = dimOf(b)
        const a = b.alpha * dim
        if (p.x < -400 || p.y < -400 || p.x > W + 400 || p.y > H + 400) continue
        const lay = b.ex > 0 ? layoutOf(b) : null
        const containerR = lay ? lay.R * k : rs0
        const rs = rs0 * (1 - 0.85 * b.ex)
        const hitR = lay && b.ex > 0.5 ? containerR : rs0
        const anchorR = b.ex > 0.01 && lay ? containerR * b.ex + rs0 * (1 - b.ex) : rs0
        circles.push({ id: b.id, x: p.x, y: p.y, r: b.ex > 0.5 ? rs + 2 : rs0 + 3 })

        if (lay && b.ex > 0.01) {
          const e = b.ex
          // group boundary: Grafana-ish dashed container + header text
          ctx.globalAlpha = e
          ctx.strokeStyle = 'rgba(110,159,255,0.35)'
          ctx.lineWidth = 1
          ctx.setLineDash([4, 4])
          ctx.beginPath(); ctx.arc(p.x, p.y, anchorR, 0, Math.PI * 2); ctx.stroke()
          ctx.setLineDash([])
          ctx.fillStyle = 'rgba(87,148,242,0.035)'
          ctx.beginPath(); ctx.arc(p.x, p.y, anchorR, 0, Math.PI * 2); ctx.fill()
          ctx.globalAlpha = 1
          const fpos = (path: string) => {
            const f = lay.pos.get(path)
            return f ? { x: p.x + f.x * e * k, y: p.y + f.y * e * k, r: f.r * k * (0.4 + 0.6 * e) } : null
          }
          // import edges: thin grey with arrowheads (importer → imported)
          for (const ed of lay.role.edges) {
            const A = fpos(ed.from), B = fpos(ed.to)
            if (!A || !B) continue
            const dx = B.x - A.x, dy = B.y - A.y
            const dl = Math.hypot(dx, dy) || 1
            const ux = dx / dl, uy = dy / dl
            if (dl < A.r + B.r + 10) continue
            ctx.globalAlpha = e
            ctx.strokeStyle = 'rgba(153,153,153,0.45)'
            ctx.lineWidth = 1
            ctx.beginPath(); ctx.moveTo(A.x + ux * (A.r + 2), A.y + uy * (A.r + 2)); ctx.lineTo(B.x - ux * (B.r + 8), B.y - uy * (B.r + 8)); ctx.stroke()
            arrowHead(B.x - ux * (B.r + 2), B.y - uy * (B.r + 2), ux, uy, 6, 'rgba(153,153,153,0.7)')
            ctx.globalAlpha = 1
          }
          // entry → port-file import paths lit by that link's real rate
          for (const l of links.values()) {
            const outgoing = l.a === b
            if (!l.present || (!outgoing && l.b !== b)) continue
            const pe = lay.role.ports.find((q) => q.port === l.data.port && q.dir === (outgoing ? 'out' : 'in'))
            if (!pe) continue
            const it = intensity(l.sF + l.sR)
            if (it <= 0.01) continue
            const pc = PROTO[l.data.protocol] ?? PROTO.other
            for (const [f, t] of lay.pathTo.get(pe.file) ?? []) {
              const A = fpos(f), B = fpos(t)
              if (!A || !B) continue
              ctx.globalAlpha = e
              ctx.strokeStyle = rgba(pc, 0.2 + 0.45 * it)
              ctx.lineWidth = 1 + 1.2 * it
              ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke()
              ctx.globalAlpha = 1
            }
          }
          // file nodes
          for (const f of lay.role.files) {
            const fp = fpos(f.path)
            if (!fp) continue
            const fi = fileIssues(n, f.path)
            const fl = levelOf(fi)
            drawGNode(fp.x, fp.y, fp.r, arcSections(fi), G.green, e)
            circles.push({ id: `${b.id}|${f.path}`, x: fp.x, y: fp.y, r: fp.r + 2 })
            if (fp.r > 9 && e > 0.6) {
              ctx.globalAlpha = e
              ctx.font = `500 ${Math.round(clamp(fp.r * 0.62, 8, 11))}px ${FONT}`
              ctx.fillStyle = G.text
              ctx.textAlign = 'center'
              ctx.textBaseline = 'middle'
              ctx.fillText(String(f.loc), fp.x, fp.y + 0.5)
              ctx.globalAlpha = 1
            }
            const isF = sel?.kind === 'node' && sel.id === b.id && sel.file === f.path
            const isH = hover?.kind === 'file' && hover.id === b.id && hover.file === f.path
            if (isF || isH) {
              ctx.strokeStyle = rgba(G.blueText, isF ? 0.95 : 0.5)
              ctx.lineWidth = 2
              ctx.beginPath(); ctx.arc(fp.x, fp.y, fp.r + 5, 0, Math.PI * 2); ctx.stroke()
            }
            if (e > 0.6) {
              ctx.globalAlpha = (e - 0.6) / 0.4
              ctx.font = `400 ${Math.round(11 * fz)}px ${FONT}`
              const vx = fp.x - p.x, vy = fp.y - p.y
              const vl = Math.hypot(vx, vy)
              let lx = fp.x, ly = fp.y + fp.r + 5
              ctx.textAlign = 'center'
              ctx.textBaseline = 'top'
              if (vl > 1) {
                const ux = vx / vl, uy = vy / vl
                lx = fp.x + ux * (fp.r + 7)
                ly = fp.y + uy * (fp.r + 7)
                ctx.textAlign = ux > 0.35 ? 'left' : ux < -0.35 ? 'right' : 'center'
                ctx.textBaseline = uy > 0.35 ? 'top' : uy < -0.35 ? 'bottom' : 'middle'
              }
              ctx.fillStyle = G.text
              ctx.fillText(f.label, lx, ly)
              {
                const fw = ctx.measureText(f.label).width
                const fh = 13 * fz
                const x0 = ctx.textAlign === 'left' ? lx : ctx.textAlign === 'right' ? lx - fw : lx - fw / 2
                const y0 = ctx.textBaseline === 'top' ? ly : ctx.textBaseline === 'bottom' ? ly - fh : ly - fh / 2
                fileRects.push({ x0: x0 - 2, y0: y0 - 1, x1: x0 + fw + 2, y1: y0 + fh + 1 })
              }
              ctx.fillStyle = G.text3
              ctx.font = `400 ${Math.round(10 * fz)}px ${FONT}`
              const ports = lay.role.ports.filter((q) => q.file === f.path).map((q) => `${q.dir} :${q.port}`).join(' · ')
              if (ports) ctx.fillText(ports, lx, ly + (ctx.textBaseline === 'bottom' ? -14 : 14) * fz)
              ctx.globalAlpha = 1
            }
            if (e > 0.5) newHits.push({ kind: 'file', id: b.id, file: f.path, sx: fp.x, sy: fp.y, rs: Math.max(fp.r, 7) })
            if (fl && e > 0.5) {
              const vx = fp.x - p.x, vy = fp.y - p.y
              const vl = Math.hypot(vx, vy)
              const bx = vl > 1 ? fp.x + (-vy / vl) * (fp.r + 11) : fp.x + fp.r * 0.75 + 9
              const by = vl > 1 ? fp.y + (vx / vl) * (fp.r + 11) : fp.y - fp.r * 0.75 - 9
              badgeJobs.push({ id: b.id, file: f.path, x: bx, y: by, level: fl, n: fi.length, a: e })
            }
          }
        }

        // the server node itself (fades into its files while expanded)
        if (rs > 2) {
          const nodeA = a * (1 - 0.75 * b.ex)
          const running = n.status === 'running'
          const sections = running ? arcSections(n.issues ?? []) : []
          const fallback = n.status === 'offline' ? G.red : running ? G.green : 'rgba(204,204,220,0.35)'
          drawGNode(p.x, p.y, rs, sections, fallback, nodeA)
          if (b.ex < 0.3 && rs >= 13) {
            const [main, second] = statsOf(n)
            ctx.globalAlpha = nodeA
            ctx.textAlign = 'center'
            ctx.textBaseline = 'middle'
            ctx.fillStyle = G.text
            ctx.font = `500 ${Math.round(clamp(rs * 0.42, 9, 13))}px ${FONT}`
            const two = !!second && rs >= 21
            ctx.fillText(main, p.x, p.y + (two ? -rs * 0.2 : 0.5))
            if (two) {
              ctx.font = `400 ${Math.round(clamp(rs * 0.33, 8, 11))}px ${FONT}`
              ctx.fillStyle = G.text2
              ctx.fillText(second, p.x, p.y + rs * 0.3)
            }
            ctx.globalAlpha = 1
          }
        }

        // boot progress ring
        const ringR = anchorR + 6
        if (n.status === 'provisioning' || n.status === 'booting') {
          const t = (now - b.bootStart) / 1000
          const prog = n.status === 'provisioning' ? 0.4 * (1 - Math.exp(-t / 3)) : 0.4 + 0.55 * (1 - Math.exp(-t / 5))
          ctx.strokeStyle = 'rgba(204,204,220,0.12)'
          ctx.lineWidth = 2
          ctx.beginPath(); ctx.arc(p.x, p.y, ringR, 0, Math.PI * 2); ctx.stroke()
          ctx.strokeStyle = G.blue
          ctx.beginPath(); ctx.arc(p.x, p.y, ringR, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * prog); ctx.stroke()
        }
        // running check jobs: thin blue arc per job (length = progress)
        const jobs = jobsByNode.get(b.id) ?? []
        jobs.forEach((r, i) => {
          const rr = ringR + 4 + i * 4
          const end = -Math.PI / 2 + Math.PI * 2 * Math.max(0.06, r.progress)
          ctx.globalAlpha = r.alpha * dim
          ctx.strokeStyle = G.blueText
          ctx.lineWidth = 2
          ctx.lineCap = 'round'
          ctx.beginPath(); ctx.arc(p.x, p.y, rr, -Math.PI / 2, end); ctx.stroke()
          ctx.lineCap = 'butt'
          ctx.globalAlpha = 1
        })
        const tag = n.status === 'provisioning' || n.status === 'booting' || n.status === 'deleting' || n.status === 'offline' ? n.status : ''
        if (tag) {
          ctx.font = `500 ${Math.round(10 * fz)}px ${FONT}`
          ctx.textAlign = 'center'
          ctx.textBaseline = 'bottom'
          const ty = p.y - ringR - 6 - jobs.length * 4
          const tw = ctx.measureText(tag).width + 10
          ctx.fillStyle = n.status === 'offline' || n.status === 'deleting' ? 'rgba(242,73,92,0.18)' : 'rgba(87,148,242,0.18)'
          rrect(ctx, p.x - tw / 2, ty - 15, tw, 15, 2); ctx.fill()
          ctx.fillStyle = n.status === 'offline' || n.status === 'deleting' ? G.red : G.blueText
          ctx.fillText(tag, p.x, ty - 2)
        }

        const isSel = sel?.kind === 'node' && sel.id === b.id
        const isHov = hover?.kind === 'node' && hover.id === b.id
        if ((isSel || isHov) && b.ex < 0.3) {
          // Grafana hover ring: accent text colour inside the arc
          ctx.strokeStyle = rgba(G.blueText, isSel ? 0.9 : 0.5)
          ctx.lineWidth = Math.max(2, Math.ceil(rs * 0.075 * 1.3))
          ctx.beginPath(); ctx.arc(p.x, p.y, rs - ctx.lineWidth * 1.5, 0, Math.PI * 2); ctx.stroke()
          if (isSel) {
            ctx.lineWidth = 1
            ctx.beginPath(); ctx.arc(p.x, p.y, rs + 5, 0, Math.PI * 2); ctx.stroke()
          }
        }

        newHits.splice(newHits.length - (lay && b.ex > 0.5 ? lay.role.files.length : 0), 0, { kind: 'node', id: b.id, sx: p.x, sy: p.y, rs: hitR })
        labelJobs.push({ b, sx: p.x, sy: p.y, rs: anchorR, a, prio: (isSel || isHov ? 100 : 0) + roleOf(n.role).weight + (level ? 3 : 0) })
        if (nIssues > 0 && level) badgeJobs.push({ id: b.id, x: p.x + anchorR * 0.74 + 11, y: p.y - anchorR * 0.74 - 11, level, n: nIssues, a: dim })
      }

      // -- new-issue pulse ------------------------------------------------------------
      for (let i = burstsRef.current.length - 1; i >= 0; i--) {
        const bu = burstsRef.current[i]
        bu.age += dt
        const b = bodies.get(bu.id)
        if (bu.age >= 0.9 || !b || red) { burstsRef.current.splice(i, 1); continue }
        const t = bu.age / 0.9
        const p = S(b.x, b.y)
        ctx.globalAlpha = (1 - t) * 0.7
        ctx.strokeStyle = bu.color
        ctx.lineWidth = 1.5
        ctx.beginPath(); ctx.arc(p.x, p.y, R * k + 6 + t * 26, 0, Math.PI * 2); ctx.stroke()
        ctx.globalAlpha = 1
      }

      // -- title + subtitle below each node (collision pass) ----------------------
      type Rect = { x0: number; y0: number; x1: number; y1: number }
      const placed: Rect[] = [...fileRects]
      const overlaps = (r: Rect, ownId: string) => {
        for (const q of placed) if (r.x0 < q.x1 && r.x1 > q.x0 && r.y0 < q.y1 && r.y1 > q.y0) return true
        for (const c of circles) {
          if (c.id === ownId || c.id.startsWith(ownId + '|')) continue
          const nx = clamp(c.x, r.x0, r.x1), ny = clamp(c.y, r.y0, r.y1)
          if (Math.hypot(c.x - nx, c.y - ny) < c.r) return true
        }
        return false
      }
      for (const j of labelJobs.sort((a, b) => b.prio - a.prio)) {
        const n = j.b.node
        const f1 = Math.round(12 * fz), f2 = Math.round(11 * fz)
        ctx.font = `500 ${f1}px ${FONT}`
        const label = truncate(ctx, n.label, 160)
        const lw = ctx.measureText(label).width
        ctx.font = `400 ${f2}px ${FONT}`
        const sub = n.privateIp !== '—' ? n.privateIp : n.role
        const iw = ctx.measureText(sub).width
        const w = Math.max(lw, iw)
        const h = f1 + f2 + 6
        // Grafana puts title/subtitle below the node; fall back to above, then right
        const cands = [
          { x: j.sx, top: j.sy + j.rs + 6 },
          { x: j.sx, top: j.sy - j.rs - 8 - h },
          { x: j.sx + j.rs + 10 + w / 2, top: j.sy - h / 2 },
          { x: j.sx - j.rs - 10 - w / 2, top: j.sy - h / 2 },
        ]
        let pick: { x: number; top: number } | null = null
        let rect = { x0: 0, y0: 0, x1: 0, y1: 0 }
        for (const c of cands) {
          rect = { x0: c.x - w / 2 - 4, y0: c.top - 1, x1: c.x + w / 2 + 4, y1: c.top + h }
          if (j.prio >= 100 || !overlaps(rect, j.b.id)) { pick = c; break }
        }
        if (!pick) continue
        const top = pick.top
        j.sx = pick.x
        placed.push(rect)
        const a = Math.max(0.5, j.a)
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        ctx.font = `500 ${f1}px ${FONT}`
        textBg(label, j.sx, top, f1 + 3, a)
        ctx.fillStyle = rgba('#ccccdc', a)
        ctx.fillText(label, j.sx, top)
        ctx.font = `400 ${f2}px ${FONT}`
        ctx.fillStyle = `rgba(204,204,220,${0.6 * a})`
        ctx.fillText(sub, j.sx, top + f1 + 3)
      }

      // -- edge throughput labels at the midpoint ----------------------------------
      for (const el of edgeLabels.sort((a, b) => b.prio - a.prio)) {
        ctx.font = `500 ${Math.round(10 * fz)}px ${FONT}`
        const w = ctx.measureText(el.t).width + 8
        const h = Math.round(10 * fz) + 6
        const rect = { x0: el.x - w / 2, y0: el.y - h / 2, x1: el.x + w / 2, y1: el.y + h / 2 }
        if (el.prio < 1e12 && overlaps(rect, '')) continue
        placed.push(rect)
        ctx.globalAlpha = el.a
        ctx.fillStyle = 'rgba(17,18,23,0.88)'
        rrect(ctx, rect.x0, rect.y0, w, h, 2); ctx.fill()
        ctx.strokeStyle = rgba(el.col, 0.35)
        ctx.lineWidth = 1
        rrect(ctx, rect.x0 + 0.5, rect.y0 + 0.5, w - 1, h - 1, 2); ctx.stroke()
        ctx.fillStyle = G.text
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(el.t, el.x, el.y + 0.5)
        ctx.globalAlpha = 1
      }

      // -- issue badges: one per node/file, count when >1, pushed apart ----------
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
        const col = bj.level === 'amber' ? G.orange : G.red
        const text = bj.n > 1 ? `!${bj.n}` : '!'
        ctx.font = `600 10px ${FONT}`
        const w = Math.max(17, ctx.measureText(text).width + 10)
        ctx.globalAlpha = bj.a
        ctx.fillStyle = col
        rrect(ctx, bj.x - w / 2, bj.y - 8, w, 16, 8); ctx.fill()
        ctx.fillStyle = bj.level === 'amber' ? '#111217' : '#ffffff'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(text, bj.x, bj.y + 0.5)
        ctx.globalAlpha = 1
        newHits.push({ kind: 'badge', id: bj.id, file: bj.file, sx: bj.x, sy: bj.y, rs: w / 2 })
      }
      hits = newHits
      if (hoverLink && !visibleLinks.has(hoverLink)) hoverLink = null
      if (hover) {
        const h = hover
        hover = hits.find((x) => x.kind === h.kind && x.id === h.id && x.file === h.file) ?? null
      }

      // -- tooltips ---------------------------------------------------------------
      if (!press && mouse) {
        if (hover?.kind === 'node') {
          const b = bodies.get(hover.id)
          if (b) {
            const n = b.node
            const rows: { k: string; v: string; c?: string }[] = [
              { k: 'role', v: `${n.role} · ${n.status}` },
              { k: 'private / public', v: `${n.privateIp} / ${n.publicIp}` },
              { k: 'linode', v: `${n.region} · ${n.type}` },
            ]
            if (n.status === 'running' && n.memTotal) {
              rows.push({ k: 'cpu', v: `${(n.cpu * 100).toFixed(1)}%  ·  load ${n.load1}` })
              rows.push({ k: 'mem', v: fmtMem(n.memUsed, n.memTotal) })
            }
            for (const pr of n.processes.slice(0, 3)) rows.push({ k: pr.name, v: pr.ports.length ? ':' + pr.ports.join(',') : '—' })
            if (n.processes.length > 3) rows.push({ k: '', v: `+${n.processes.length - 3} more processes`, c: G.text2 })
            for (const r of jobsByNode.get(n.id) ?? []) if (r.active) rows.push({ k: `check ${r.type}`, v: `${Math.round(r.progress * 100)}% ${r.note}`, c: G.blueText })
            const ni = (n.issues ?? []).length
            if (ni) rows.push({ k: 'issues', v: `${ni} open`, c: issueLevel(n) === 'amber' ? G.orange : G.red })
            if (codeFor(P.codemap, n.role) && b.ex < 0.5) rows.push({ k: '', v: 'Click to expand into files', c: G.blueText })
            drawTooltip(n.label, rows, { x: hover.sx, y: hover.sy, r: hover.rs + 8 }, 'node')
          }
        } else if (hover?.kind === 'file') {
          const b = bodies.get(hover.id)
          const lay = b ? layoutOf(b) : null
          const f = lay?.role.files.find((x) => x.path === hover!.file)
          if (b && lay && f) {
            const ports = lay.role.ports.filter((q) => q.file === f.path).map((q) => `${q.dir} :${q.port}`)
            const imports = lay.role.edges.filter((e) => e.from === f.path).length
            const rows: { k: string; v: string; c?: string }[] = [{ k: 'loc', v: String(f.loc) }, { k: 'imports', v: String(imports) }]
            if (ports.length) rows.push({ k: 'ports', v: ports.join(', ') })
            for (const i of fileIssues(b.node, f.path).slice(0, 3)) rows.push({ k: i.severity, v: i.title, c: (SEV_RANK[i.severity] ?? 0) >= 3 ? G.red : G.orange })
            drawTooltip(f.path, rows, { x: hover.sx, y: hover.sy, r: hover.rs + 6 }, 'node')
          }
        } else if (hover?.kind === 'badge') {
          const b = bodies.get(hover.id)
          const src = b ? (hover.file ? fileIssues(b.node, hover.file) : b.node.issues ?? []) : []
          const iss = src.slice().sort((x, y) => (SEV_RANK[y.severity] ?? 0) - (SEV_RANK[x.severity] ?? 0))
          if (b && iss.length) {
            const rows = iss.slice(0, 4).map((i) => ({ k: i.severity, v: i.title, c: (SEV_RANK[i.severity] ?? 0) >= 3 ? G.red : G.orange }))
            if (iss.length > 4) rows.push({ k: '', v: `+${iss.length - 4} more`, c: G.text2 })
            drawTooltip(`${b.node.label}${hover.file ? ' · ' + hover.file.split('/').pop() : ''}`, rows, { x: hover.sx, y: hover.sy, r: hover.rs + 2 }, 'node')
          }
        } else if (hoverLink) {
          const l = hoverLink
          drawTooltip(`${l.data.protocol} :${l.data.port}`, [
            { k: 'connections', v: String(l.data.conns) },
            { k: `${l.a.node.label} →`, v: fmtRate(l.sF) },
            { k: `← ${l.b.node.label}`, v: fmtRate(l.sR) },
          ], { x: mouse.x, y: mouse.y, r: 0 }, 'cursor')
        }
      }

      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      propsRef.current.cmdRef.current = null
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

  return <canvas ref={canvasRef} className="gf-canvas" />
}
