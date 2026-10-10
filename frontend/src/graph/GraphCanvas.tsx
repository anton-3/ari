import { useEffect, useRef } from 'react'
import type {
  Agent,
  AgentEvent,
  Metrics,
  RepoGraph,
  Topology,
} from './types'

// ---------------------------------------------------------------------------
// Palette — restrained 3b1b-style dark aesthetic.
// ---------------------------------------------------------------------------
const COLORS = {
  bg: '#05060a',
  edge: 'rgba(120, 160, 210, 0.10)',
  edgeInfra: 'rgba(90, 220, 235, 0.16)',
  cyan: '#22d3ee',
  teal: '#2dd4bf',
  violet: '#a78bfa',
  amber: '#fbbf24',
  red: '#f87171',
  green: '#34d399',
  text: 'rgba(226, 240, 255, 0.92)',
  textDim: 'rgba(150, 175, 205, 0.55)',
}

const HUB_COLOR: Record<string, string> = {
  traffic: COLORS.cyan,
  waf: COLORS.teal,
  lb: COLORS.teal,
  api: COLORS.violet,
  auth: COLORS.amber,
  db: COLORS.green,
  cache: COLORS.teal,
}

const AGENT_COLOR: Record<string, string> = {
  // Mock agent types.
  scanner: COLORS.cyan,
  patcher: COLORS.green,
  auditor: COLORS.violet,
  sentinel: COLORS.amber,
  tracer: COLORS.teal,
  // Live telemetry agent types.
  'log-watcher': COLORS.amber,
  verifier: COLORS.violet,
  remediator: COLORS.green,
}

const HUB_ANCHOR: Record<string, [number, number]> = {
  traffic: [0.1, 0.52],
  waf: [0.24, 0.34],
  lb: [0.34, 0.68],
  api: [0.52, 0.46],
  auth: [0.5, 0.72],
  db: [0.72, 0.56],
  cache: [0.68, 0.3],
}

// ---------------------------------------------------------------------------
// Simulation data structures.
// ---------------------------------------------------------------------------
interface SimNode {
  id: string
  label: string
  kind: 'hub' | 'file' | 'ari'
  group: string
  hubType: string | null
  status: string | null
  loc: number
  x: number
  y: number
  vx: number
  vy: number
  r: number
  anchorX: number | null
  anchorY: number | null
  anchorK: number
}

interface SimEdge {
  a: number
  b: number
  infra: boolean
}

interface Particle {
  edge: number
  t: number
  speed: number
  error: boolean
  infra: boolean
}

interface AgentRender {
  x: number
  y: number
  type: string
  label: string
  status: string
  progress: number
  targetId: string
  alpha: number
  phase: number
  seen: boolean
}

interface Burst {
  x: number
  y: number
  age: number
  life: number
  color: string
}

interface Scene {
  nodes: SimNode[]
  index: Map<string, number>
  edges: SimEdge[]
  infraEdges: number[]
  W: number
  H: number
}

interface Props {
  repoGraph: RepoGraph | null
  topology: Topology | null
  metrics: Metrics | null
  agents: Agent[]
  events: AgentEvent[]
}

const BOTTOM_PAD = 150 // reserved space for the reasoning caption
const TOP_PAD = 24

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
}

function hubRadius(status: string | null): number {
  return status === 'down' ? 20 : 22
}

export default function GraphCanvas({
  repoGraph,
  topology,
  metrics,
  agents,
  events,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const sceneRef = useRef<Scene | null>(null)
  const particlesRef = useRef<Particle[]>([])
  const agentsRef = useRef<Map<string, AgentRender>>(new Map())
  const burstsRef = useRef<Burst[]>([])
  const processedRef = useRef<Set<string>>(new Set())
  const spawnAccRef = useRef(0)

  // Latest props mirrored into refs for the rAF loop.
  const dataRef = useRef<Props>({ repoGraph, topology, metrics, agents, events })
  dataRef.current = { repoGraph, topology, metrics, agents, events }

  const reduced =
    typeof window !== 'undefined' &&
    window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches

  // ---- Build / rebuild the scene when graph structure changes -------------
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const W = canvas.clientWidth || window.innerWidth
    const H = canvas.clientHeight || window.innerHeight

    const prev = sceneRef.current
    const prevPos = new Map<string, { x: number; y: number }>()
    if (prev) for (const n of prev.nodes) prevPos.set(n.id, { x: n.x, y: n.y })

    const nodes: SimNode[] = []
    const index = new Map<string, number>()
    const usableH = H - BOTTOM_PAD - TOP_PAD

    const place = (fx: number, fy: number) => ({
      x: lerp(W * 0.12, W * 0.88, fx) + (Math.random() - 0.5) * 20,
      y: TOP_PAD + usableH * fy + (Math.random() - 0.5) * 20,
    })

    const addNode = (n: Omit<SimNode, 'vx' | 'vy' | 'x' | 'y'> & { x: number; y: number }) => {
      const kept = prevPos.get(n.id)
      index.set(n.id, nodes.length)
      nodes.push({ ...n, x: kept?.x ?? n.x, y: kept?.y ?? n.y, vx: 0, vy: 0 })
    }

    // Ari — the always-on brain, anchored near the top centre.
    {
      const p = place(0.5, 0.12)
      addNode({
        id: '__ari__',
        label: 'Ari',
        kind: 'ari',
        group: 'ari',
        hubType: null,
        status: null,
        loc: 0,
        x: p.x,
        y: p.y,
        r: 16,
        anchorX: W * 0.5,
        anchorY: TOP_PAD + usableH * 0.12,
        anchorK: 0.02,
      })
    }

    // Infra hubs.
    const topo = dataRef.current.topology
    if (topo) {
      for (const h of topo.nodes) {
        const anchor = HUB_ANCHOR[h.type] ?? [Math.random() * 0.6 + 0.2, Math.random() * 0.5 + 0.3]
        const p = place(anchor[0], anchor[1])
        addNode({
          id: h.id,
          label: h.label,
          kind: 'hub',
          group: 'infra',
          hubType: h.type,
          status: h.status,
          loc: 0,
          x: p.x,
          y: p.y,
          r: hubRadius(h.status),
          anchorX: lerp(W * 0.12, W * 0.88, anchor[0]),
          anchorY: TOP_PAD + usableH * anchor[1],
          anchorK: 0.012,
        })
      }
    }

    // Repo files, scattered to cluster by dir under the physics pass.
    const repo = dataRef.current.repoGraph
    if (repo) {
      for (const f of repo.nodes) {
        const p = place(Math.random(), Math.random() * 0.7 + 0.2)
        addNode({
          id: f.id,
          label: f.label,
          kind: 'file',
          group: f.dir,
          hubType: null,
          status: f.kind,
          loc: f.loc,
          x: p.x,
          y: p.y,
          r: Math.max(3, Math.min(8, 3 + Math.sqrt(f.loc) / 6)),
          anchorX: null,
          anchorY: null,
          anchorK: 0,
        })
      }
    }

    // Edges — infra + repo, only where both endpoints exist.
    const edges: SimEdge[] = []
    const infraEdges: number[] = []
    const addEdges = (list: { from: string; to: string }[], infra: boolean) => {
      for (const e of list) {
        const a = index.get(e.from)
        const b = index.get(e.to)
        if (a === undefined || b === undefined || a === b) continue
        if (infra) infraEdges.push(edges.length)
        edges.push({ a, b, infra })
      }
    }
    if (topo) addEdges(topo.edges, true)
    if (repo) addEdges(repo.edges, false)

    sceneRef.current = { nodes, index, edges, infraEdges, W, H }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoGraph, topology])

  // ---- Animation loop -----------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let raf = 0
    let dpr = Math.min(window.devicePixelRatio || 1, 2)

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      const w = window.innerWidth
      const h = window.innerHeight
      canvas.width = Math.floor(w * dpr)
      canvas.height = Math.floor(h * dpr)
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      const scene = sceneRef.current
      if (scene) {
        scene.W = w
        scene.H = h
      }
    }
    resize()
    window.addEventListener('resize', resize)

    const particleCap = reduced ? 120 : 520

    // ---- Physics step ------------------------------------------------------
    const physics = (scene: Scene) => {
      const { nodes, edges, W, H } = scene
      const centerX = W / 2
      const centerY = TOP_PAD + (H - BOTTOM_PAD - TOP_PAD) / 2

      // Dir-cluster centroids for file gravity.
      const centroid: Record<string, { x: number; y: number; n: number }> = {}
      for (const n of nodes) {
        if (n.kind !== 'file') continue
        const c = (centroid[n.group] ??= { x: 0, y: 0, n: 0 })
        c.x += n.x
        c.y += n.y
        c.n += 1
      }
      for (const k in centroid) {
        centroid[k].x /= centroid[k].n
        centroid[k].y /= centroid[k].n
      }

      // Repulsion (O(n^2) — small n).
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i]
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j]
          let dx = a.x - b.x
          let dy = a.y - b.y
          let d2 = dx * dx + dy * dy
          if (d2 < 0.01) {
            dx = Math.random() - 0.5
            dy = Math.random() - 0.5
            d2 = 0.01
          }
          const minDist = (a.r + b.r) * 2.2
          const rep = (a.kind === 'hub' || b.kind === 'hub' ? 2600 : 1400) / d2
          const d = Math.sqrt(d2)
          const fx = (dx / d) * rep
          const fy = (dy / d) * rep
          a.vx += fx
          a.vy += fy
          b.vx -= fx
          b.vy -= fy
          if (d < minDist) {
            const push = (minDist - d) * 0.04
            a.vx += (dx / d) * push
            a.vy += (dy / d) * push
            b.vx -= (dx / d) * push
            b.vy -= (dy / d) * push
          }
        }
      }

      // Springs along edges.
      for (const e of edges) {
        const a = nodes[e.a]
        const b = nodes[e.b]
        const dx = b.x - a.x
        const dy = b.y - a.y
        const d = Math.sqrt(dx * dx + dy * dy) || 1
        const rest = e.infra ? 150 : 70
        const k = e.infra ? 0.012 : 0.02
        const f = (d - rest) * k
        const fx = (dx / d) * f
        const fy = (dy / d) * f
        a.vx += fx
        a.vy += fy
        b.vx -= fx
        b.vy -= fy
      }

      for (const n of nodes) {
        // Centering + cluster gravity.
        n.vx += (centerX - n.x) * 0.0012
        n.vy += (centerY - n.y) * 0.0012
        if (n.kind === 'file') {
          const c = centroid[n.group]
          if (c) {
            n.vx += (c.x - n.x) * 0.006
            n.vy += (c.y - n.y) * 0.006
          }
        }
        // Soft anchors (Ari + hubs keep a readable pipeline layout).
        if (n.anchorX !== null && n.anchorY !== null) {
          n.vx += (n.anchorX - n.x) * n.anchorK
          n.vy += (n.anchorY - n.y) * n.anchorK
        }
        // Integrate with damping + velocity clamp.
        n.vx *= 0.82
        n.vy *= 0.82
        const vmax = 6
        n.vx = Math.max(-vmax, Math.min(vmax, n.vx))
        n.vy = Math.max(-vmax, Math.min(vmax, n.vy))
        n.x += n.vx
        n.y += n.vy
        // Keep inside the usable area.
        const m = n.r + 12
        n.x = Math.max(m, Math.min(W - m, n.x))
        n.y = Math.max(TOP_PAD + m, Math.min(H - BOTTOM_PAD - m, n.y))
      }
    }

    // ---- Traffic particles -------------------------------------------------
    const spawnParticles = (scene: Scene, m: Metrics | null) => {
      const particles = particlesRef.current
      const rps = m?.rps ?? 400
      const errRate = m?.errorRate ?? 1
      const surge = m?.mode === 'surge'
      const perFrame = Math.min(6, Math.max(0.3, rps / 420)) * (reduced ? 0.3 : 1)
      spawnAccRef.current += perFrame
      const errFrac = Math.min(0.6, errRate / 8)
      const infra = scene.infraEdges
      const allEdges = scene.edges
      while (spawnAccRef.current >= 1 && particles.length < particleCap) {
        spawnAccRef.current -= 1
        // Prefer infra edges (the traffic pipeline); occasionally repo edges.
        let edgeIdx: number
        if (infra.length > 0 && Math.random() < 0.72) {
          edgeIdx = infra[Math.floor(Math.random() * infra.length)]
        } else {
          edgeIdx = Math.floor(Math.random() * allEdges.length)
        }
        if (edgeIdx === undefined || !allEdges[edgeIdx]) continue
        particles.push({
          edge: edgeIdx,
          t: 0,
          speed: (surge ? 0.014 : 0.009) + Math.random() * 0.006,
          error: Math.random() < errFrac,
          infra: allEdges[edgeIdx].infra,
        })
      }
    }

    const drawParticles = (scene: Scene) => {
      const particles = particlesRef.current
      ctx.globalCompositeOperation = 'lighter'
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i]
        const e = scene.edges[p.edge]
        if (!e) {
          particles.splice(i, 1)
          continue
        }
        p.t += p.speed
        if (p.t >= 1) {
          particles.splice(i, 1)
          continue
        }
        const a = scene.nodes[e.a]
        const b = scene.nodes[e.b]
        const te = easeInOut(p.t)
        const x = lerp(a.x, b.x, te)
        const y = lerp(a.y, b.y, te)
        const color = p.error ? COLORS.red : p.infra ? COLORS.cyan : COLORS.violet
        const r = p.error ? 2.6 : 2
        const grad = ctx.createRadialGradient(x, y, 0, x, y, r * 4)
        grad.addColorStop(0, color)
        grad.addColorStop(1, 'rgba(0,0,0,0)')
        ctx.fillStyle = grad
        ctx.globalAlpha = 0.9
        ctx.beginPath()
        ctx.arc(x, y, r * 4, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalAlpha = 1
      ctx.globalCompositeOperation = 'source-over'
    }

    // ---- Edges -------------------------------------------------------------
    const drawEdges = (scene: Scene) => {
      for (const e of scene.edges) {
        const a = scene.nodes[e.a]
        const b = scene.nodes[e.b]
        ctx.strokeStyle = e.infra ? COLORS.edgeInfra : COLORS.edge
        ctx.lineWidth = e.infra ? 1.4 : 0.8
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.stroke()
      }
    }

    // ---- Nodes -------------------------------------------------------------
    const drawNodes = (scene: Scene, time: number) => {
      for (const n of scene.nodes) {
        if (n.kind === 'file') {
          const col =
            n.status === 'config' || n.status === 'infra'
              ? COLORS.amber
              : n.status === 'test'
                ? COLORS.teal
                : COLORS.violet
          ctx.globalCompositeOperation = 'lighter'
          const g = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, n.r * 3)
          g.addColorStop(0, col)
          g.addColorStop(1, 'rgba(0,0,0,0)')
          ctx.globalAlpha = 0.35
          ctx.fillStyle = g
          ctx.beginPath()
          ctx.arc(n.x, n.y, n.r * 3, 0, Math.PI * 2)
          ctx.fill()
          ctx.globalCompositeOperation = 'source-over'
          ctx.globalAlpha = 1
          ctx.fillStyle = col
          ctx.beginPath()
          ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2)
          ctx.fill()
          continue
        }

        // Hub / Ari — larger glowing labelled node.
        const isAri = n.kind === 'ari'
        const base = isAri
          ? COLORS.cyan
          : n.status === 'down'
            ? COLORS.red
            : n.status === 'degraded'
              ? COLORS.amber
              : HUB_COLOR[n.hubType ?? ''] ?? COLORS.teal
        const pulse = isAri ? 0.5 + 0.5 * Math.sin(time / 600) : 0.35

        ctx.globalCompositeOperation = 'lighter'
        const g = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, n.r * 4)
        g.addColorStop(0, base)
        g.addColorStop(1, 'rgba(0,0,0,0)')
        ctx.globalAlpha = 0.25 + pulse * 0.3
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.arc(n.x, n.y, n.r * 4, 0, Math.PI * 2)
        ctx.fill()
        ctx.globalCompositeOperation = 'source-over'
        ctx.globalAlpha = 1

        ctx.fillStyle = COLORS.bg
        ctx.beginPath()
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2)
        ctx.fill()
        ctx.lineWidth = isAri ? 2.4 : 2
        ctx.strokeStyle = base
        ctx.stroke()
        ctx.fillStyle = base
        ctx.globalAlpha = 0.9
        ctx.beginPath()
        ctx.arc(n.x, n.y, n.r * 0.42, 0, Math.PI * 2)
        ctx.fill()
        ctx.globalAlpha = 1

        // Label.
        ctx.fillStyle = COLORS.text
        ctx.font = isAri
          ? '600 15px ui-sans-serif, system-ui, sans-serif'
          : '600 13px ui-sans-serif, system-ui, sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        ctx.fillText(n.label, n.x, n.y + n.r + 6)
      }
    }

    // ---- Agents ------------------------------------------------------------
    const syncAgents = (scene: Scene) => {
      const list = dataRef.current.agents
      const map = agentsRef.current
      const ari = scene.nodes[scene.index.get('__ari__') ?? 0]
      for (const a of map.values()) a.seen = false
      for (const a of list) {
        let ar = map.get(a.id)
        if (!ar) {
          ar = {
            x: ari?.x ?? scene.W / 2,
            y: ari?.y ?? 60,
            type: a.type,
            label: a.label,
            status: a.status,
            progress: a.progress,
            targetId: a.targetNodeId,
            alpha: 0,
            phase: Math.random() * Math.PI * 2,
            seen: true,
          }
          map.set(a.id, ar)
        }
        ar.status = a.status
        ar.progress = a.progress
        ar.targetId = a.targetNodeId
        ar.type = a.type
        ar.label = a.label
        ar.seen = true
      }
      // Agents no longer reported fade and are removed.
      for (const [id, ar] of map) {
        if (!ar.seen) {
          ar.status = 'recalled'
          ar.alpha -= 0.04
          if (ar.alpha <= 0) map.delete(id)
        }
      }
    }

    const processEvents = (scene: Scene) => {
      const evs = dataRef.current.events
      const seen = processedRef.current
      const map = agentsRef.current
      for (const e of evs) {
        const key = `${e.ts}:${e.agentId}:${e.kind}`
        if (seen.has(key)) continue
        seen.add(key)
        if (e.kind !== 'finding') continue
        const ar = map.get(e.agentId)
        const col =
          e.severity === 'critical' || e.severity === 'high'
            ? COLORS.red
            : COLORS.amber
        const tx = ar?.x ?? scene.W / 2
        const ty = ar?.y ?? scene.H / 2
        burstsRef.current.push({ x: tx, y: ty, age: 0, life: 40, color: col })
      }
      if (seen.size > 400) processedRef.current = new Set()
    }

    const drawAgents = (scene: Scene, time: number) => {
      const map = agentsRef.current
      const ari = scene.nodes[scene.index.get('__ari__') ?? 0]
      for (const ar of map.values()) {
        const targetIdx = scene.index.get(ar.targetId)
        let tx = ari?.x ?? scene.W / 2
        let ty = ari?.y ?? 60
        if (ar.status === 'recalled') {
          tx = ari?.x ?? scene.W / 2
          ty = ari?.y ?? 60
        } else if (targetIdx !== undefined) {
          tx = scene.nodes[targetIdx].x
          ty = scene.nodes[targetIdx].y
        }
        const ease = ar.status === 'moving' || ar.status === 'spawning' ? 0.05 : 0.12
        ar.x = lerp(ar.x, tx, ease)
        ar.y = lerp(ar.y, ty, ease)
        if (ar.status !== 'recalled') ar.alpha = Math.min(1, ar.alpha + 0.05)

        const col = AGENT_COLOR[ar.type] ?? COLORS.cyan

        // Faint dispatch tether from Ari.
        if (ari && ar.status !== 'recalled') {
          ctx.strokeStyle = col
          ctx.globalAlpha = 0.08 * ar.alpha
          ctx.lineWidth = 1
          ctx.beginPath()
          ctx.moveTo(ari.x, ari.y)
          ctx.lineTo(ar.x, ar.y)
          ctx.stroke()
          ctx.globalAlpha = 1
        }

        // Glow mote.
        ctx.globalCompositeOperation = 'lighter'
        const g = ctx.createRadialGradient(ar.x, ar.y, 0, ar.x, ar.y, 16)
        g.addColorStop(0, col)
        g.addColorStop(1, 'rgba(0,0,0,0)')
        ctx.globalAlpha = 0.75 * ar.alpha
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.arc(ar.x, ar.y, 16, 0, Math.PI * 2)
        ctx.fill()
        ctx.globalCompositeOperation = 'source-over'
        ctx.globalAlpha = ar.alpha
        ctx.fillStyle = col
        ctx.beginPath()
        ctx.arc(ar.x, ar.y, 3.2, 0, Math.PI * 2)
        ctx.fill()

        // Working ring that fills with progress (pulsing).
        if (ar.status === 'working') {
          const rr = 11 + (reduced ? 0 : Math.sin(time / 300 + ar.phase) * 1.5)
          ctx.strokeStyle = 'rgba(255,255,255,0.12)'
          ctx.lineWidth = 2
          ctx.beginPath()
          ctx.arc(ar.x, ar.y, rr, 0, Math.PI * 2)
          ctx.stroke()
          ctx.strokeStyle = col
          ctx.lineWidth = 2.4
          ctx.beginPath()
          ctx.arc(ar.x, ar.y, rr, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ar.progress)
          ctx.stroke()
        }
        ctx.globalAlpha = 1
      }
    }

    const drawBursts = () => {
      const bursts = burstsRef.current
      ctx.globalCompositeOperation = 'lighter'
      for (let i = bursts.length - 1; i >= 0; i--) {
        const bu = bursts[i]
        bu.age += 1
        const t = bu.age / bu.life
        if (t >= 1) {
          bursts.splice(i, 1)
          continue
        }
        const r = 6 + t * 34
        ctx.globalAlpha = (1 - t) * 0.8
        ctx.strokeStyle = bu.color
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.arc(bu.x, bu.y, r, 0, Math.PI * 2)
        ctx.stroke()
      }
      ctx.globalAlpha = 1
      ctx.globalCompositeOperation = 'source-over'
    }

    // ---- Background (vignette + subtle grid) -------------------------------
    const drawBackground = (W: number, H: number) => {
      ctx.fillStyle = COLORS.bg
      ctx.fillRect(0, 0, W, H)
      ctx.strokeStyle = 'rgba(80, 120, 170, 0.05)'
      ctx.lineWidth = 1
      const step = 56
      for (let x = 0; x < W; x += step) {
        ctx.beginPath()
        ctx.moveTo(x, 0)
        ctx.lineTo(x, H)
        ctx.stroke()
      }
      for (let y = 0; y < H; y += step) {
        ctx.beginPath()
        ctx.moveTo(0, y)
        ctx.lineTo(W, y)
        ctx.stroke()
      }
      const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.75)
      vg.addColorStop(0, 'rgba(0,0,0,0)')
      vg.addColorStop(1, 'rgba(0,0,0,0.65)')
      ctx.fillStyle = vg
      ctx.fillRect(0, 0, W, H)
    }

    // ---- Main loop ---------------------------------------------------------
    const frame = (time: number) => {
      const scene = sceneRef.current
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const W = scene?.W ?? window.innerWidth
      const H = scene?.H ?? window.innerHeight
      drawBackground(W, H)

      if (scene && scene.nodes.length > 0) {
        physics(scene)
        drawEdges(scene)
        spawnParticles(scene, dataRef.current.metrics)
        drawParticles(scene)
        drawNodes(scene, time)
        syncAgents(scene)
        processEvents(scene)
        drawAgents(scene, time)
        drawBursts()
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced])

  return <canvas ref={canvasRef} className="graph-canvas" />
}
