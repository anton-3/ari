import { useEffect, useRef } from 'react'
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from 'd3-force'
import type { Simulation, SimulationLinkDatum, SimulationNodeDatum } from 'd3-force'
import { loadPos, savePos, takeAlias, takePlacement } from './positions'
import type { Agent, Codemap, CodemapRole, Fleet, FleetLink, FleetNode, Metrics } from './types'
import { ACTIVE_AGENT, codeFor, fileIssues, fmtMem, fmtRate, isControl, issueLevel, levelOf } from './helpers'
import type { Level, Sel } from './helpers'

// Helpers now live in ./helpers; re-exported so existing imports keep working.
export { ACTIVE_AGENT, codeFor, fileIssues, fmtMem, fmtRate, isControl, issueLevel }
export type { Sel }

// ---------------------------------------------------------------------------
// Fleet map. Genuinely 2D (d3-force, top-down). Depth comes only from
// rendering: lit spheres + elevation-driven shadows + a faint parallax grid.
// Every mark maps to fleet data — servers, real links, real issues, real jobs.
// ---------------------------------------------------------------------------


const C = {
  bg: '#060607',
  acc: '#59c9a5',
  red: '#ff5550',
  amber: '#e0a63a',
  text: '#c6ccc8',
  dim: '#767d78',
}

// Protocol colours (restrained): http green, postgres steel, redis sand, control grey.
export const PROTO_COLOR: Record<string, string> = {
  http: '#59c9a5',
  'http-app': '#59c9a5',
  postgres: '#7fa8c9',
  redis: '#b8ad94',
  ssh: '#6f7672',
  control: '#6f7672',
  other: '#6f7672',
}

interface RoleStyle {
  color: string
  glyph: string
  r: number // world radius
  e: number // elevation 0..1 (shadow offset/blur)
  weight: number // label priority
  tx: number // layout tier x
  ty: number // layout tier y
}
export const ROLE: Record<string, RoleStyle> = {
  internet: { color: '#9aa5a0', glyph: 'NET', r: 20, e: 0.45, weight: 3, tx: -560, ty: 0 },
  traffic: { color: '#59c9a5', glyph: 'TRF', r: 18, e: 0.35, weight: 3, tx: -420, ty: 0 },
  lb: { color: '#59c9a5', glyph: 'LB', r: 23, e: 0.8, weight: 5, tx: -210, ty: 0 },
  app: { color: '#a7b8b2', glyph: 'APP', r: 19, e: 0.38, weight: 3, tx: 20, ty: 0 },
  worker: { color: '#8c9691', glyph: 'WRK', r: 17, e: 0.28, weight: 2, tx: 60, ty: 230 },
  cache: { color: '#b8ad94', glyph: 'RDS', r: 20, e: 0.72, weight: 4, tx: 280, ty: -130 },
  db: { color: '#7fa8c9', glyph: 'PG', r: 23, e: 0.8, weight: 5, tx: 300, ty: 130 },
  controller: { color: '#cfe9de', glyph: 'CTL', r: 20, e: 0.88, weight: 4, tx: -60, ty: -230 },
}
export const roleOf = (r: string): RoleStyle =>
  ROLE[r] ?? { color: '#8c9691', glyph: r.slice(0, 3).toUpperCase(), r: 17, e: 0.3, weight: 2, tx: 0, ty: 0 }

const ANCHOR_ROLE: Record<string, string> = { app: 'lb', worker: 'db', cache: 'app', db: 'app', lb: 'traffic', traffic: 'internet' }
const SEV_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 }
const MONO = '"JetBrains Mono", ui-monospace, Menlo, monospace'
const LINK_GRACE_MS = 30000
const TOP_PAD = 92
const BOTTOM_PAD = 176
const LEFT_PAD = 196
const RIGHT_PAD = 40


interface Body extends SimulationNodeDatum {
  id: string
  node: FleetNode
  pending: boolean
  ta: number // eased issue tint
  alpha: number // eased status alpha
  ex: number // eased expansion 0..1
  open: boolean // expansion target
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
  present: boolean // reported in the current feed frame (only present links are drawn)
  goneAt: number // when it stopped being reported (kept in layout for LINK_GRACE_MS)
}

interface FileLayout {
  role: CodemapRole
  entry: string
  R: number // container radius (world)
  pos: Map<string, { x: number; y: number; r: number }>
  pathTo: Map<string, [string, string][]> // import path entry → file
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
  r: number
  color: string
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
  rightInset: number // px covered by the right-hand column (alerts/detail)
  showControl: boolean // show all ssh/control links (default: only for the focused node)
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

// Tidy cluster: entry file in the centre, the rest on one ring (two if many),
// port-owning files first, then by size. Sizes scale with loc.
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
  const fr = (loc: number) => clamp(4 + Math.sqrt(loc) / 3.2, 4, 12)
  const pos = new Map<string, { x: number; y: number; r: number }>()
  const ef = cr.files.find((f) => f.path === entry)
  pos.set(entry, { x: 0, y: 0, r: fr(ef?.loc ?? 50) })
  const inner = others.slice(0, 10)
  const outer = others.slice(10)
  const R1 = Math.max(105, (inner.length * 95) / (2 * Math.PI))
  inner.forEach((f, i) => {
    const a = -Math.PI / 2 + (i / Math.max(1, inner.length)) * Math.PI * 2
    pos.set(f.path, { x: Math.cos(a) * R1, y: Math.sin(a) * R1, r: fr(f.loc) })
  })
  const R2 = R1 + 72
  outer.forEach((f, i) => {
    const a = -Math.PI / 2 + ((i + 0.5) / Math.max(1, outer.length)) * Math.PI * 2
    pos.set(f.path, { x: Math.cos(a) * R2, y: Math.sin(a) * R2, r: fr(f.loc) })
  })
  // import paths from the entry (directed importer → imported)
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
  const lay = { role: cr, entry, R: (outer.length ? R2 : R1) + 58, pos, pathTo }
  layoutCache.set(key, lay)
  return lay
}

// ---------------------------------------------------------------------------
export default function GraphView(props: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const propsRef = useRef<Props>(props)
  propsRef.current = props

  const bodiesRef = useRef(new Map<string, Body>())
  const linksRef = useRef(new Map<string, LinkR>())
  const ghostsRef = useRef<Ghost[]>([])
  const burstsRef = useRef<{ id: string; age: number; color: string }[]>([])
  const simRef = useRef<Simulation<Body, LinkR> | null>(null)

  // collide radius = drawn radius + padding, widened to the label block, and to
  // the whole file cluster while a node is expanded
  const collideRadius = (d: Body) => {
    const cr = d.open ? codeFor(propsRef.current.codemap, d.node.role) : null
    if (cr) return layoutFor(d.node.role, cr).R + 34
    return Math.max(roleOf(d.node.role).r + 30, d.labelW / 2 + 14)
  }
  const collideRef = useRef(forceCollide<Body>(collideRadius).strength(1).iterations(2))

  if (!simRef.current) {
    simRef.current = forceSimulation<Body, LinkR>([])
      .force(
        'link',
        forceLink<Body, LinkR>([])
          .id((d) => d.id)
          .distance(190)
          .strength(0.22),
      )
      .force('charge', forceManyBody<Body>().strength(-1100).distanceMax(1000))
      .force('collide', collideRef.current)
      .force('x', forceX<Body>((d) => roleOf(d.node.role).tx).strength(0.08))
      .force('y', forceY<Body>((d) => roleOf(d.node.role).ty).strength(0.06))
      .stop()
  }

  // ---- sync fleet → scene (stable identity; no re-heat unless structure changes)
  useEffect(() => {
    const fleet = props.fleet
    const bodies = bodiesRef.current
    const links = linksRef.current
    const sim = simRef.current!
    const linkForce = sim.force('link') as ReturnType<typeof forceLink<Body, LinkR>>
    let structural = false // node set changed → re-heat
    let relink = false // link set changed → gentle nudge only

    if (!fleet) {
      if (bodies.size || links.size) {
        bodies.clear()
        links.clear()
        sim.nodes([])
        linkForce.links([])
      }
      return
    }

    const measure = (n: FleetNode) => Math.max(n.label.length, n.privateIp.length, 11) * 6.7

    const place = (n: FleetNode): { x: number; y: number; pin: boolean } => {
      const drop = takePlacement(n.id)
      if (drop) return { ...drop, pin: true }
      const saved = n.id.startsWith('pending-') ? null : loadPos(n.label)
      if (saved) return { ...saved, pin: true }
      const jitter = () => (Math.random() - 0.5) * 60
      for (const l of fleet.links) {
        const other = l.source === n.id ? l.target : l.target === n.id ? l.source : null
        const ob = other ? bodies.get(other) : undefined
        if (ob) return { x: (ob.x ?? 0) + 170 * Math.sign(roleOf(n.role).tx - roleOf(ob.node.role).tx || 1) + jitter(), y: (ob.y ?? 0) + jitter(), pin: false }
      }
      const ar = ANCHOR_ROLE[n.role]
      for (const b of bodies.values()) if (b.node.role === ar) return { x: (b.x ?? 0) + 170 + jitter(), y: (b.y ?? 0) + jitter(), pin: false }
      const st = roleOf(n.role)
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
          id: n.id, node: n, pending: n.id.startsWith('pending-'), ta: 0, alpha: 0, ex: 0, open: false,
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
      if (ic > b.lastIssueCount) burstsRef.current.push({ id: n.id, age: 0, color: issueLevel(n) === 'amber' ? C.amber : C.red })
      b.lastIssueCount = ic
      if (b.node.label !== n.label) b.labelW = measure(n)
      b.node = n
      b.pending = n.id.startsWith('pending-')
      seen.add(n.id)
    }
    for (const [id, b] of bodies) {
      if (seen.has(id)) continue
      ghostsRef.current.push({ x: b.x ?? 0, y: b.y ?? 0, r: roleOf(b.node.role).r, color: roleOf(b.node.role).color, t: 0 })
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
    // The backend only reports links with observed connections, so links come
    // and go. Keep a vanished link in the layout for a grace period (stable
    // positions) but stop drawing it immediately (only real links are shown).
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

  // ---- canvas loop + interaction ------------------------------------------
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
    let autoFit = true // until the user pans/zooms; double-click restores
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
      W = window.innerWidth
      H = window.innerHeight
      canvas.width = Math.floor(W * dpr)
      canvas.height = Math.floor(H * dpr)
      canvas.style.width = `${W}px`
      canvas.style.height = `${H}px`
    }
    resize()
    window.addEventListener('resize', resize)

    const S = (x: number | undefined, y: number | undefined) => ({ x: (x ?? 0) * view.k + view.tx, y: (y ?? 0) * view.k + view.ty })
    const toWorld = (sx: number, sy: number) => ({ x: (sx - view.tx) / view.k, y: (sy - view.ty) / view.k })
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
    const extentOf = (b: Body) => {
      const lay = b.ex > 0.01 ? layoutOf(b) : null
      return lay ? lay.R * b.ex + roleOf(b.node.role).r * (1 - b.ex) : roleOf(b.node.role).r
    }

    const fitTarget = () => {
      const bodies = bodiesRef.current
      if (bodies.size === 0) return null
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      for (const b of bodies.values()) {
        const r = extentOf(b)
        const hw = Math.max(r, b.labelW / 2) + 16
        x0 = Math.min(x0, (b.x ?? 0) - hw); x1 = Math.max(x1, (b.x ?? 0) + hw)
        y0 = Math.min(y0, (b.y ?? 0) - r - 34); y1 = Math.max(y1, (b.y ?? 0) + r + 60)
      }
      const aw = Math.max(200, W - LEFT_PAD - Math.max(RIGHT_PAD, propsRef.current.rightInset))
      const ah = Math.max(160, H - TOP_PAD - BOTTOM_PAD)
      const k = clamp(Math.min(aw / (x1 - x0), ah / (y1 - y0)), 0.3, 1.6)
      return { k, tx: LEFT_PAD + aw / 2 - ((x0 + x1) / 2) * k, ty: TOP_PAD + ah / 2 - ((y0 + y1) / 2) * k }
    }

    // Link endpoint on screen. When a node is expanded, its real link attaches
    // to the file that owns that port (codemap `ports`).
    const endPos = (b: Body, l: LinkR, outgoing: boolean) => {
      const base = S(b.x, b.y)
      if (b.ex < 0.01) return { ...base, file: null as string | null }
      const lay = layoutOf(b)
      if (!lay) return { ...base, file: null }
      const dir = outgoing ? 'out' : 'in'
      const pe = lay.role.ports.find((p) => p.port === l.data.port && p.dir === dir) ?? lay.role.ports.find((p) => p.port === l.data.port)
      const fp = pe ? lay.pos.get(pe.file) : undefined
      if (!pe || !fp) return { ...base, file: null }
      return { x: base.x + fp.x * b.ex * view.k, y: base.y + fp.y * b.ex * view.k, file: pe.file }
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
      let bd = 6
      for (const l of linksRef.current.values()) {
        if (!visibleLinks.has(l) || !l.present) continue
        const a = endPos(l.a, l, true), b = endPos(l.b, l, false)
        const d = segDist(x, y, a.x, a.y, b.x, b.y)
        if (d < bd) { bd = d; best = l }
      }
      return best
    }

    // ---- input --------------------------------------------------------------
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
        if (h?.kind === 'file') P.onSelect({ kind: 'node', id: h.id, file: h.file })
        else if (h?.kind === 'badge') P.onSelect({ kind: 'node', id: h.id, file: h.file })
        else if (h?.kind === 'node') {
          // second click on the selected node collapses / deselects
          const same = P.selected?.kind === 'node' && P.selected.id === h.id
          P.onSelect(same ? null : { kind: 'node', id: h.id })
        } else {
          const l = linkAt(press.x, press.y)
          P.onSelect(l ? { kind: 'link', id: l.id } : null)
        }
      }
      if (dragBody) {
        // pinned where dropped; persisted by label
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

    // ---- drawing helpers ------------------------------------------------------
    const drawShadow = (sx: number, sy: number, rs: number, e: number, a: number) => {
      const s = clamp(Math.sqrt(view.k), 0.6, 1.5)
      const off = (2 + e * 11) * s
      const blur = rs * (1.08 + e * 0.6) + e * 5
      const cx = sx + off, cy = sy + off * 0.9
      const g = ctx.createRadialGradient(cx, cy, rs * 0.2, cx, cy, blur)
      g.addColorStop(0, `rgba(0,0,0,${(0.55 - e * 0.2) * a})`)
      g.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = g
      ctx.beginPath(); ctx.arc(cx, cy, blur, 0, Math.PI * 2); ctx.fill()
    }
    const drawSphere = (sx: number, sy: number, rs: number, col: string) => {
      const g = ctx.createRadialGradient(sx - rs * 0.38, sy - rs * 0.42, rs * 0.06, sx, sy, rs)
      g.addColorStop(0, mix(col, '#ffffff', 0.32))
      g.addColorStop(0.55, col)
      g.addColorStop(1, mix(col, '#000000', 0.5))
      ctx.fillStyle = g
      ctx.beginPath(); ctx.arc(sx, sy, rs, 0, Math.PI * 2); ctx.fill()
    }
    // Evenly spaced dashes moving along a lane. Density + speed from bytes/s on
    // a log scale, capped low. No traffic → nothing drawn (static base line only).
    const intensity = (bps: number) => clamp(Math.log10(1 + bps / 1024) / 3.5, 0, 1)
    const flowLane = (ax: number, ay: number, bx: number, by: number, bps: number, col: string, phase: number, alpha: number) => {
      if (bps < 1) return
      const it = intensity(bps)
      const dx = bx - ax, dy = by - ay
      const dl = Math.hypot(dx, dy) || 1
      const ox = (-dy / dl) * 2.4, oy = (dx / dl) * 2.4
      ctx.setLineDash([3, 26 - 16 * it])
      ctx.lineDashOffset = -phase
      ctx.lineCap = 'round'
      ctx.lineWidth = 1.8
      ctx.strokeStyle = rgba(col, (0.45 + 0.45 * it) * alpha)
      ctx.beginPath(); ctx.moveTo(ax + ox, ay + oy); ctx.lineTo(bx + ox, by + oy); ctx.stroke()
      ctx.setLineDash([])
      ctx.lineDashOffset = 0
      ctx.lineCap = 'butt'
    }
    const laneSpeed = (bps: number) => (bps < 1 ? 0 : 12 + 40 * intensity(bps)) // px/s, capped low

    const drawTooltip = (lines: { t: string; c?: string }[], anchor: { x: number; y: number; r: number }, side: 'node' | 'cursor') => {
      ctx.font = `400 11px ${MONO}`
      const maxW = Math.min(340, W - 24)
      const shown = lines.map((l) => ({ t: truncate(ctx, l.t, maxW - 16), c: l.c }))
      const w = Math.min(maxW, Math.max(...shown.map((l) => ctx.measureText(l.t).width)) + 16)
      const h = shown.length * 16 + 10
      let x: number
      let y: number
      if (side === 'node') {
        // beside the node, never over it
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
      y = clamp(y, 44, H - 8 - h)
      ctx.fillStyle = 'rgba(6,6,7,0.95)'
      ctx.fillRect(x, y, w, h)
      ctx.strokeStyle = 'rgba(150,160,156,0.32)'
      ctx.lineWidth = 1
      ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h))
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      shown.forEach((l, i) => {
        ctx.fillStyle = l.c ?? (i === 0 ? C.text : C.dim)
        ctx.fillText(l.t, x + 8, y + 6 + i * 16)
      })
    }

    // ---- frame ----------------------------------------------------------------
    let raf = 0
    let last = performance.now()
    const frame = (now: number) => {
      // time-based, so slow/throttled frames still converge (cap guards tab switches)
      const dt = Math.min(0.25, Math.max(0, (now - last) / 1000))
      last = now
      const P = propsRef.current
      const red = P.reduced
      const pulse = red ? 1 : 0.7 + 0.3 * Math.sin(now / 380)
      const bodies = bodiesRef.current
      const links = linksRef.current
      const k = view.k
      const sel = P.selected

      // expansion target: the selected node, if its role runs our code
      const want = sel?.kind === 'node' && bodies.has(sel.id) && codeFor(P.codemap, bodies.get(sel.id)!.node.role) ? sel.id : null
      if (want !== expandedId) {
        expandedId = want
        for (const b of bodies.values()) b.open = b.id === want
        collideRef.current.radius(collideRadius) // re-initialise radii
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
        const cx = LEFT_PAD + (W - LEFT_PAD - Math.max(RIGHT_PAD, P.rightInset)) / 2
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

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.globalAlpha = 1
      ctx.globalCompositeOperation = 'source-over'
      ctx.fillStyle = C.bg
      ctx.fillRect(0, 0, W, H)

      // -- very faint ground grid with mild parallax (0.6×) --------------------
      {
        const step = 72 * (1 + (view.k - 1) * 0.6)
        if (step > 16) {
          const gx0 = (((view.tx * 0.6) % step) + step) % step
          const gy0 = (((view.ty * 0.6) % step) + step) % step
          ctx.strokeStyle = 'rgba(150,160,156,0.035)'
          ctx.lineWidth = 1
          ctx.beginPath()
          for (let x = gx0; x < W; x += step) { ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, H) }
          for (let y = gy0; y < H; y += step) { ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(W, Math.round(y) + 0.5) }
          ctx.stroke()
        }
      }

      const newHits: Hit[] = []
      const dimOf = (b: Body) => 1 - 0.5 * Math.max(0, dimAll - b.ex) // others dim while one is expanded
      const errTint = P.metrics ? clamp(P.metrics.errorRate / 10, 0, 0.6) : 0

      // -- agents → per-node check-job state (no motes) -----------------------
      for (const r of agentsR.values()) r.active = false
      for (const a of P.agents) {
        if (P.live && a.simulated) continue
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
        r.alpha = r.active ? Math.min(1, r.alpha + dt * 3) : r.alpha - dt / 1.5 // ~1.5s fade when done
        if (r.alpha <= 0 || !bodies.has(r.target)) { agentsR.delete(id); continue }
        const arr = jobsByNode.get(r.target) ?? []
        arr.push(r)
        jobsByNode.set(r.target, arr)
      }

      // -- links: static hairline + moving dash lanes for real bytes/s -------
      const nextVisible = new Set<LinkR>()
      for (const l of links.values()) {
        const s = 1 - Math.exp(-dt / 1.2) // smoothing so flow never jumps
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
        if (ctlLink && !P.showControl && !isSel) {
          // controller links only for the node in focus or with a running check job
          const focusId = (id: string) => hover?.id === id || (sel?.kind === 'node' && sel.id === id) || jobsByNode.has(id)
          if (!focusId(l.a.id) && !focusId(l.b.id)) continue
        }
        nextVisible.add(l)
        const A = endPos(l.a, l, true)
        const B = endPos(l.b, l, false)
        const isHov = hoverLink === l
        const da = Math.min(dimOf(l.a), dimOf(l.b))
        ctx.lineWidth = 1 + (isSel || isHov ? 1 : 0)
        ctx.strokeStyle = rgba(col, ((control ? 0.16 : 0.22) + (isSel || isHov ? 0.35 : 0)) * da)
        ctx.setLineDash(control ? [3, 5] : [])
        ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke()
        ctx.setLineDash([])
        if (!control) {
          const http = l.data.protocol === 'http' || l.data.protocol === 'http-app'
          flowLane(A.x, A.y, B.x, B.y, l.sF, http && errTint > 0 ? mix(col, C.red, errTint) : col, l.phF, da)
          flowLane(B.x, B.y, A.x, A.y, l.sR, col, l.phR, da)
        }
      }
      visibleLinks = nextVisible

      // -- ghosts of removed servers fade out ---------------------------------
      for (let i = ghostsRef.current.length - 1; i >= 0; i--) {
        const g = ghostsRef.current[i]
        g.t += dt / 0.8
        if (g.t >= 1) { ghostsRef.current.splice(i, 1); continue }
        const p = S(g.x, g.y)
        ctx.globalAlpha = 0.35 * (1 - g.t)
        drawSphere(p.x, p.y, g.r * k * (1 - 0.3 * g.t), g.color)
        ctx.globalAlpha = 1
      }

      // -- servers, low elevation first --------------------------------------
      const surge = P.metrics?.mode === 'surge'
      const order = [...bodies.values()].sort((a, b) => a.ex - b.ex || roleOf(a.node.role).e - roleOf(b.node.role).e)
      const labelJobs: { b: Body; sx: number; sy: number; rs: number; a: number; prio: number }[] = []
      const badgeJobs: { id: string; file?: string; x: number; y: number; level: Level; n: number; a: number }[] = []
      for (const b of order) {
        const n = b.node
        const st = roleOf(n.role)
        const p = S(b.x, b.y)
        const rs0 = Math.max(6, st.r * k)
        const level = issueLevel(n)
        const nIssues = (n.issues ?? []).length
        const surgeTint = surge && (n.role === 'traffic' || n.role === 'internet')
        b.ta += ((level || surgeTint ? 1 : 0) - b.ta) * (1 - Math.exp(-dt * 6))
        const statusA = n.status === 'deleting' ? 0.2 : n.status === 'provisioning' || n.status === 'booting' ? 0.5 : n.status === 'offline' ? 0.75 : 1
        b.alpha += (statusA - b.alpha) * (1 - Math.exp(-dt * 4))
        const tcol = level === 'amber' ? C.amber : C.red
        const col = b.ta > 0.01 ? mix(st.color, tcol, b.ta) : st.color
        const dim = dimOf(b)
        const a = b.alpha * dim
        if (p.x < -400 || p.y < -400 || p.x > W + 400 || p.y > H + 400) continue
        const lay = b.ex > 0 ? layoutOf(b) : null
        const containerR = lay ? lay.R * k : rs0
        const rs = rs0 * (1 - 0.85 * b.ex) // sphere "splits" into its files
        const hitR = lay && b.ex > 0.5 ? containerR : rs0

        // expanded container: faint boundary, files, import edges, flow paths
        if (lay && b.ex > 0.01) {
          const e = b.ex
          ctx.globalAlpha = e
          ctx.strokeStyle = rgba(st.color, 0.22)
          ctx.lineWidth = 1
          ctx.setLineDash([2, 4])
          ctx.beginPath(); ctx.arc(p.x, p.y, containerR * e + rs0 * (1 - e), 0, Math.PI * 2); ctx.stroke()
          ctx.setLineDash([])
          const fpos = (path: string) => {
            const f = lay.pos.get(path)
            return f ? { x: p.x + f.x * e * k, y: p.y + f.y * e * k, r: f.r * k * (0.4 + 0.6 * e) } : null
          }
          // import edges: thin static lines
          for (const ed of lay.role.edges) {
            const A = fpos(ed.from), B = fpos(ed.to)
            if (!A || !B) continue
            ctx.strokeStyle = 'rgba(198,204,200,0.16)'
            ctx.lineWidth = 1
            ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke()
          }
          // highlight entry → port-file import paths, scaled by that link's real rate
          for (const l of links.values()) {
            const outgoing = l.a === b
            if (!l.present || (!outgoing && l.b !== b)) continue
            const pe = lay.role.ports.find((q) => q.port === l.data.port && q.dir === (outgoing ? 'out' : 'in'))
            if (!pe) continue
            const it = intensity(l.sF + l.sR)
            if (it <= 0.01) continue
            const pc = PROTO_COLOR[l.data.protocol] ?? PROTO_COLOR.other
            for (const [f, t] of lay.pathTo.get(pe.file) ?? []) {
              const A = fpos(f), B = fpos(t)
              if (!A || !B) continue
              ctx.strokeStyle = rgba(pc, 0.12 + 0.4 * it)
              ctx.lineWidth = 1 + 1.2 * it
              ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke()
            }
          }
          // file bodies
          for (const f of lay.role.files) {
            const fp = fpos(f.path)
            if (!fp) continue
            const fi = fileIssues(n, f.path)
            const fl = levelOf(fi)
            const fc = fl ? (fl === 'red' ? C.red : C.amber) : mix(st.color, '#ffffff', 0.08)
            drawShadow(fp.x, fp.y, fp.r, 0.15, e)
            ctx.globalAlpha = e
            drawSphere(fp.x, fp.y, fp.r, fc)
            const isF = sel?.kind === 'node' && sel.id === b.id && sel.file === f.path
            const isH = hover?.kind === 'file' && hover.id === b.id && hover.file === f.path
            if (isF || isH) {
              ctx.strokeStyle = rgba(C.acc, isF ? 0.95 : 0.6)
              ctx.lineWidth = 1
              ctx.beginPath(); ctx.arc(fp.x, fp.y, fp.r + 4, 0, Math.PI * 2); ctx.stroke()
            }
            if (e > 0.6) {
              // label points away from the cluster centre so ring labels never collide
              ctx.globalAlpha = (e - 0.6) / 0.4
              ctx.font = `400 10px ${MONO}`
              const vx = fp.x - p.x, vy = fp.y - p.y
              const vl = Math.hypot(vx, vy)
              let lx = fp.x, ly = fp.y + fp.r + 4
              ctx.textAlign = 'center'
              ctx.textBaseline = 'top'
              if (vl > 1) {
                const ux = vx / vl, uy = vy / vl
                lx = fp.x + ux * (fp.r + 6)
                ly = fp.y + uy * (fp.r + 6)
                ctx.textAlign = ux > 0.35 ? 'left' : ux < -0.35 ? 'right' : 'center'
                ctx.textBaseline = uy > 0.35 ? 'top' : uy < -0.35 ? 'bottom' : 'middle'
              }
              ctx.fillStyle = C.text
              ctx.fillText(f.label, lx, ly)
              ctx.fillStyle = C.dim
              const lw = ctx.measureText(f.label).width
              const dx = ctx.textAlign === 'left' ? lw + 5 : ctx.textAlign === 'right' ? -(lw + 5) : 0
              const dy = ctx.textAlign === 'center' ? (ctx.textBaseline === 'bottom' ? -12 : 12) : 0
              ctx.fillText(`${f.loc}`, lx + dx, ly + dy)
            }
            ctx.globalAlpha = 1
            if (e > 0.5) newHits.push({ kind: 'file', id: b.id, file: f.path, sx: fp.x, sy: fp.y, rs: Math.max(fp.r, 6) })
            if (fl && e > 0.5) {
              // tangential to the ring so it never sits on the outward label
              const vx = fp.x - p.x, vy = fp.y - p.y
              const vl = Math.hypot(vx, vy)
              const bx = vl > 1 ? fp.x + (-vy / vl) * (fp.r + 10) : fp.x + fp.r * 0.72 + 8
              const by = vl > 1 ? fp.y + (vx / vl) * (fp.r + 10) : fp.y - fp.r * 0.72 - 8
              badgeJobs.push({ id: b.id, file: f.path, x: bx, y: by, level: fl, n: fi.length, a: e })
            }
          }
          ctx.globalAlpha = 1
        }

        if (rs > 1) {
          drawShadow(p.x, p.y, rs, st.e, a * (1 - b.ex))
          if (b.ta > 0.02 && (level || surgeTint) && b.ex < 0.5) {
            ctx.globalCompositeOperation = 'lighter'
            const g = ctx.createRadialGradient(p.x, p.y, rs * 0.6, p.x, p.y, rs * 2.4)
            g.addColorStop(0, rgba(tcol, 0.32 * b.ta * pulse * dim))
            g.addColorStop(1, rgba(tcol, 0))
            ctx.fillStyle = g
            ctx.beginPath(); ctx.arc(p.x, p.y, rs * 2.4, 0, Math.PI * 2); ctx.fill()
            ctx.globalCompositeOperation = 'source-over'
          }
          ctx.globalAlpha = a * (1 - 0.7 * b.ex)
          drawSphere(p.x, p.y, rs, col)

          // role accent (restrained)
          if (b.ex < 0.3) {
            ctx.lineWidth = 1
            ctx.strokeStyle = rgba(col, 0.5)
            if (n.role === 'lb') { ctx.beginPath(); ctx.arc(p.x, p.y, rs + 4, 0, Math.PI * 2); ctx.stroke() }
            else if (n.role === 'db') { for (const d of [4, 7]) { ctx.beginPath(); ctx.arc(p.x, p.y, rs + d, 0, Math.PI * 2); ctx.stroke() } }
            else if (n.role === 'cache') { ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.arc(p.x, p.y, rs + 4, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]) }
            else if (n.role === 'internet') { ctx.setLineDash([1, 3]); ctx.beginPath(); ctx.arc(p.x, p.y, rs + 4, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]) }
            else if (n.role === 'controller') { const h = rs + 5; ctx.strokeRect(p.x - h, p.y - h, h * 2, h * 2) }
            if (rs >= 11) {
              ctx.font = `700 ${Math.round(clamp(rs * 0.55, 8, 13))}px ${MONO}`
              ctx.fillStyle = 'rgba(6,6,7,0.82)'
              ctx.textAlign = 'center'
              ctx.textBaseline = 'middle'
              ctx.fillText(st.glyph, p.x, p.y + 0.5)
            }
          }
        }
        ctx.globalAlpha = 1

        // boot ring (provisioning/booting) + status tags
        const ringR = (b.ex > 0.01 ? containerR * b.ex + rs0 * (1 - b.ex) : rs0) + 9
        if (n.status === 'provisioning' || n.status === 'booting') {
          const t = (now - b.bootStart) / 1000
          const prog = n.status === 'provisioning' ? 0.4 * (1 - Math.exp(-t / 3)) : 0.4 + 0.55 * (1 - Math.exp(-t / 5))
          ctx.strokeStyle = 'rgba(255,255,255,0.1)'
          ctx.lineWidth = 2
          ctx.beginPath(); ctx.arc(p.x, p.y, ringR, 0, Math.PI * 2); ctx.stroke()
          ctx.strokeStyle = C.acc
          ctx.beginPath(); ctx.arc(p.x, p.y, ringR, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * prog); ctx.stroke()
        }
        // running check jobs: a thin arc segment per job (length = progress) + tick
        const jobs = jobsByNode.get(b.id) ?? []
        jobs.forEach((r, i) => {
          const rr = ringR + 4 + i * 4
          const end = -Math.PI / 2 + Math.PI * 2 * Math.max(0.06, r.progress)
          ctx.globalAlpha = r.alpha * dim
          ctx.strokeStyle = '#d8f5ea'
          ctx.lineWidth = 1.5
          ctx.beginPath(); ctx.arc(p.x, p.y, rr, -Math.PI / 2, end); ctx.stroke()
          ctx.beginPath()
          ctx.moveTo(p.x + Math.cos(end) * (rr - 3), p.y + Math.sin(end) * (rr - 3))
          ctx.lineTo(p.x + Math.cos(end) * (rr + 3), p.y + Math.sin(end) * (rr + 3))
          ctx.stroke()
          ctx.globalAlpha = 1
        })
        const tag = n.status === 'provisioning' || n.status === 'booting' || n.status === 'deleting' || n.status === 'offline' ? n.status.toUpperCase() : ''
        if (tag) {
          ctx.font = `500 9px ${MONO}`
          ctx.fillStyle = n.status === 'offline' ? C.red : C.acc
          ctx.textAlign = 'center'
          ctx.textBaseline = 'bottom'
          ctx.fillText(tag, p.x, p.y - ringR - 6 - jobs.length * 4)
        }

        const isSel = sel?.kind === 'node' && sel.id === b.id
        const isHov = hover?.kind === 'node' && hover.id === b.id
        if ((isSel || isHov) && b.ex < 0.3) {
          ctx.strokeStyle = rgba(C.acc, isSel ? 0.95 : 0.6)
          ctx.lineWidth = 1
          ctx.beginPath(); ctx.arc(p.x, p.y, rs0 + (n.role === 'db' ? 11 : 8), 0, Math.PI * 2); ctx.stroke()
        }

        newHits.splice(newHits.length - (lay && b.ex > 0.5 ? lay.role.files.length : 0), 0, { kind: 'node', id: b.id, sx: p.x, sy: p.y, rs: hitR })
        const anchorR = b.ex > 0.01 && lay ? containerR * b.ex + rs0 * (1 - b.ex) : rs0
        labelJobs.push({ b, sx: p.x, sy: p.y, rs: anchorR, a, prio: (isSel || isHov ? 100 : 0) + st.weight + (level ? 3 : 0) })
        if (nIssues > 0 && level && b.ta > 0.05) badgeJobs.push({ id: b.id, x: p.x + anchorR * 0.72 + 9, y: p.y - anchorR * 0.72 - 9, level, n: nIssues, a: dim })
      }

      // -- brief ring when a node gains a new real issue ---------------------
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
        ctx.beginPath(); ctx.arc(p.x, p.y, roleOf(b.node.role).r * k + 6 + t * 30, 0, Math.PI * 2); ctx.stroke()
        ctx.globalAlpha = 1
      }

      // -- labels with collision pass (lower priority hidden until hover) ----
      {
        type Rect = { x0: number; y0: number; x1: number; y1: number }
        const placed: Rect[] = []
        const circles = labelJobs.map((j) => ({ id: j.b.id, x: j.sx, y: j.sy, r: j.rs + 4 }))
        const overlaps = (r: Rect, ownId: string) => {
          for (const q of placed) if (r.x0 < q.x1 && r.x1 > q.x0 && r.y0 < q.y1 && r.y1 > q.y0) return true
          for (const c of circles) {
            if (c.id === ownId) continue
            const nx = clamp(c.x, r.x0, r.x1), ny = clamp(c.y, r.y0, r.y1)
            if (Math.hypot(c.x - nx, c.y - ny) < c.r) return true
          }
          return false
        }
        const showGauge = k > 0.55
        for (const j of labelJobs.sort((a, b) => b.prio - a.prio)) {
          const n = j.b.node
          ctx.font = `500 11px ${MONO}`
          const label = truncate(ctx, n.label, 150)
          const lw = ctx.measureText(label).width
          ctx.font = `400 10px ${MONO}`
          const ip = truncate(ctx, n.privateIp, 150)
          const iw = ctx.measureText(ip).width
          const w = Math.max(lw, iw, showGauge ? 64 : 0)
          const top = j.sy + j.rs + (n.role === 'db' && j.b.ex < 0.3 ? 12 : 9)
          const h = 13 + 12 + (showGauge ? 8 : 0)
          const rect = { x0: j.sx - w / 2 - 3, y0: top - 2, x1: j.sx + w / 2 + 3, y1: top + h + 2 }
          if (j.prio < 100 && overlaps(rect, j.b.id)) continue
          placed.push(rect)
          const a = Math.max(0.5, j.a)
          ctx.textAlign = 'center'
          ctx.textBaseline = 'top'
          ctx.font = `500 11px ${MONO}`
          ctx.fillStyle = rgba(C.text, a)
          ctx.fillText(label, j.sx, top)
          ctx.font = `400 10px ${MONO}`
          ctx.fillStyle = rgba(C.dim, a)
          ctx.fillText(ip, j.sx, top + 13)
          if (showGauge && n.status === 'running') {
            const gy = top + 27
            const vals = [n.cpu, n.memTotal ? n.memUsed / n.memTotal : 0]
            vals.forEach((v, i) => {
              const x = j.sx - 32 + i * 34
              ctx.fillStyle = `rgba(150,160,156,${0.16 * a})`
              ctx.fillRect(x, gy, 30, 3)
              ctx.fillStyle = v > 0.9 ? C.red : v > 0.75 ? C.amber : rgba(C.acc, 0.85 * a)
              ctx.fillRect(x, gy, 30 * clamp(v, 0, 1), 3)
            })
          }
        }
      }

      // -- "!" badges: one per node (or file), count when >1, kept apart -----
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
          const col = bj.level === 'amber' ? C.amber : C.red
          const text = bj.n > 1 ? `!${bj.n}` : '!'
          ctx.font = `700 10px ${MONO}`
          const w = Math.max(16, ctx.measureText(text).width + 8)
          ctx.globalAlpha = bj.a * (red ? 1 : 0.8 + 0.2 * pulse)
          ctx.fillStyle = col
          ctx.fillRect(bj.x - w / 2, bj.y - 8, w, 16)
          ctx.fillStyle = C.bg
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

      // -- tooltips (clamped, truncated, beside the node) --------------------
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
            for (const r of jobsByNode.get(n.id) ?? []) if (r.active) lines.push({ t: `check ${r.type} ${Math.round(r.progress * 100)}%  ${r.note}`, c: C.acc })
            const ni = (n.issues ?? []).length
            if (ni) lines.push({ t: `! ${ni} issue${ni > 1 ? 's' : ''} — select for detail`, c: issueLevel(n) === 'amber' ? C.amber : C.red })
            if (codeFor(P.codemap, n.role) && b.ex < 0.5) lines.push({ t: 'click to expand into files', c: C.dim })
            drawTooltip(lines, { x: hover.sx, y: hover.sy, r: hover.rs + 10 }, 'node')
          }
        } else if (hover?.kind === 'file') {
          const b = bodies.get(hover.id)
          const lay = b ? layoutOf(b) : null
          const f = lay?.role.files.find((x) => x.path === hover!.file)
          if (b && lay && f) {
            const ports = lay.role.ports.filter((q) => q.file === f.path).map((q) => `${q.dir} :${q.port}`)
            const imports = lay.role.edges.filter((e) => e.from === f.path).length
            const lines: { t: string; c?: string }[] = [{ t: f.path }, { t: `${f.loc} loc  ·  imports ${imports}${ports.length ? '  ·  ' + ports.join(', ') : ''}` }]
            for (const i of fileIssues(b.node, f.path).slice(0, 2)) lines.push({ t: `! ${i.severity}  ${i.title}`, c: SEV_RANK[i.severity] >= 3 ? C.red : C.amber })
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

  return <canvas ref={canvasRef} className="gx-canvas" />
}
