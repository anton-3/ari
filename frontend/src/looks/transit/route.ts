// Octilinear routing + parallel-line bundling for the transit look.
// Every route uses only 0°/45°/90° segments (Beck/Vignelli rule). Lines that
// share a corridor are offset side by side, in a stable global order, so they
// run in parallel instead of on top of each other.

export interface P {
  x: number
  y: number
}

const EPS = 0.5

/** Octilinear route a → b. Optional stubs leave/enter along a fixed direction first. */
export function octiRoute(a: P, b: P, stubA: P | null = null, stubB: P | null = null, stubLen = 0): P[] {
  const pts: P[] = [a]
  const p = stubA ? { x: a.x + stubA.x * stubLen, y: a.y + stubA.y * stubLen } : a
  const q = stubB ? { x: b.x + stubB.x * stubLen, y: b.y + stubB.y * stubLen } : b
  if (stubA) pts.push(p)
  const dx = q.x - p.x
  const dy = q.y - p.y
  const adx = Math.abs(dx)
  const ady = Math.abs(dy)
  const sx = Math.sign(dx) || 1
  const sy = Math.sign(dy) || 1
  if (adx < EPS || ady < EPS || Math.abs(adx - ady) < EPS) {
    // already straight
  } else if (adx > ady) {
    // horizontal – diagonal – horizontal, diagonal in the middle
    const h = (adx - ady) / 2
    pts.push({ x: p.x + sx * h, y: p.y })
    pts.push({ x: p.x + sx * (h + ady), y: q.y })
  } else {
    const v = (ady - adx) / 2
    pts.push({ x: p.x, y: p.y + sy * v })
    pts.push({ x: q.x, y: p.y + sy * (v + adx) })
  }
  if (stubB) pts.push(q)
  pts.push(b)
  return simplify(pts)
}

function simplify(pts: P[]): P[] {
  const out: P[] = []
  for (const p of pts) {
    const l = out[out.length - 1]
    if (l && Math.abs(l.x - p.x) < 0.01 && Math.abs(l.y - p.y) < 0.01) continue
    out.push(p)
  }
  // merge collinear runs
  let i = 1
  while (i < out.length - 1) {
    const a = out[i - 1], b = out[i], c = out[i + 1]
    const cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
    const dot = (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)
    if (Math.abs(cr) < 0.01 && dot > 0) out.splice(i, 1)
    else i++
  }
  return out
}

export interface RouteIn {
  id: string
  pts: P[]
  rank: number
}

interface Seg {
  ri: number
  si: number
  key: string
  t0: number
  t1: number
  nx: number
  ny: number
}

/** Offset each route so that lines sharing a corridor run side by side. */
export function bundle(routes: RouteIn[], spacing: number): Map<string, P[]> {
  const segs: Seg[] = []
  const groups = new Map<string, Seg[]>()
  routes.forEach((r, ri) => {
    for (let si = 0; si < r.pts.length - 1; si++) {
      const a = r.pts[si], b = r.pts[si + 1]
      let dx = b.x - a.x, dy = b.y - a.y
      const L = Math.hypot(dx, dy)
      if (L < 0.01) continue
      dx /= L; dy /= L
      // canonical direction: +x, or +y when vertical
      if (dx < -1e-6 || (Math.abs(dx) < 1e-6 && dy < 0)) { dx = -dx; dy = -dy }
      const nx = -dy, ny = dx
      const c = nx * a.x + ny * a.y
      const ta = dx * a.x + dy * a.y
      const tb = dx * b.x + dy * b.y
      const key = `${Math.round(dx * 100)},${Math.round(dy * 100)}|${Math.round(c * 2) / 2}`
      const s: Seg = { ri, si, key, t0: Math.min(ta, tb), t1: Math.max(ta, tb), nx, ny }
      segs.push(s)
      const g = groups.get(key) ?? []
      g.push(s)
      groups.set(key, g)
    }
  })
  const order = (ri: number) => routes[ri]
  const offsets = routes.map((r) => new Array<{ ox: number; oy: number }>(Math.max(0, r.pts.length - 1)).fill({ ox: 0, oy: 0 }))
  for (const s of segs) {
    const g = groups.get(s.key) ?? []
    const members = new Set<number>([s.ri])
    for (const o of g) {
      if (o.ri === s.ri) continue
      const ov = Math.min(s.t1, o.t1) - Math.max(s.t0, o.t0)
      if (ov > 1) members.add(o.ri)
    }
    if (members.size === 1) continue
    const sorted = [...members].sort((x, y) => order(x).rank - order(y).rank || (order(x).id < order(y).id ? -1 : 1))
    const idx = sorted.indexOf(s.ri)
    const off = (idx - (sorted.length - 1) / 2) * spacing
    offsets[s.ri][s.si] = { ox: s.nx * off, oy: s.ny * off }
  }
  const out = new Map<string, P[]>()
  routes.forEach((r, ri) => {
    const pts = r.pts
    if (pts.length < 2) { out.set(r.id, pts.slice()); return }
    const o = offsets[ri]
    const res: P[] = [{ x: pts[0].x + o[0].ox, y: pts[0].y + o[0].oy }]
    for (let i = 1; i < pts.length - 1; i++) {
      const a0 = { x: pts[i - 1].x + o[i - 1].ox, y: pts[i - 1].y + o[i - 1].oy }
      const a1 = { x: pts[i].x + o[i - 1].ox, y: pts[i].y + o[i - 1].oy }
      const b0 = { x: pts[i].x + o[i].ox, y: pts[i].y + o[i].oy }
      const b1 = { x: pts[i + 1].x + o[i].ox, y: pts[i + 1].y + o[i].oy }
      const hit = intersect(a0, a1, b0, b1)
      if (hit) res.push(hit)
      else { res.push(a1); res.push(b0) }
    }
    const n = pts.length - 1
    res.push({ x: pts[n].x + o[n - 1].ox, y: pts[n].y + o[n - 1].oy })
    out.set(r.id, res)
  })
  return out
}

function intersect(a0: P, a1: P, b0: P, b1: P): P | null {
  const d1x = a1.x - a0.x, d1y = a1.y - a0.y
  const d2x = b1.x - b0.x, d2y = b1.y - b0.y
  const den = d1x * d2y - d1y * d2x
  if (Math.abs(den) < 1e-6) return null
  const t = ((b0.x - a0.x) * d2y - (b0.y - a0.y) * d2x) / den
  return { x: a0.x + d1x * t, y: a0.y + d1y * t }
}

/** Polyline with cumulative arc lengths, for placing trains along it. */
export interface Path {
  pts: P[]
  cum: number[]
  len: number
}
export function measurePath(pts: P[]): Path {
  const cum = [0]
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y))
  return { pts, cum, len: cum[cum.length - 1] ?? 0 }
}
/** Point + unit direction at arc length s. */
export function pointAt(path: Path, s: number): { x: number; y: number; dx: number; dy: number } {
  const { pts, cum } = path
  let i = 1
  while (i < pts.length - 1 && cum[i] < s) i++
  const a = pts[i - 1], b = pts[i]
  const L = cum[i] - cum[i - 1] || 1
  const t = Math.min(1, Math.max(0, (s - cum[i - 1]) / L))
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, dx: (b.x - a.x) / L, dy: (b.y - a.y) / L }
}

export function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay
  const L = dx * dx + dy * dy || 1
  const t = Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / L))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/** Does segment a-b intersect the axis-aligned rect (inflated by pad)? */
export function segHitsRect(a: P, b: P, r: { x0: number; y0: number; x1: number; y1: number }, pad = 0): boolean {
  const x0 = r.x0 - pad, y0 = r.y0 - pad, x1 = r.x1 + pad, y1 = r.y1 + pad
  // Liang–Barsky
  let t0 = 0, t1 = 1
  const dx = b.x - a.x, dy = b.y - a.y
  const clip = (p: number, q: number) => {
    if (Math.abs(p) < 1e-9) return q >= 0
    const t = q / p
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t }
    else { if (t < t0) return false; if (t < t1) t1 = t }
    return true
  }
  return clip(-dx, a.x - x0) && clip(dx, x1 - a.x) && clip(-dy, a.y - y0) && clip(dy, y1 - a.y)
}
