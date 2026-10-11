import { useEffect, useRef } from 'react'
import { ACTIVE_AGENT, codeFor, fileIssues, fmtMem, fmtRate, isControl } from '../../graph/GraphView'
import { loadPos, savePos, takeAlias, takePlacement } from '../../graph/positions'
import type { Agent, Codemap, CodemapRole, Fleet, FleetIssue, FleetLink, FleetNode, Metrics } from '../../graph/types'
import { bundle, measurePath, octiRoute, pointAt, segDist, segHitsRect } from './route'
import type { P, Path, RouteIn } from './route'

// ---------------------------------------------------------------------------
// Transit look: the fleet drawn as a subway diagram. Servers are stations,
// protocols are coloured lines routed at 0°/45°/90° only, real bytes/s run as
// trains (headway from the rate, none when idle), issues are disruption
// markers. Every mark maps to fleet data.
// ---------------------------------------------------------------------------

export type Sel = { kind: 'node'; id: string; file?: string } | { kind: 'link'; id: string }

export const T = {
  paper: '#f3eee1',
  card: '#fffdf6',
  ink: '#1b1b1a',
  mute: '#6d6a62',
  faint: '#cfc8b6',
  red: '#d42a20',
  amber: '#f0a500',
  hi: '#ffd329',
}

export interface LineStyle {
  color: string
  name: string
  rank: number
}
export const LINES: Record<string, LineStyle> = {
  http: { color: '#00843d', name: 'HTTP', rank: 0 },
  postgres: { color: '#0a3a8c', name: 'Postgres', rank: 1 },
  redis: { color: '#7b4ea3', name: 'Redis', rank: 2 },
  ssh: { color: '#009ca6', name: 'SSH', rank: 3 },
  control: { color: '#9b988f', name: 'Control', rank: 4 },
}
export function lineKey(proto: string): string {
  if (proto === 'http' || proto === 'http-app') return 'http'
  if (proto === 'postgres' || proto === 'redis' || proto === 'ssh') return proto
  return 'control'
}
export const lineOf = (proto: string): LineStyle => LINES[lineKey(proto)]

const SANS = '"Hanken Grotesk", "Helvetica Neue", Helvetica, Arial, sans-serif'
const MONO = '"JetBrains Mono", ui-monospace, Menlo, monospace'
const G = 20 // snap grid (world units)
const LW = 8 // line width (world)
const SPACING = 10.5 // parallel line pitch (world)
const ROW = 38 // platform row height (world)
const INSET_W = 380
const INSET_HEAD = 34
const LINK_GRACE_MS = 30000
const TOP_PAD = 104
const BOTTOM_PAD = 186
const LEFT_PAD = 214
const RIGHT_PAD = 40
const SEV_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 }
const HUBS = new Set(['lb', 'db', 'cache', 'controller'])

// Where each role sits on the diagram before anyone drags it (world units).
const TIER: Record<string, { x: number; y: number; sp: number }> = {
  internet: { x: -500, y: 220, sp: 120 },
  traffic: { x: -480, y: 0, sp: 120 },
  lb: { x: -240, y: 0, sp: 120 },
  app: { x: 0, y: 0, sp: 160 },
  worker: { x: 0, y: 260, sp: 120 },
  cache: { x: 300, y: -140, sp: 120 },
  db: { x: 300, y: 140, sp: 120 },
  controller: { x: -240, y: -240, sp: 120 },
}
const tierOf = (role: string) => TIER[role] ?? { x: 540, y: 0, sp: 120 }

type Level = 'red' | 'amber'

interface Station {
  id: string
  node: FleetNode
  pending: boolean
  x: number
  y: number
  pin: P | null
  placed: boolean
  alpha: number
  ex: number
  open: boolean
  bootStart: number
  bootPhase: string
  lastIssueCount: number
}

interface Track {
  id: string
  a: Station
  b: Station
  data: FleetLink
  sF: number
  sR: number
  phF: number
  phR: number
  present: boolean
  goneAt: number
}

interface Plan {
  role: CodemapRole
  rows: string[] // file paths, top to bottom
  w: number
  h: number
  pathTo: Map<string, [string, string][]>
}

interface JobR {
  id: string
  type: string
  note: string
  progress: number
  target: string
  alpha: number
  active: boolean
}

type Rect = { x0: number; y0: number; x1: number; y1: number }
type Hit = { kind: 'node' | 'badge' | 'file'; id: string; file?: string; r: Rect }

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
const snap = (v: number) => Math.round(v / G) * G

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
function mix(a: string, b: string, t: number): string {
  const A = rgb(a), B = rgb(b)
  const f = (i: number) => Math.round(A[i] + (B[i] - A[i]) * t)
  return '#' + ((1 << 24) | (f(0) << 16) | (f(1) << 8) | f(2)).toString(16).slice(1)
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

const planCache = new Map<string, Plan>()
function planFor(role: string, cr: CodemapRole): Plan {
  const key = `${role}|${cr.files.map((f) => f.path).join(',')}|${cr.edges.length}|${cr.ports.length}`
  const hit = planCache.get(key)
  if (hit) return hit
  const portFiles = new Set(cr.ports.map((p) => p.file))
  const entry = cr.ports.find((p) => p.dir === 'in')?.file ?? cr.files.slice().sort((a, b) => b.loc - a.loc)[0].path
  const rows = [entry, ...cr.files
    .filter((f) => f.path !== entry)
    .sort((a, b) => Number(portFiles.has(b.path)) - Number(portFiles.has(a.path)) || b.loc - a.loc)
    .map((f) => f.path)]
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
  const plan = { role: cr, rows, w: INSET_W, h: INSET_HEAD + 14 + rows.length * ROW + 10, pathTo }
  planCache.set(key, plan)
  return plan
}
// platform geometry inside the inset (world, relative to its centre)
const rowY = (pl: Plan, i: number) => -pl.h / 2 + INSET_HEAD + 14 + i * ROW
const barY = (pl: Plan, i: number) => rowY(pl, i) + ROW - 13
const PX_L = (pl: Plan) => -pl.w / 2 + 46
const PX_R = (pl: Plan) => pl.w / 2 - 34

// Trains: log scale on real bytes/s. Headway shrinks and speed rises with rate.
const intensity = (bps: number) => clamp(Math.log10(1 + bps / 256) / 3, 0, 1)
const headway = (bps: number) => 250 - 190 * intensity(bps) // world units between trains
const trainSpeed = (bps: number) => (bps < 1 ? 0 : 22 + 70 * intensity(bps)) // world units / s

// ---------------------------------------------------------------------------
export default function TransitView(props: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const propsRef = useRef<Props>(props)
  propsRef.current = props
  const stationsRef = useRef(new Map<string, Station>())
  const tracksRef = useRef(new Map<string, Track>())
  const ghostsRef = useRef<{ x: number; y: number; t: number }[]>([])
  const burstsRef = useRef<{ id: string; age: number; color: string }[]>([])

  // ---- sync fleet → stations/tracks ----------------------------------------
  useEffect(() => {
    const fleet = props.fleet
    const st = stationsRef.current
    const tr = tracksRef.current
    if (!fleet) {
      st.clear()
      tr.clear()
      return
    }
    const seen = new Set<string>()
    for (const n of fleet.nodes) {
      let s = st.get(n.id)
      if (!s) {
        const tmp = takeAlias(n.id)
        const old = tmp ? st.get(tmp) : undefined
        if (tmp && old) {
          st.delete(tmp)
          old.id = n.id
          st.set(n.id, old)
          s = old
          if (old.pin) savePos(n.label, old.pin.x, old.pin.y)
        }
      }
      if (!s) {
        const drop = takePlacement(n.id)
        const saved = n.id.startsWith('pending-') ? null : loadPos(n.label)
        const pin = drop ? { x: snap(drop.x), y: snap(drop.y) } : saved ? { x: snap(saved.x), y: snap(saved.y) } : null
        s = {
          id: n.id, node: n, pending: n.id.startsWith('pending-'), x: pin?.x ?? 0, y: pin?.y ?? 0, pin, placed: !!pin,
          alpha: 0, ex: 0, open: false, bootStart: performance.now(), bootPhase: n.status, lastIssueCount: (n.issues ?? []).length,
        }
        st.set(n.id, s)
      }
      if (s.bootPhase !== n.status) {
        s.bootPhase = n.status
        s.bootStart = performance.now()
      }
      const ic = (n.issues ?? []).length
      if (ic > s.lastIssueCount) burstsRef.current.push({ id: n.id, age: 0, color: levelOf(n.issues ?? []) === 'amber' ? T.amber : T.red })
      s.lastIssueCount = ic
      s.node = n
      s.pending = n.id.startsWith('pending-')
      seen.add(n.id)
    }
    for (const [id, s] of st) {
      if (seen.has(id)) continue
      ghostsRef.current.push({ x: s.x, y: s.y, t: 0 })
      st.delete(id)
    }
    const lseen = new Set<string>()
    for (const l of fleet.links) {
      const a = st.get(l.source)
      const b = st.get(l.target)
      if (!a || !b || a === b) continue
      let t = tr.get(l.id)
      if (!t || t.a !== a || t.b !== b) {
        t = { id: l.id, a, b, data: l, sF: 0, sR: 0, phF: Math.random() * 200, phR: Math.random() * 200, present: true, goneAt: 0 }
        tr.set(l.id, t)
      }
      t.data = l
      t.present = true
      lseen.add(l.id)
    }
    const nowMs = Date.now()
    for (const [id, t] of tr) {
      if (lseen.has(id)) continue
      const endsGone = st.get(t.a.id) !== t.a || st.get(t.b.id) !== t.b
      if (t.present) { t.present = false; t.goneAt = nowMs }
      if (endsGone || nowMs - t.goneAt > LINK_GRACE_MS) tr.delete(id)
    }
  }, [props.fleet])

  // ---- canvas loop + interaction -------------------------------------------
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
    let panTo: P | null = null

    const pointers = new Map<number, P>()
    let press: { x: number; y: number; hit: Hit | null; moved: boolean; lastX: number; lastY: number } | null = null
    let pinch: { dist: number; k: number } | null = null
    let drag: Station | null = null
    let mouse: P | null = null
    let hover: Hit | null = null
    let hoverTrack: Track | null = null
    let hits: Hit[] = []
    let drawn = new Map<Track, P[]>() // screen polylines of visible tracks
    let shiftOf: (s: Station) => P = () => ({ x: 0, y: 0 })
    const jobs = new Map<string, JobR>()

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

    const S = (p: P): P => ({ x: p.x * view.k + view.tx, y: p.y * view.k + view.ty })
    const toWorld = (sx: number, sy: number): P => ({ x: (sx - view.tx) / view.k, y: (sy - view.ty) / view.k })
    const zoomAround = (sx: number, sy: number, nk: number) => {
      const k = clamp(nk, 0.25, 4)
      view.tx = sx - ((sx - view.tx) * k) / view.k
      view.ty = sy - ((sy - view.ty) * k) / view.k
      view.k = k
    }
    const planOf = (s: Station): Plan | null => {
      const cr = codeFor(propsRef.current.codemap, s.node.role)
      return cr ? planFor(s.node.role, cr) : null
    }
    const D = (s: Station): P => {
      const sh = shiftOf(s)
      return { x: s.x + sh.x, y: s.y + sh.y }
    }

    const inRect = (x: number, y: number, r: Rect, pad = 0) => x >= r.x0 - pad && x <= r.x1 + pad && y >= r.y0 - pad && y <= r.y1 + pad
    const hitTest = (x: number, y: number): Hit | null => {
      for (let i = hits.length - 1; i >= 0; i--) if (inRect(x, y, hits[i].r, 3)) return hits[i]
      return null
    }
    const trackAt = (x: number, y: number): Track | null => {
      let best: Track | null = null
      let bd = 7
      for (const [t, pts] of drawn) {
        for (let i = 0; i < pts.length - 1; i++) {
          const d = segDist(x, y, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y)
          if (d < bd) { bd = d; best = t }
        }
      }
      return best
    }

    // ---- input ---------------------------------------------------------------
    const pos = (e: MouseEvent): P => {
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
        drag = null
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
        hoverTrack = hover ? null : trackAt(p.x, p.y)
        canvas.style.cursor = hover || hoverTrack ? 'pointer' : 'grab'
        return
      }
      if (!press.moved && Math.hypot(p.x - press.x, p.y - press.y) > 3) {
        press.moved = true
        const h = press.hit
        if (h && h.kind === 'node') drag = stationsRef.current.get(h.id) ?? null
        canvas.style.cursor = 'grabbing'
      }
      if (!press.moved) return
      if (drag) {
        // follow the pointer; lines re-route octilinearly every frame
        const w = toWorld(p.x, p.y)
        const sh = shiftOf(drag)
        drag.pin = { x: w.x - sh.x, y: w.y - sh.y }
        drag.x = drag.pin.x
        drag.y = drag.pin.y
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
        const P0 = propsRef.current
        if (h?.kind === 'file' || h?.kind === 'badge') P0.onSelect({ kind: 'node', id: h.id, file: h.file })
        else if (h?.kind === 'node') {
          const same = P0.selected?.kind === 'node' && P0.selected.id === h.id
          P0.onSelect(same ? null : { kind: 'node', id: h.id })
        } else {
          const t = trackAt(press.x, press.y)
          P0.onSelect(t ? { kind: 'link', id: t.id } : null)
        }
      }
      if (drag) {
        // snap to the grid so the diagram stays on its octilinear lattice; persist by label
        if (drag.pin) {
          drag.pin = { x: snap(drag.pin.x), y: snap(drag.pin.y) }
          if (!drag.pending) savePos(drag.node.label, drag.pin.x, drag.pin.y)
        }
        drag = null
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
    const onLeave = () => { mouse = null; hover = null; hoverTrack = null }
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
      propsRef.current.onDropRole(role, snap(w.x), snap(w.y))
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
    const trace = (pts: P[], r: number) => {
      ctx.beginPath()
      ctx.moveTo(pts[0].x, pts[0].y)
      for (let i = 1; i < pts.length - 1; i++) {
        const a = pts[i - 1], b = pts[i], c = pts[i + 1]
        const rr = Math.min(r, Math.hypot(b.x - a.x, b.y - a.y) / 2, Math.hypot(c.x - b.x, c.y - b.y) / 2)
        ctx.arcTo(b.x, b.y, c.x, c.y, Math.max(0.1, rr))
      }
      ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y)
    }
    const capsule = (x: number, y: number, w: number, h: number) => {
      const r = Math.min(w, h) / 2
      ctx.beginPath()
      ctx.roundRect(x, y, w, h, r)
    }
    const tooltip = (lines: { t: string; c?: string; b?: boolean }[], anchor: Rect | P) => {
      ctx.font = `500 12px ${SANS}`
      const maxW = Math.min(360, W - 24)
      const shown = lines.map((l) => ({ ...l, t: truncate(ctx, l.t, maxW - 20) }))
      const w = Math.min(maxW, Math.max(...shown.map((l) => { ctx.font = `${l.b ? 700 : 500} 12px ${SANS}`; return ctx.measureText(l.t).width })) + 20)
      const h = shown.length * 17 + 12
      let x: number, y: number
      if ('x0' in anchor) {
        x = anchor.x1 + 12
        if (x + w > W - 8) x = anchor.x0 - 12 - w
        y = (anchor.y0 + anchor.y1) / 2 - h / 2
      } else {
        x = anchor.x + 14
        y = anchor.y + 14
        if (x + w > W - 8) x = anchor.x - 14 - w
        if (y + h > H - 8) y = anchor.y - 14 - h
      }
      x = clamp(x, 8, W - 8 - w)
      y = clamp(y, 100, H - 8 - h)
      ctx.fillStyle = T.card
      ctx.strokeStyle = T.ink
      ctx.lineWidth = 1.5
      ctx.beginPath(); ctx.roundRect(x, y, w, h, 4); ctx.fill(); ctx.stroke()
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      shown.forEach((l, i) => {
        ctx.font = `${l.b || i === 0 ? 700 : 500} 12px ${SANS}`
        ctx.fillStyle = l.c ?? (i === 0 ? T.ink : T.mute)
        ctx.fillText(l.t, x + 10, y + 7 + i * 17)
      })
    }
    const badge = (x: number, y: number, n: number, level: Level, a: number): Rect => {
      const text = n > 1 ? `!${n}` : '!'
      ctx.font = `800 11px ${SANS}`
      const w = Math.max(17, ctx.measureText(text).width + 9)
      const h = 17
      ctx.globalAlpha = a
      ctx.fillStyle = level === 'red' ? T.red : T.amber
      ctx.beginPath(); ctx.roundRect(x - w / 2, y - h / 2, w, h, 3); ctx.fill()
      ctx.strokeStyle = T.card
      ctx.lineWidth = 1.5
      ctx.stroke()
      ctx.fillStyle = level === 'red' ? '#ffffff' : T.ink
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(text, x, y + 0.5)
      ctx.globalAlpha = 1
      return { x0: x - w / 2, y0: y - h / 2, x1: x + w / 2, y1: y + h / 2 }
    }

    // ---- frame -----------------------------------------------------------------
    let raf = 0
    let last = performance.now()
    const frame = (now: number) => {
      const dt = Math.min(0.25, Math.max(0, (now - last) / 1000))
      last = now
      const P0 = propsRef.current
      const red = P0.reduced
      const pulse = red ? 1 : 0.75 + 0.25 * Math.sin(now / 420)
      const stations = stationsRef.current
      const tracks = tracksRef.current
      const sel = P0.selected
      const k = view.k

      // -- auto layout targets (role tiers, stacked), drag/pins override -------
      const byRole = new Map<string, Station[]>()
      for (const s of stations.values()) {
        if (s.pin) continue
        const arr = byRole.get(s.node.role) ?? []
        arr.push(s)
        byRole.set(s.node.role, arr)
      }
      const target = new Map<string, P>()
      for (const [role, arr] of byRole) {
        arr.sort((a, b) => (a.node.label < b.node.label ? -1 : a.node.label > b.node.label ? 1 : 0))
        const t = tierOf(role)
        arr.forEach((s, i) => target.set(s.id, { x: t.x, y: snap(t.y + (i - (arr.length - 1) / 2) * t.sp) }))
      }
      const ease = red ? 1 : 1 - Math.exp(-dt * 6)
      for (const s of stations.values()) {
        const t = s.pin ?? target.get(s.id) ?? { x: 0, y: 0 }
        if (!s.placed) { s.x = t.x; s.y = t.y; s.placed = true }
        else if (s !== drag) { s.x += (t.x - s.x) * ease; s.y += (t.y - s.y) * ease }
      }

      // -- expansion: the selected station, if its role runs our code ---------
      const want = sel?.kind === 'node' && stations.has(sel.id) && planOf(stations.get(sel.id)!) ? sel.id : null
      let exMax = 0
      const expanded: { s: Station; pl: Plan }[] = []
      for (const s of stations.values()) {
        s.open = s.id === want
        s.ex += ((s.open ? 1 : 0) - s.ex) * (red ? 1 : 1 - Math.exp(-dt * 7))
        if (s.ex < 0.002) s.ex = 0
        if (s.ex > 0.999) s.ex = 1
        const pl = s.ex > 0 ? planOf(s) : null
        if (pl) { expanded.push({ s, pl }); exMax = Math.max(exMax, s.ex) }
      }
      // the map opens up around an expanded station to make room for its layout
      // Each side moves out uniformly (keeps the arrangement), but only by as
      // much as its nearest station needs to clear the inset.
      const splits = expanded.map(({ s: e, pl }) => {
        const bx = pl.w / 2 + 90, by = pl.h / 2 + 56
        const q = { L: 0, R: 0, U: 0, D: 0 }
        for (const s of stations.values()) {
          if (s === e) continue
          const dx = s.x - e.x, dy = s.y - e.y
          if (Math.abs(dy) < by) {
            if (dx > 10) q.R = Math.max(q.R, bx - dx)
            else if (dx < -10) q.L = Math.max(q.L, bx + dx)
          }
          if (Math.abs(dx) < bx) {
            if (dy > 10) q.D = Math.max(q.D, by - dy)
            else if (dy < -10) q.U = Math.max(q.U, by + dy)
            else if (Math.abs(dx) <= 10) q.D = Math.max(q.D, by)
          }
        }
        return { e, q }
      })
      shiftOf = (s: Station) => {
        let x = 0, y = 0
        for (const { e, q } of splits) {
          if (e === s) continue
          const dx = s.x - e.x, dy = s.y - e.y
          if (dx > 10) x += q.R * e.ex
          else if (dx < -10) x -= q.L * e.ex
          if (dy > 10 || (Math.abs(dx) <= 10 && Math.abs(dy) <= 10)) y += q.D * e.ex
          else if (dy < -10) y -= q.U * e.ex
        }
        return { x, y }
      }

      if (P0.focus && P0.focus.n !== focusN) {
        focusN = P0.focus.n
        const s = stations.get(P0.focus.id)
        if (s) { autoFit = false; panTo = D(s) }
      }
      if (panTo) {
        const cx = LEFT_PAD + (W - LEFT_PAD - Math.max(RIGHT_PAD, P0.rightInset)) / 2
        const cy = TOP_PAD + (H - TOP_PAD - BOTTOM_PAD) / 2
        const t = red ? 1 : 1 - Math.exp(-dt * 6)
        const tx = cx - panTo.x * view.k, ty = cy - panTo.y * view.k
        view.tx += (tx - view.tx) * t
        view.ty += (ty - view.ty) * t
        if (Math.abs(tx - view.tx) + Math.abs(ty - view.ty) < 1) panTo = null
      }
      if (autoFit && !drag && stations.size) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
        for (const s of stations.values()) {
          const d = D(s)
          const pl = s.ex > 0 ? planOf(s) : null
          const hw = pl ? Math.max(90, (pl.w / 2) * s.ex + 30) : 90
          const hh = pl ? Math.max(52, (pl.h / 2) * s.ex + 30) : 52
          x0 = Math.min(x0, d.x - hw); x1 = Math.max(x1, d.x + hw)
          y0 = Math.min(y0, d.y - hh); y1 = Math.max(y1, d.y + hh)
        }
        const aw = Math.max(200, W - LEFT_PAD - Math.max(RIGHT_PAD, P0.rightInset))
        const ah = Math.max(160, H - TOP_PAD - BOTTOM_PAD)
        const fk = clamp(Math.min(aw / (x1 - x0), ah / (y1 - y0)), 0.3, 1.5)
        const t = red ? 1 : 1 - Math.exp(-dt * 4)
        view.k += (fk - view.k) * t
        view.tx += (LEFT_PAD + aw / 2 - ((x0 + x1) / 2) * fk - view.tx) * t
        view.ty += (TOP_PAD + ah / 2 - ((y0 + y1) / 2) * fk - view.ty) * t
      }

      // -- paper ----------------------------------------------------------------
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.globalAlpha = 1
      ctx.fillStyle = T.paper
      ctx.fillRect(0, 0, W, H)

      const lw = Math.max(3, LW * k)
      const errTint = P0.metrics ? clamp(P0.metrics.errorRate / 10, 0, 0.7) : 0
      const newHits: Hit[] = []
      const obstacles: Rect[] = [] // for label placement
      const segs: [P, P][] = [] // drawn line segments (screen), for label placement

      // -- check jobs per station ----------------------------------------------
      for (const r of jobs.values()) r.active = false
      for (const a of P0.agents) {
        if (P0.live && a.simulated) continue
        if (!stations.has(a.targetNodeId)) continue
        let r = jobs.get(a.id)
        if (!r) {
          if (!ACTIVE_AGENT.has(a.status)) continue
          r = { id: a.id, type: a.type, note: a.note ?? '', progress: a.progress, target: a.targetNodeId, alpha: 0, active: true }
          jobs.set(a.id, r)
        }
        r.type = a.type; r.note = a.note ?? ''; r.progress = clamp(a.progress, 0, 1); r.target = a.targetNodeId
        r.active = ACTIVE_AGENT.has(a.status)
      }
      const jobsBy = new Map<string, JobR[]>()
      for (const [id, r] of jobs) {
        r.alpha = r.active ? Math.min(1, r.alpha + dt * 3) : r.alpha - dt / 1.5
        if (r.alpha <= 0 || !stations.has(r.target)) { jobs.delete(id); continue }
        const arr = jobsBy.get(r.target) ?? []
        arr.push(r)
        jobsBy.set(r.target, arr)
      }

      // -- which tracks are on the map -------------------------------------------
      const visible: Track[] = []
      for (const t of tracks.values()) {
        const s = 1 - Math.exp(-dt / 1.2) // smoothing so trains never jump
        t.sF += (Math.max(0, t.data.bytesPerSec) - t.sF) * s
        t.sR += (Math.max(0, t.data.bytesPerSecReverse) - t.sR) * s
        if (!red) {
          t.phF += trainSpeed(t.sF) * dt
          t.phR += trainSpeed(t.sR) * dt
        }
        if (!t.present) continue
        const isSel = sel?.kind === 'link' && sel.id === t.id
        const ctl = isControl(t.data.protocol) && (t.a.node.role === 'controller' || t.b.node.role === 'controller')
        if (ctl && !P0.showControl && !isSel) {
          const focusId = (id: string) => (hover?.kind === 'node' && hover.id === id) || (sel?.kind === 'node' && sel.id === id) || jobsBy.has(id)
          if (!focusId(t.a.id) && !focusId(t.b.id)) continue
        }
        visible.push(t)
      }

      // -- endpoints: station centre, or the platform that owns the port -------
      const fileOfEnd = new Map<string, string>() // `${trackId}|a|b` -> file
      const endOf = (s: Station, t: Track, outgoing: boolean, other: Station): { p: P; stub: P | null; len: number } => {
        const c = D(s)
        const pl = s.ex > 0 ? planOf(s) : null
        if (!pl) return { p: c, stub: null, len: 0 }
        const e = s.ex
        const dir = outgoing ? 'out' : 'in'
        const pe = pl.role.ports.find((q) => q.port === t.data.port && q.dir === dir) ?? pl.role.ports.find((q) => q.port === t.data.port)
        const i = pe ? pl.rows.indexOf(pe.file) : -1
        if (pe && i >= 0) {
          fileOfEnd.set(`${t.id}|${outgoing ? 'a' : 'b'}`, pe.file)
          const side = D(other).x < c.x ? -1 : 1
          const px = side < 0 ? PX_L(pl) : PX_R(pl)
          return { p: { x: c.x + px * e, y: c.y + barY(pl, i) * e }, stub: { x: side, y: 0 }, len: (pl.w / 2 - Math.abs(px)) * e + 26 }
        }
        // no owning file: the line enters through the station entrance (top)
        return { p: { x: c.x, y: c.y - (pl.h / 2) * e }, stub: { x: 0, y: -1 }, len: 26 * e }
      }
      const routes: RouteIn[] = visible.map((t) => {
        const A = endOf(t.a, t, true, t.b)
        const B = endOf(t.b, t, false, t.a)
        const stubLen = Math.max(A.len, B.len)
        return { id: t.id, pts: octiRoute(A.p, B.p, A.stub, B.stub, stubLen), rank: lineOf(t.data.protocol).rank }
      })
      const bundled = bundle(routes, SPACING)
      const nextDrawn = new Map<Track, P[]>()
      for (const t of visible) {
        const w = bundled.get(t.id)
        if (w && w.length >= 2) nextDrawn.set(t, w.map(S))
      }
      drawn = nextDrawn
      if (hoverTrack && !drawn.has(hoverTrack)) hoverTrack = null

      // other stations' labels recede slightly while an inset is open
      const dimOf = (s: Station) => 1 - 0.3 * Math.max(0, exMax - s.ex)

      // -- lines: paper casing, colour, hollow for control ---------------------
      const corner = 14 * k
      const drawTracks = (list: Track[]) => {
      const order = list.slice().sort((a, b) => lineOf(b.data.protocol).rank - lineOf(a.data.protocol).rank)
      for (const t of order) {
        const pts = drawn.get(t)!
        const ls = lineOf(t.data.protocol)
        const ctl = lineKey(t.data.protocol) === 'control'
        const isSel = sel?.kind === 'link' && sel.id === t.id
        const isHov = hoverTrack === t
        const w = ctl ? lw * 0.62 : lw
        ctx.globalAlpha = 1
        ctx.lineJoin = 'round'
        ctx.lineCap = 'butt'
        trace(pts, corner)
        if (isSel || isHov) {
          ctx.strokeStyle = isSel ? T.ink : 'rgba(27,27,26,0.45)'
          ctx.lineWidth = w + 6
          ctx.stroke()
        }
        ctx.strokeStyle = T.paper
        ctx.lineWidth = w + 2.5
        if (!isSel && !isHov) ctx.stroke()
        const http = lineKey(t.data.protocol) === 'http'
        ctx.strokeStyle = http && errTint > 0 ? mix(ls.color, T.red, errTint * 0.35) : ls.color
        ctx.lineWidth = w
        ctx.stroke()
        if (ctl) {
          ctx.strokeStyle = T.paper
          ctx.lineWidth = w * 0.45
          ctx.stroke()
        }
        for (let i = 0; i < pts.length - 1; i++) segs.push([pts[i], pts[i + 1]])
      }

      // -- trains: one per headway, each direction on its own side (left-hand running)
      for (const t of order) {
        if (lineKey(t.data.protocol) === 'control') continue
        const pts = drawn.get(t)!
        const path = measurePath(pts)
        const rev: Path = measurePath(pts.slice().reverse())
        const http = lineKey(t.data.protocol) === 'http'
        const a = 1
        const runs: [Path, number, number, string][] = [
          [path, t.sF, t.phF, http && errTint > 0 ? mix('#ffffff', T.red, errTint) : '#ffffff'],
          [rev, t.sR, t.phR, '#ffffff'],
        ]
        for (const [pth, bps, ph, fill] of runs) {
          if (bps < 1 || pth.len < 20) continue
          const hw = headway(bps) * k
          const tl = Math.max(9, 14 * k)
          const th = Math.max(3.2, lw * 0.68)
          const off = lw * 0.3
          for (let s0 = ((ph * k) % hw) + 4; s0 < pth.len - 4; s0 += hw) {
            const q = pointAt(pth, s0)
            ctx.save()
            ctx.globalAlpha = a
            ctx.translate(q.x + q.dy * off, q.y - q.dx * off)
            ctx.rotate(Math.atan2(q.dy, q.dx))
            ctx.fillStyle = fill
            capsule(-tl / 2, -th / 2, tl, th)
            ctx.fill()
            ctx.strokeStyle = T.ink
            ctx.lineWidth = 1.1
            ctx.stroke()
            // cab at the front so the direction reads even when paused
            ctx.fillStyle = T.ink
            capsule(tl / 2 - th * 0.95, -th / 2, th * 0.95, th)
            ctx.fill()
            ctx.restore()
          }
        }
      }
      ctx.globalAlpha = 1
      }
      // lines that don't serve an open station pass under its inset, like a map inset box
      const openIds = new Set(expanded.map((x) => x.s.id))
      drawTracks([...drawn.keys()].filter((t) => !openIds.has(t.a.id) && !openIds.has(t.b.id)))
      // -- station-layout insets (frame + passages) under the lines -------------
      const insetRects = new Map<string, Rect>()
      for (const { s, pl } of expanded) {
        const c = S(D(s))
        const e = s.ex
        const sc = k * e
        const r: Rect = { x0: c.x - (pl.w / 2) * sc, y0: c.y - (pl.h / 2) * sc, x1: c.x + (pl.w / 2) * sc, y1: c.y + (pl.h / 2) * sc }
        insetRects.set(s.id, r)
        obstacles.push(r)
        ctx.globalAlpha = Math.min(1, e * 1.4)
        ctx.fillStyle = 'rgba(27,27,26,0.10)'
        ctx.beginPath(); ctx.roundRect(r.x0 + 4, r.y0 + 5, r.x1 - r.x0, r.y1 - r.y0, 8); ctx.fill()
        ctx.fillStyle = T.card
        ctx.strokeStyle = T.ink
        ctx.lineWidth = 2
        ctx.beginPath(); ctx.roundRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0, 8); ctx.fill(); ctx.stroke()
        // import passages in the left gutter
        const active = new Map<string, string>() // edge key -> colour
        for (const t of visible) {
          const outgoing = t.a === s
          if (!outgoing && t.b !== s) continue
          const f = fileOfEnd.get(`${t.id}|${outgoing ? 'a' : 'b'}`)
          if (!f || intensity(t.sF + t.sR) < 0.01) continue
          for (const [x, y] of pl.pathTo.get(f) ?? []) active.set(`${x}>${y}`, lineOf(t.data.protocol).color)
        }
        const edges = pl.role.edges.filter((ed) => pl.rows.includes(ed.from) && pl.rows.includes(ed.to))
        const gx0 = -pl.w / 2 + 10
        const step = Math.min(6, 26 / Math.max(1, edges.length))
        edges.forEach((ed, j) => {
          const i0 = pl.rows.indexOf(ed.from), i1 = pl.rows.indexOf(ed.to)
          const gx = gx0 + j * step
          const ya = barY(pl, i0), yb = barY(pl, i1)
          const col = active.get(`${ed.from}>${ed.to}`)
          const pts = [{ x: PX_L(pl) - 4, y: ya }, { x: gx, y: ya }, { x: gx, y: yb }, { x: PX_L(pl) - 4, y: yb }].map((q) => ({ x: c.x + q.x * sc, y: c.y + q.y * sc }))
          ctx.strokeStyle = col ?? 'rgba(27,27,26,0.32)'
          ctx.lineWidth = col ? Math.max(1.5, 2.2 * k) : 1
          ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y)
          for (const q of pts.slice(1)) ctx.lineTo(q.x, q.y)
          ctx.stroke()
        })
        ctx.globalAlpha = 1
      }

      drawTracks([...drawn.keys()].filter((t) => openIds.has(t.a.id) || openIds.has(t.b.id)))

      // -- platforms inside insets (after lines so lines run into them) --------
      for (const { s, pl } of expanded) {
        const c = S(D(s))
        const e = s.ex
        const sc = k * e
        const r = insetRects.get(s.id)!
        const n = s.node
        ctx.globalAlpha = Math.min(1, e * 1.4)
        // header band: station name board
        ctx.fillStyle = T.ink
        ctx.beginPath(); ctx.roundRect(r.x0, r.y0, r.x1 - r.x0, INSET_HEAD * sc, [8, 8, 0, 0]); ctx.fill()
        if (e > 0.55) {
          ctx.globalAlpha = (e - 0.55) / 0.45
          ctx.textBaseline = 'middle'
          ctx.textAlign = 'left'
          ctx.fillStyle = '#ffffff'
          ctx.font = `700 ${Math.round(clamp(14 * k, 11, 17))}px ${SANS}`
          const hy = r.y0 + (INSET_HEAD * sc) / 2
          const nameW = Math.min(ctx.measureText(n.label).width, (r.x1 - r.x0) * 0.6)
          ctx.fillText(truncate(ctx, n.label, nameW + 1), r.x0 + 12, hy)
          ctx.textAlign = 'right'
          ctx.font = `700 ${Math.round(clamp(9.5 * k, 8.5, 11))}px ${SANS}`
          ctx.fillStyle = '#cfcabd'
          const right = r.x1 - (n.issues?.length ? 44 : 12)
          const room = right - (r.x0 + 12 + nameW + 14)
          const txt = truncate(ctx, `STATION LAYOUT · ${pl.role.root}`.toUpperCase(), room)
          if (room > 40) ctx.fillText(txt, right, hy)
        }
        ctx.globalAlpha = Math.min(1, e * 1.4)
        pl.rows.forEach((path, i) => {
          const f = pl.role.files.find((x) => x.path === path)
          if (!f) return
          const xl = c.x + PX_L(pl) * sc, xr = c.x + PX_R(pl) * sc
          const by = c.y + barY(pl, i) * sc
          const ry0 = c.y + rowY(pl, i) * sc
          const isF = sel?.kind === 'node' && sel.id === s.id && sel.file === path
          const isH = hover?.kind === 'file' && hover.id === s.id && hover.file === path
          if (isF || isH) {
            ctx.fillStyle = isF ? 'rgba(255,211,41,0.55)' : 'rgba(255,211,41,0.25)'
            ctx.fillRect(r.x0 + 2, ry0 + 1, r.x1 - r.x0 - 4, ROW * sc - 2)
          }
          // platform bar with a yellow edge line
          const bh = Math.max(4, 7 * sc)
          ctx.fillStyle = '#ddd6c4'
          ctx.fillRect(xl, by - bh / 2, xr - xl, bh)
          ctx.strokeStyle = T.ink
          ctx.lineWidth = 1
          ctx.strokeRect(xl, by - bh / 2, xr - xl, bh)
          ctx.fillStyle = T.hi
          ctx.fillRect(xl, by + bh / 2 - Math.max(1, 1.6 * sc), xr - xl, Math.max(1, 1.6 * sc))
          newHits.push({ kind: 'file', id: s.id, file: path, r: { x0: r.x0, y0: ry0, x1: r.x1, y1: ry0 + ROW * sc } })
          if (e < 0.6) return
          const ta = (e - 0.6) / 0.4
          ctx.globalAlpha = ta
          // platform number roundel-free tag
          const fs = Math.round(clamp(12 * k, 10, 15))
          const ty = by - bh / 2 - 4
          const tagR = fs * 0.62
          ctx.fillStyle = T.ink
          ctx.beginPath(); ctx.arc(xl + tagR, ty - tagR + 1, tagR, 0, Math.PI * 2); ctx.fill()
          ctx.fillStyle = '#ffffff'
          ctx.font = `700 ${Math.round(fs * 0.78)}px ${SANS}`
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(String(i + 1), xl + tagR, ty - tagR + 1.5)
          ctx.textAlign = 'left'
          ctx.textBaseline = 'alphabetic'
          ctx.font = `600 ${fs}px ${SANS}`
          ctx.fillStyle = T.ink
          const lx = xl + tagR * 2 + 6
          const label = truncate(ctx, f.label, (xr - lx) * 0.55)
          ctx.fillText(label, lx, ty)
          let cx = lx + ctx.measureText(label).width + 8
          // ports this platform serves, coloured by the line that uses them
          const ports = pl.role.ports.filter((q) => q.file === path)
          ctx.font = `500 ${Math.round(fs * 0.82)}px ${MONO}`
          for (const q of ports) {
            const tk = visible.find((t) => t.data.port === q.port && (t.a === s || t.b === s))
            const txt = `${q.dir} :${q.port}`
            ctx.fillStyle = tk ? lineOf(tk.data.protocol).color : T.mute
            ctx.fillText(txt, cx, ty)
            cx += ctx.measureText(txt).width + 8
          }
          ctx.textAlign = 'right'
          ctx.fillStyle = T.mute
          ctx.fillText(`${f.loc} loc`, xr, ty)
          const fi = fileIssues(n, path)
          const fl = levelOf(fi)
          if (fl) {
            const br = badge(cx + 10, ty - fs * 0.35, fi.length, fl, ta * (red ? 1 : 0.85 + 0.15 * pulse))
            newHits.push({ kind: 'badge', id: s.id, file: path, r: br })
          }
          ctx.globalAlpha = Math.min(1, e * 1.4)
        })
        ctx.globalAlpha = 1
      }

      // -- ghosts of removed stations -----------------------------------------
      for (let i = ghostsRef.current.length - 1; i >= 0; i--) {
        const g = ghostsRef.current[i]
        g.t += dt / 0.8
        if (g.t >= 1) { ghostsRef.current.splice(i, 1); continue }
        const p = S(g)
        ctx.globalAlpha = 0.5 * (1 - g.t)
        ctx.strokeStyle = T.ink
        ctx.lineWidth = 2
        ctx.beginPath(); ctx.arc(p.x, p.y, 9 * k * (1 + g.t), 0, Math.PI * 2); ctx.stroke()
        ctx.globalAlpha = 1
      }

      // -- stations ---------------------------------------------------------------
      const ends = new Map<string, { p: P; d: P; color: string; proto: string }[]>()
      for (const [t, pts] of drawn) {
        const n = pts.length
        const da = { x: pts[0].x - pts[1].x, y: pts[0].y - pts[1].y }
        const db = { x: pts[n - 1].x - pts[n - 2].x, y: pts[n - 1].y - pts[n - 2].y }
        const col = lineOf(t.data.protocol).color
        for (const [id, p, d] of [[t.a.id, pts[0], da], [t.b.id, pts[n - 1], db]] as [string, P, P][]) {
          const arr = ends.get(id) ?? []
          const L = Math.hypot(d.x, d.y) || 1
          arr.push({ p, d: { x: d.x / L, y: d.y / L }, color: col, proto: lineKey(t.data.protocol) })
          ends.set(id, arr)
        }
      }
      type LabelJob = { s: Station; m: Rect; prio: number; a: number }
      const labelJobs: LabelJob[] = []
      const badgeJobs: { id: string; x: number; y: number; level: Level; n: number; a: number }[] = []
      for (const s of stations.values()) {
        const n = s.node
        const c = S(D(s))
        if (c.x < -300 || c.y < -300 || c.x > W + 300 || c.y > H + 300) continue
        const statusA = n.status === 'deleting' ? 0.25 : n.status === 'provisioning' || n.status === 'booting' ? 0.6 : 1
        s.alpha += (statusA - s.alpha) * (1 - Math.exp(-dt * 4))
        const a = s.alpha * dimOf(s)
        const level = levelOf(n.issues ?? [])
        const isSel = sel?.kind === 'node' && sel.id === s.id
        const isHov = hover?.kind === 'node' && hover.id === s.id
        const ir = insetRects.get(s.id)
        const se = ends.get(s.id) ?? []
        const protos = new Set(se.map((x) => x.proto))
        const inter = HUBS.has(n.role) || protos.size >= 3
        const r0 = Math.max(5.5, 8 * k)
        let m: Rect
        if (ir && s.ex > 0.5) {
          m = ir
        } else {
          ctx.globalAlpha = s.alpha * (1 - s.ex)
          const booting = n.status === 'provisioning' || n.status === 'booting'
          const offline = n.status === 'offline'
          if (inter || se.length === 0 || booting) {
            let x0 = c.x, y0 = c.y, x1 = c.x, y1 = c.y
            if (inter) for (const e of se) { x0 = Math.min(x0, e.p.x); x1 = Math.max(x1, e.p.x); y0 = Math.min(y0, e.p.y); y1 = Math.max(y1, e.p.y) }
            const rr = inter ? r0 : r0 * 0.9
            if (inter && x1 - x0 < r0 && y1 - y0 < r0) {
              // lines meet at one point: still draw a capsule, across the main direction of travel
              let ax = 0, ay = 0
              for (const e of se) { ax += Math.abs(e.d.x); ay += Math.abs(e.d.y) }
              const half = r0 * 0.9
              if (ax >= ay && se.length > 0) { y0 = c.y - half; y1 = c.y + half } else { x0 = c.x - half; x1 = c.x + half }
            }
            m = { x0: x0 - rr, y0: y0 - rr, x1: x1 + rr, y1: y1 + rr }
            ctx.fillStyle = offline ? '#e3ddcf' : '#ffffff'
            ctx.strokeStyle = offline ? T.red : T.ink
            ctx.lineWidth = Math.max(2, 2.8 * k)
            if (booting) ctx.setLineDash([3, 3])
            ctx.beginPath(); ctx.roundRect(m.x0, m.y0, m.x1 - m.x0, m.y1 - m.y0, rr); ctx.fill(); ctx.stroke()
            ctx.setLineDash([])
          } else if (se.length === 1) {
            // terminus tick across the line end, in the line colour
            const e = se[0]
            const nx = -e.d.y, ny = e.d.x
            const L = lw * 1.5
            ctx.strokeStyle = offline ? T.red : e.color
            ctx.lineWidth = lw * 0.95
            ctx.lineCap = 'butt'
            ctx.beginPath(); ctx.moveTo(e.p.x - nx * L, e.p.y - ny * L); ctx.lineTo(e.p.x + nx * L, e.p.y + ny * L); ctx.stroke()
            m = { x0: e.p.x - Math.abs(nx * L) - lw / 2, y0: e.p.y - Math.abs(ny * L) - lw / 2, x1: e.p.x + Math.abs(nx * L) + lw / 2, y1: e.p.y + Math.abs(ny * L) + lw / 2 }
          } else {
            // ordinary stop: white disc with an ink ring
            const rr = r0 * 0.95
            ctx.fillStyle = '#ffffff'
            ctx.strokeStyle = offline ? T.red : T.ink
            ctx.lineWidth = Math.max(2, 2.6 * k)
            ctx.beginPath(); ctx.arc(c.x, c.y, rr, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
            m = { x0: c.x - rr, y0: c.y - rr, x1: c.x + rr, y1: c.y + rr }
          }
          if (isSel || isHov) {
            ctx.strokeStyle = isSel ? T.ink : 'rgba(27,27,26,0.5)'
            ctx.lineWidth = 1.5
            ctx.setLineDash(isSel ? [] : [3, 3])
            ctx.beginPath(); ctx.roundRect(m.x0 - 6, m.y0 - 6, m.x1 - m.x0 + 12, m.y1 - m.y0 + 12, 6); ctx.stroke()
            ctx.setLineDash([])
          }
          ctx.globalAlpha = 1
        }
        obstacles.push(m)
        const mcx = (m.x0 + m.x1) / 2, mcy = (m.y0 + m.y1) / 2
        const mr = Math.hypot(m.x1 - m.x0, m.y1 - m.y0) / 2
        // boot progress (provisioning / booting)
        if ((n.status === 'provisioning' || n.status === 'booting') && !ir) {
          const tt = (now - s.bootStart) / 1000
          const prog = n.status === 'provisioning' ? 0.4 * (1 - Math.exp(-tt / 3)) : 0.4 + 0.55 * (1 - Math.exp(-tt / 5))
          ctx.strokeStyle = LINES.http.color
          ctx.lineWidth = 2
          ctx.beginPath(); ctx.arc(mcx, mcy, mr + 7, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * prog); ctx.stroke()
        }
        // running check jobs: "engineering works" — a hatched arc per job, length = progress
        const js = jobsBy.get(s.id) ?? []
        js.forEach((r, i) => {
          ctx.globalAlpha = r.alpha
          const prog = Math.max(0.08, r.progress)
          const stripe = (draw: () => void) => {
            ctx.lineCap = 'butt'
            ctx.strokeStyle = T.hi
            ctx.lineWidth = 4.5
            ctx.setLineDash([])
            draw()
            ctx.strokeStyle = T.ink
            ctx.setLineDash([3, 3])
            draw()
            ctx.setLineDash([])
          }
          if (ir) {
            // engineering works along the inset's bottom edge
            const y = ir.y1 + 7 + i * 7
            stripe(() => { ctx.beginPath(); ctx.moveTo(ir.x0, y); ctx.lineTo(ir.x0 + (ir.x1 - ir.x0) * prog, y); ctx.stroke() })
          } else {
            const R = mr + 8 + i * 7
            const end = -Math.PI / 2 + Math.PI * 2 * prog
            stripe(() => { ctx.beginPath(); ctx.arc(mcx, mcy, R, -Math.PI / 2, end); ctx.stroke() })
          }
          ctx.globalAlpha = 1
        })
        const tag = n.status === 'provisioning' || n.status === 'booting' || n.status === 'deleting' || n.status === 'offline' ? n.status.toUpperCase() : ''
        if (tag) {
          ctx.font = `800 ${Math.round(clamp(9.5 * k, 8.5, 11))}px ${SANS}`
          const tw = ctx.measureText(tag).width + 8
          const ty = m.y0 - 12 - js.length * 7
          ctx.fillStyle = n.status === 'offline' ? T.red : T.ink
          ctx.fillRect(mcx - tw / 2, ty - 7, tw, 14)
          ctx.fillStyle = '#ffffff'
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(tag, mcx, ty + 0.5)
          obstacles.push({ x0: mcx - tw / 2, y0: ty - 7, x1: mcx + tw / 2, y1: ty + 7 })
        }
        // an open inset's own frame sits beneath its platforms in hit order
        const under = ir && s.ex > 0.5 ? newHits.findIndex((h) => h.kind !== 'node' && h.id === s.id) : -1
        newHits.splice(under >= 0 ? under : newHits.length, 0, { kind: 'node', id: s.id, r: ir && s.ex > 0.5 ? ir : { x0: m.x0 - 4, y0: m.y0 - 4, x1: m.x1 + 4, y1: m.y1 + 4 } })
        if (!ir || s.ex <= 0.5) labelJobs.push({ s, m, prio: (isSel || isHov ? 100 : 0) + (inter ? 5 : 2) + (level ? 3 : 0), a })
        const ni = (n.issues ?? []).length
        if (ni > 0 && level) {
          if (ir && s.ex > 0.5) badgeJobs.push({ id: s.id, x: ir.x1 - 20, y: ir.y0 + (INSET_HEAD * k * s.ex) / 2, level, n: ni, a: 1 })
          else badgeJobs.push({ id: s.id, x: m.x1 + 6, y: m.y0 - 6, level, n: ni, a: 1 })
        }
      }

      // -- bursts when a station gains a new real issue ------------------------
      for (let i = burstsRef.current.length - 1; i >= 0; i--) {
        const bu = burstsRef.current[i]
        bu.age += dt
        const s = stations.get(bu.id)
        if (bu.age >= 0.9 || !s || red) { burstsRef.current.splice(i, 1); continue }
        const tt = bu.age / 0.9
        const p = S(D(s))
        ctx.globalAlpha = (1 - tt) * 0.8
        ctx.strokeStyle = bu.color
        ctx.lineWidth = 2
        ctx.beginPath(); ctx.arc(p.x, p.y, 12 * k + tt * 30, 0, Math.PI * 2); ctx.stroke()
        ctx.globalAlpha = 1
      }

      // -- disruption badges, kept apart -----------------------------------------
      for (let it = 0; it < 8; it++) {
        for (let i = 0; i < badgeJobs.length; i++) {
          for (let j = i + 1; j < badgeJobs.length; j++) {
            const A = badgeJobs[i], B = badgeJobs[j]
            let dx = B.x - A.x, dy = B.y - A.y
            let d = Math.hypot(dx, dy)
            if (d >= 26) continue
            if (d < 0.01) { dx = 1; dy = -0.4; d = 1 }
            const push = (26 - d) / 2
            A.x -= (dx / d) * push; A.y -= (dy / d) * push
            B.x += (dx / d) * push; B.y += (dy / d) * push
          }
        }
      }
      for (const bj of badgeJobs) {
        const r = badge(bj.x, bj.y, bj.n, bj.level, bj.a * (red ? 1 : 0.85 + 0.15 * pulse))
        obstacles.push(r)
        newHits.push({ kind: 'badge', id: bj.id, r })
      }

      // -- station names: pick the side that avoids lines, markers and badges ----
      {
        const placed: Rect[] = []
        const over = (a: Rect, b: Rect) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0
        const nameFs = Math.round(clamp(13.5 * k, 11, 16))
        const ipFs = Math.round(clamp(10 * k, 9, 11.5))
        for (const j of labelJobs.sort((a, b) => b.prio - a.prio)) {
          const n = j.s.node
          ctx.font = `700 ${nameFs}px ${SANS}`
          const name = truncate(ctx, n.label, 180)
          const nw = ctx.measureText(name).width
          ctx.font = `500 ${ipFs}px ${MONO}`
          const ip = n.privateIp && n.privateIp !== '—' ? n.privateIp : ''
          const iw = ip ? ctx.measureText(ip).width : 0
          const w = Math.max(nw, iw)
          const h = nameFs + (ip ? ipFs + 5 : 2)
          const m = j.m
          const cy = (m.y0 + m.y1) / 2, cx = (m.x0 + m.x1) / 2
          const g = 8
          const cands: { r: Rect; al: CanvasTextAlign }[] = [
            { r: { x0: m.x1 + g, y0: cy - h / 2, x1: m.x1 + g + w, y1: cy + h / 2 }, al: 'left' },
            { r: { x0: m.x0 - g - w, y0: cy - h / 2, x1: m.x0 - g, y1: cy + h / 2 }, al: 'right' },
            { r: { x0: cx - w / 2, y0: m.y1 + g, x1: cx + w / 2, y1: m.y1 + g + h }, al: 'center' },
            { r: { x0: cx - w / 2, y0: m.y0 - g - h, x1: cx + w / 2, y1: m.y0 - g }, al: 'center' },
            { r: { x0: m.x1 + g - 4, y0: m.y1 + 2, x1: m.x1 + g - 4 + w, y1: m.y1 + 2 + h }, al: 'left' },
            { r: { x0: m.x0 - g + 4 - w, y0: m.y1 + 2, x1: m.x0 - g + 4, y1: m.y1 + 2 + h }, al: 'right' },
            { r: { x0: m.x1 + g - 4, y0: m.y0 - 2 - h, x1: m.x1 + g - 4 + w, y1: m.y0 - 2 }, al: 'left' },
            { r: { x0: m.x0 - g + 4 - w, y0: m.y0 - 2 - h, x1: m.x0 - g + 4, y1: m.y0 - 2 }, al: 'right' },
          ]
          let best: { r: Rect; al: CanvasTextAlign } | null = null
          let bestScore = Infinity
          for (const cnd of cands) {
            let sc = 0
            for (const q of placed) if (over(cnd.r, q)) sc += 1000
            for (const q of obstacles) if (q !== m && over(cnd.r, q)) sc += 400
            for (const [a, b] of segs) if (segHitsRect(a, b, cnd.r, lw / 2 + 1)) sc += 30
            if (cnd.r.x0 < 4 || cnd.r.x1 > W - 4 || cnd.r.y0 < TOP_PAD - 8 || cnd.r.y1 > H - BOTTOM_PAD + 6) sc += 200
            if (sc < bestScore) { bestScore = sc; best = cnd }
            if (sc === 0) break
          }
          if (!best || (bestScore >= 400 && j.prio < 100)) continue
          placed.push(best.r)
          const a = Math.max(0.45, j.a)
          const tx = best.al === 'left' ? best.r.x0 : best.al === 'right' ? best.r.x1 : (best.r.x0 + best.r.x1) / 2
          ctx.globalAlpha = a
          ctx.textAlign = best.al
          ctx.textBaseline = 'top'
          ctx.font = `700 ${nameFs}px ${SANS}`
          ctx.fillStyle = n.status === 'offline' ? T.red : T.ink
          ctx.fillText(name, tx, best.r.y0)
          ctx.font = `500 ${ipFs}px ${MONO}`
          ctx.fillStyle = T.mute
          if (ip) ctx.fillText(ip, tx, best.r.y0 + nameFs + 3)
          ctx.globalAlpha = 1
        }
      }

      hits = newHits
      if (hover) {
        const h = hover
        hover = hits.find((x) => x.kind === h.kind && x.id === h.id && x.file === h.file) ?? null
      }

      // -- tooltips -------------------------------------------------------------
      if (!press && mouse) {
        if (hover?.kind === 'node') {
          const s = stations.get(hover.id)
          if (s) {
            const n = s.node
            const lines: { t: string; c?: string; b?: boolean }[] = [
              { t: `${n.label}  ·  ${n.role}  ·  ${n.status}` },
              { t: `${n.privateIp}  /  ${n.publicIp}` },
              { t: `${n.region}  ·  ${n.type}` },
            ]
            if (n.status === 'running') lines.push({ t: `cpu ${Math.round(n.cpu * 100)}%   mem ${fmtMem(n.memUsed, n.memTotal)}   load ${n.load1}` })
            for (const pr of n.processes.slice(0, 4)) lines.push({ t: `  ${pr.name}${pr.ports.length ? ' :' + pr.ports.join(',') : ''}` })
            if (n.processes.length > 4) lines.push({ t: `  +${n.processes.length - 4} more (select for detail)` })
            for (const r of jobsBy.get(n.id) ?? []) if (r.active) lines.push({ t: `works: check ${r.type} ${Math.round(r.progress * 100)}%  ${r.note}`, c: T.ink, b: true })
            const ni = (n.issues ?? []).length
            if (ni) lines.push({ t: `${ni} disruption${ni > 1 ? 's' : ''} — select for detail`, c: levelOf(n.issues ?? []) === 'amber' ? '#9a6a00' : T.red, b: true })
            if (planOf(s) && s.ex < 0.5) lines.push({ t: 'click for the station layout (files)' })
            tooltip(lines, hover.r)
          }
        } else if (hover?.kind === 'file') {
          const s = stations.get(hover.id)
          const pl = s ? planOf(s) : null
          const f = pl?.role.files.find((x) => x.path === hover!.file)
          if (s && pl && f) {
            const ports = pl.role.ports.filter((q) => q.file === f.path).map((q) => `${q.dir} :${q.port}`)
            const imports = pl.role.edges.filter((e) => e.from === f.path).length
            const lines: { t: string; c?: string; b?: boolean }[] = [{ t: f.path }, { t: `${f.loc} loc  ·  imports ${imports}${ports.length ? '  ·  ' + ports.join(', ') : ''}` }]
            for (const i of fileIssues(s.node, f.path).slice(0, 2)) lines.push({ t: `${i.severity.toUpperCase()}  ${i.title}`, c: (SEV_RANK[i.severity] ?? 0) >= 3 ? T.red : '#9a6a00', b: true })
            tooltip(lines, mouse)
          }
        } else if (hover?.kind === 'badge') {
          const s = stations.get(hover.id)
          const src = s ? (hover.file ? fileIssues(s.node, hover.file) : s.node.issues ?? []) : []
          const iss = src.slice().sort((x, y) => (SEV_RANK[y.severity] ?? 0) - (SEV_RANK[x.severity] ?? 0))
          if (s && iss.length) {
            const lines: { t: string; c?: string; b?: boolean }[] = [{ t: `${iss[0].severity.toUpperCase()}  ${iss[0].title}`, c: (SEV_RANK[iss[0].severity] ?? 0) >= 3 ? T.red : '#9a6a00' }]
            if (iss.length > 1) lines.push({ t: `+${iss.length - 1} more at ${s.node.label}` })
            tooltip(lines, hover.r)
          }
        } else if (hoverTrack) {
          const t = hoverTrack
          tooltip([
            { t: `${lineOf(t.data.protocol).name} line  ·  ${t.data.protocol} :${t.data.port}  ·  ${t.data.conns} conns` },
            { t: `${t.a.node.label} → ${t.b.node.label}   ${fmtRate(t.sF)}` },
            { t: `${t.b.node.label} → ${t.a.node.label}   ${fmtRate(t.sR)}` },
          ], mouse)
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

  return <canvas ref={canvasRef} className="tr-canvas" />
}
