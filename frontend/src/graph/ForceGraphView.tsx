import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ForceGraph2D from 'react-force-graph-2d'
import ForceGraph3D from 'react-force-graph-3d'
import * as THREE from 'three'
import type { Agent, AgentEvent, Metrics, RepoGraph, Topology } from './types'

// ---------------------------------------------------------------------------
// Instrument palette. Near-black ink, one restrained phosphor accent, red
// reserved for trouble, amber for lesser trouble. No gradients-as-decoration.
// ---------------------------------------------------------------------------
const C = {
  bg: '#060607',
  acc: '#59c9a5', // phosphor green — "system nominal"
  accDim: '#2f7d66',
  file: '#808b86',
  fileDim: '#4a524e',
  link: 'rgba(120,150,140,0.12)',
  linkInfra: 'rgba(89,201,165,0.30)',
  red: '#ff5550',
  amber: '#e0a63a',
  text: '#c6ccc8',
  textDim: '#767d78',
}

const AGENT_COLOR: Record<string, string> = {
  scanner: '#7fd6e0',
  'log-watcher': '#b6c7a0',
  verifier: '#a9e0b0',
  remediator: '#59c9a5',
  patcher: '#59c9a5',
  auditor: '#9fd6c4',
  sentinel: '#c9cf9a',
  tracer: '#86d0c0',
}

const TRAFFIC_TYPES = new Set(['traffic', 'edge', 'internet', 'waf', 'firewall'])
const FINDING_TTL_MS = 20000

type TroubleLevel = 'red' | 'amber'
interface Trouble {
  level: TroubleLevel
  badge: boolean
}

// A node in the shared, stable graphData object.
interface GNode {
  id: string
  kind: 'hub' | 'file' | 'ari'
  label: string
  dir: string
  loc: number
  hubType: string | null
  status: string | null
  // runtime-mutated (read by accessors / per-frame updaters)
  __trouble?: Trouble | null
  __ta?: number // trouble blend 0..1
  __body?: THREE.Mesh
  __glow?: THREE.Sprite
  __badge?: THREE.Sprite
  __troubleCol?: THREE.Color
  x?: number
  y?: number
  z?: number
}

interface GLink {
  source: string
  target: string
  infra: boolean
  __seed: number
}

interface GraphData {
  nodes: GNode[]
  links: GLink[]
}

interface OpenFinding {
  nodeId?: string
  file?: string
  severity: string
  ts: number
}

interface AgentRender {
  id: string
  type: string
  status: string
  progress: number
  targetId: string
  x: number
  y: number
  z: number
  alpha: number
  phase: number
  seen: boolean
  // 3d
  glow?: THREE.Sprite
  ring?: THREE.Sprite
}

interface Burst {
  x: number
  y: number
  z: number
  age: number
  life: number
  color: string
  spr?: THREE.Sprite
}

interface Props {
  mode: '2d' | '3d'
  repoGraph: RepoGraph | null
  topology: Topology | null
  metrics: Metrics | null
  agents: Agent[]
  events: AgentEvent[]
  width: number
  height: number
  reduced: boolean
}

function sevLevel(sev: string | undefined): TroubleLevel {
  return sev === 'critical' || sev === 'high' ? 'red' : 'amber'
}

function nodeSize(n: GNode): number {
  if (n.kind === 'ari') return 8
  if (n.kind === 'hub') return 6
  return Math.max(2, Math.min(5, 2 + Math.sqrt(n.loc) / 8))
}

function baseColor(n: GNode): string {
  if (n.kind === 'ari') return '#daffee'
  if (n.kind === 'hub') return C.acc
  return n.loc > 200 ? C.file : C.fileDim
}

function pathMatch(file: string, id: string): boolean {
  const f = file.toLowerCase()
  const n = id.toLowerCase()
  if (f === n || f.endsWith(n) || n.endsWith(f)) return true
  const bf = f.split('/').pop() ?? f
  const bn = n.split('/').pop() ?? n
  if (bf && bn && bf === bn) return true
  return (f.length > 4 && n.includes(f)) || (n.length > 4 && f.includes(n))
}

// ---- Shared canvas textures for the 3D scene ------------------------------
function radialTexture(stops: [number, string][]): THREE.CanvasTexture {
  const cv = document.createElement('canvas')
  cv.width = cv.height = 128
  const ctx = cv.getContext('2d')!
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64)
  for (const [o, col] of stops) g.addColorStop(o, col)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 128, 128)
  const t = new THREE.CanvasTexture(cv)
  t.needsUpdate = true
  return t
}

function ringTexture(): THREE.CanvasTexture {
  const cv = document.createElement('canvas')
  cv.width = cv.height = 128
  const ctx = cv.getContext('2d')!
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = 9
  ctx.beginPath()
  ctx.arc(64, 64, 50, 0, Math.PI * 2)
  ctx.stroke()
  const t = new THREE.CanvasTexture(cv)
  t.needsUpdate = true
  return t
}

function badgeTexture(): THREE.CanvasTexture {
  const cv = document.createElement('canvas')
  cv.width = cv.height = 128
  const ctx = cv.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.beginPath()
  ctx.arc(64, 64, 52, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#060607'
  ctx.font = '700 86px "JetBrains Mono", monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('!', 64, 70)
  const t = new THREE.CanvasTexture(cv)
  t.needsUpdate = true
  return t
}

function labelTexture(text: string): { tex: THREE.CanvasTexture; aspect: number } {
  const cv = document.createElement('canvas')
  const ctx = cv.getContext('2d')!
  const font = '500 48px "JetBrains Mono", monospace'
  ctx.font = font
  const w = Math.ceil(ctx.measureText(text).width) + 24
  const h = 64
  cv.width = w
  cv.height = h
  ctx.font = font
  ctx.fillStyle = C.text
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, w / 2, h / 2 + 2)
  const tex = new THREE.CanvasTexture(cv)
  tex.needsUpdate = true
  return { tex, aspect: w / h }
}

export default function ForceGraphView({
  mode,
  repoGraph,
  topology,
  metrics,
  agents,
  events,
  width,
  height,
  reduced,
}: Props) {
  const fgRef = useRef<any>(null)
  const [graphData, setGraphData] = useState<GraphData>({ nodes: [], links: [] })
  const nodeByIdRef = useRef<Map<string, GNode>>(new Map())
  const sigRef = useRef('')

  const dataRef = useRef<Props>({
    mode,
    repoGraph,
    topology,
    metrics,
    agents,
    events,
    width,
    height,
    reduced,
  })
  dataRef.current = { mode, repoGraph, topology, metrics, agents, events, width, height, reduced }

  const openFindingsRef = useRef<Map<string, OpenFinding>>(new Map())
  const processedRef = useRef<Set<string>>(new Set())
  const agentRenderRef = useRef<Map<string, AgentRender>>(new Map())
  const burstsRef = useRef<Burst[]>([])
  const errFracRef = useRef(0)
  const draggingRef = useRef(false)

  // 3D scene layer bookkeeping.
  const sceneRef = useRef<THREE.Scene | null>(null)
  const agentGroupRef = useRef<THREE.Group | null>(null)
  const texRef = useRef<{
    glow: THREE.CanvasTexture
    ring: THREE.CanvasTexture
    badge: THREE.CanvasTexture
  } | null>(null)
  const forcesSetRef = useRef(false)

  // ---- Build / update the stable graphData structure --------------------
  useEffect(() => {
    const repo = repoGraph
    const topo = topology
    const ids: string[] = ['__ari__']
    if (topo) for (const n of topo.nodes) ids.push(n.id)
    if (repo) for (const n of repo.nodes) ids.push(n.id)
    const sig = ids.slice().sort().join('|')

    const byId = nodeByIdRef.current

    // Always refresh mutable attributes (status / loc) in place.
    if (topo) for (const n of topo.nodes) { const g = byId.get(n.id); if (g) { g.status = n.status } }
    if (repo) for (const n of repo.nodes) { const g = byId.get(n.id); if (g) { g.loc = n.loc } }

    if (sig === sigRef.current && byId.size > 0) return
    sigRef.current = sig

    const nextById = new Map<string, GNode>()
    const nodes: GNode[] = []
    const ensure = (spec: Omit<GNode, '__trouble' | '__ta'>): GNode => {
      const existing = byId.get(spec.id)
      const node = existing ?? ({ ...spec } as GNode)
      // keep live position + three refs, refresh descriptive fields
      node.kind = spec.kind
      node.label = spec.label
      node.dir = spec.dir
      node.loc = spec.loc
      node.hubType = spec.hubType
      node.status = spec.status
      nextById.set(node.id, node)
      nodes.push(node)
      return node
    }

    ensure({ id: '__ari__', kind: 'ari', label: 'ari', dir: '', loc: 0, hubType: null, status: null })
    if (topo) for (const n of topo.nodes) {
      ensure({ id: n.id, kind: 'hub', label: n.label, dir: '', loc: 0, hubType: n.type, status: n.status })
    }
    if (repo) for (const n of repo.nodes) {
      ensure({ id: n.id, kind: 'file', label: n.label, dir: n.dir, loc: n.loc, hubType: null, status: n.kind })
    }

    const links: GLink[] = []
    const has = (id: string) => nextById.has(id)
    // Ari tethered to every hub so it sits at the heart of the system.
    if (topo) for (const n of topo.nodes) links.push({ source: '__ari__', target: n.id, infra: false, __seed: Math.random() })
    if (topo) for (const e of topo.edges) if (has(e.from) && has(e.to)) links.push({ source: e.from, target: e.to, infra: true, __seed: Math.random() })
    if (repo) for (const e of repo.edges) if (has(e.from) && has(e.to)) links.push({ source: e.from, target: e.to, infra: false, __seed: Math.random() })
    // Anchor each repo file to a hub so dir-clusters orbit a service body.
    if (repo && topo && topo.nodes.length > 0) {
      const hubKeys = topo.nodes.map((h) => ({ id: h.id, key: `${h.type} ${h.id} ${h.label}`.toLowerCase() }))
      let rr = 0
      const seenDir = new Map<string, string>()
      for (const f of repo.nodes) {
        let hubId = seenDir.get(f.dir)
        if (!hubId) {
          const dl = f.dir.toLowerCase()
          const match = hubKeys.find((h) => dl.split(/[\\/\-_.]/).some((tok) => tok.length > 2 && h.key.includes(tok)))
          hubId = match ? match.id : hubKeys[rr++ % hubKeys.length].id
          seenDir.set(f.dir, hubId)
        }
        links.push({ source: hubId, target: f.id, infra: false, __seed: Math.random() })
      }
    }

    nodeByIdRef.current = nextById
    setGraphData({ nodes, links })
  }, [repoGraph, topology])

  // Keep topology status live without reheating the layout.
  useEffect(() => {
    if (!topology) return
    for (const n of topology.nodes) {
      const g = nodeByIdRef.current.get(n.id)
      if (g) g.status = n.status
    }
  }, [topology])

  // ---- Per-frame driver (trouble, agents, bursts, 3D scene, camera) ------
  useEffect(() => {
    let raf = 0
    let last = performance.now()

    const ingestEvents = (now: number) => {
      const of = openFindingsRef.current
      const seen = processedRef.current
      for (const e of dataRef.current.events) {
        if (e.kind !== 'finding') continue
        const key = `${e.ts}:${e.agentId}`
        if (seen.has(key)) continue
        seen.add(key)
        const nodeId = e.nodeId ?? e.targetNodeId
        const file = e.finding?.file
        const severity = (e.severity ?? e.finding?.severity ?? 'medium') as string
        of.set(key, { nodeId, file, severity, ts: Date.now() })
        // Burst at the resolved node.
        const target = nodeId ? nodeByIdRef.current.get(nodeId) : undefined
        burstsRef.current.push({
          x: target?.x ?? 0,
          y: target?.y ?? 0,
          z: target?.z ?? 0,
          age: 0,
          life: 42,
          color: sevLevel(severity) === 'red' ? C.red : C.amber,
        })
      }
      // prune TTL
      for (const [k, v] of of) if (now - v.ts > FINDING_TTL_MS) of.delete(k)
      if (seen.size > 600) processedRef.current = new Set()
    }

    const computeTrouble = () => {
      const topo = dataRef.current.topology
      const surge = dataRef.current.metrics?.mode === 'surge'
      const of = openFindingsRef.current
      const statusById = new Map<string, string>()
      if (topo) for (const n of topo.nodes) statusById.set(n.id, n.status)

      for (const node of nodeByIdRef.current.values()) {
        let level: TroubleLevel | null = null
        let badge = false
        const bump = (lv: TroubleLevel, b: boolean) => {
          if (lv === 'red' || level === null) { level = lv; }
          badge = badge || b
        }
        if (node.kind === 'file') {
          for (const f of of.values()) {
            const m = (f.nodeId && f.nodeId === node.id) || (f.file && pathMatch(f.file, node.id))
            if (m) bump(sevLevel(f.severity), true)
          }
        } else {
          const st = statusById.get(node.id)
          if (st === 'down') bump('red', true)
          else if (st === 'degraded') bump('amber', true)
          for (const f of of.values()) {
            if (f.nodeId === node.id) bump(sevLevel(f.severity), true)
          }
          if (surge && node.hubType && TRAFFIC_TYPES.has(node.hubType)) bump('red', false)
        }
        node.__trouble = level ? { level, badge } : null
      }
    }

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const d = dataRef.current
      const reducedM = d.reduced

      ingestEvents(now)
      computeTrouble()

      // error fraction for particle tinting (read live by color accessor)
      const er = d.metrics?.errorRate ?? 0
      errFracRef.current = Math.min(0.6, er / 8)

      // ---- Agents: lerp toward target node (or ari when recalled) --------
      const map = agentRenderRef.current
      const ari = nodeByIdRef.current.get('__ari__')
      for (const a of map.values()) a.seen = false
      for (const a of d.agents) {
        let ar = map.get(a.id)
        if (!ar) {
          ar = {
            id: a.id, type: a.type, status: a.status, progress: a.progress,
            targetId: a.targetNodeId, x: ari?.x ?? 0, y: ari?.y ?? 0, z: ari?.z ?? 0,
            alpha: 0, phase: Math.random() * Math.PI * 2, seen: true,
          }
          map.set(a.id, ar)
        }
        ar.type = a.type; ar.status = a.status; ar.progress = a.progress
        ar.targetId = a.targetNodeId; ar.seen = true
      }
      for (const [id, ar] of map) {
        const recalled = !ar.seen || ar.status === 'recalled'
        const tgt = recalled ? ari : nodeByIdRef.current.get(ar.targetId) ?? ari
        const ease = ar.status === 'moving' || ar.status === 'spawning' ? 0.05 : 0.12
        ar.x += ((tgt?.x ?? 0) - ar.x) * ease
        ar.y += ((tgt?.y ?? 0) - ar.y) * ease
        ar.z += ((tgt?.z ?? 0) - ar.z) * ease
        ar.alpha += ((recalled ? 0 : 1) - ar.alpha) * 0.06
        if (recalled && ar.alpha < 0.03) {
          if (ar.glow) ar.glow.parent?.remove(ar.glow)
          if (ar.ring) ar.ring.parent?.remove(ar.ring)
          map.delete(id)
        }
      }

      // bursts
      for (let i = burstsRef.current.length - 1; i >= 0; i--) {
        const b = burstsRef.current[i]
        b.age += 1
        if (b.age >= b.life) {
          if (b.spr) b.spr.parent?.remove(b.spr)
          burstsRef.current.splice(i, 1)
        }
      }

      // ---- 3D scene upkeep ----------------------------------------------
      if (d.mode === '3d' && fgRef.current) {
        const scene: THREE.Scene = fgRef.current.scene()
        sceneRef.current = scene
        if (!texRef.current) {
          texRef.current = {
            glow: radialTexture([[0, 'rgba(255,255,255,1)'], [0.4, 'rgba(255,255,255,0.35)'], [1, 'rgba(255,255,255,0)']]),
            ring: ringTexture(),
            badge: badgeTexture(),
          }
        }
        if (!agentGroupRef.current || agentGroupRef.current.parent !== scene) {
          const g = new THREE.Group()
          scene.add(g)
          agentGroupRef.current = g
          for (const ar of map.values()) { ar.glow = undefined; ar.ring = undefined }
        }
        const grp = agentGroupRef.current
        const tex = texRef.current
        const pulse = reducedM ? 1 : 0.6 + 0.4 * Math.sin(now / 320)

        // node bodies: blend to trouble color + badge
        for (const node of nodeByIdRef.current.values()) {
          if (!node.__body) continue
          const ta0 = node.__ta ?? 0
          const ta = ta0 + ((node.__trouble ? 1 : 0) - ta0) * 0.08
          node.__ta = ta
          if (node.__trouble) node.__troubleCol = new THREE.Color(node.__trouble.level === 'red' ? C.red : C.amber)
          const bc = new THREE.Color(baseColor(node))
          const col = node.__troubleCol ? bc.clone().lerp(node.__troubleCol, ta) : bc
          ;(node.__body.material as THREE.MeshBasicMaterial).color.copy(col)
          if (node.__glow) {
            const gm = node.__glow.material as THREE.SpriteMaterial
            gm.color.copy(col)
            const baseOpacity = node.kind === 'file' ? 0 : 0.45
            gm.opacity = Math.max(baseOpacity, ta * (reducedM ? 0.8 : pulse))
          }
          if (node.__badge) {
            const show = !!node.__trouble?.badge
            const bm = node.__badge.material as THREE.SpriteMaterial
            node.__badge.visible = show && ta > 0.05
            bm.color.set(node.__trouble?.level === 'amber' ? C.amber : C.red)
            bm.opacity = ta * (reducedM ? 1 : pulse)
            const s = nodeSize(node) * 1.5
            node.__badge.scale.set(s, s, 1)
            node.__badge.position.set(nodeSize(node) * 0.9, nodeSize(node) * 1.3, 0)
          }
        }

        // agents
        for (const ar of map.values()) {
          if (!ar.glow) {
            const gm = new THREE.SpriteMaterial({ map: tex.glow, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
            ar.glow = new THREE.Sprite(gm)
            grp.add(ar.glow)
            const rm = new THREE.SpriteMaterial({ map: tex.ring, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
            ar.ring = new THREE.Sprite(rm)
            ar.ring.visible = false
            grp.add(ar.ring)
          }
          const col = AGENT_COLOR[ar.type] ?? C.acc
          ar.glow.position.set(ar.x, ar.y, ar.z)
          const gm = ar.glow.material as THREE.SpriteMaterial
          gm.color.set(col)
          gm.opacity = ar.alpha
          const gs = 7 + (reducedM ? 0 : Math.sin(now / 260 + ar.phase) * 1.2)
          ar.glow.scale.set(gs, gs, 1)
          if (ar.ring) {
            const working = ar.status === 'working'
            ar.ring.visible = working && ar.alpha > 0.1
            ar.ring.position.set(ar.x, ar.y, ar.z)
            const rm = ar.ring.material as THREE.SpriteMaterial
            rm.color.set(col)
            rm.opacity = (0.25 + ar.progress * 0.7) * ar.alpha
            const rs = 12 + (reducedM ? 0 : Math.sin(now / 200 + ar.phase) * 1.5)
            ar.ring.scale.set(rs, rs, 1)
          }
        }

        // bursts as additive sprites
        for (const b of burstsRef.current) {
          if (!b.spr) {
            const bm = new THREE.SpriteMaterial({ map: tex.ring, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: new THREE.Color(b.color) })
            b.spr = new THREE.Sprite(bm)
            b.spr.position.set(b.x, b.y, b.z)
            grp.add(b.spr)
          }
          const t = b.age / b.life
          const s = 6 + t * 40
          b.spr.scale.set(s, s, 1)
          ;(b.spr.material as THREE.SpriteMaterial).opacity = (1 - t) * 0.9
        }

        // slow auto-orbit (preserve user zoom; pause under reduced-motion)
        if (!reducedM && !draggingRef.current) {
          const cur = fgRef.current.cameraPosition()
          if (cur) {
            const radius = Math.hypot(cur.x, cur.z) || 320
            const ang = Math.atan2(cur.x, cur.z) + 0.12 * dt
            fgRef.current.cameraPosition(
              { x: Math.sin(ang) * radius, y: cur.y, z: Math.cos(ang) * radius },
              { x: 0, y: 0, z: 0 },
              0,
            )
          }
        }
      }

      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])

  // Pause auto-orbit while the user is dragging the camera.
  useEffect(() => {
    const down = () => { draggingRef.current = true }
    const up = () => { draggingRef.current = false }
    window.addEventListener('pointerdown', down)
    window.addEventListener('pointerup', up)
    return () => {
      window.removeEventListener('pointerdown', down)
      window.removeEventListener('pointerup', up)
    }
  }, [])

  // One-time force tuning + initial camera per mount.
  useEffect(() => {
    forcesSetRef.current = false
  }, [mode])
  const onEngineTick = useCallback(() => {
    const fg = fgRef.current
    if (!fg || forcesSetRef.current) return
    forcesSetRef.current = true
    try {
      fg.d3Force('charge')?.strength(dataRef.current.mode === '3d' ? -160 : -220)
      const lf = fg.d3Force('link')
      if (lf) lf.distance((l: GLink) => (l.infra ? 70 : l.source === '__ari__' || (l as any).source?.id === '__ari__' ? 90 : 26))
    } catch {
      /* ignore */
    }
    if (dataRef.current.mode === '3d') {
      try { fg.cameraPosition({ x: 0, y: 120, z: 340 }, { x: 0, y: 0, z: 0 }, 0) } catch { /* ignore */ }
    }
  }, [])

  // ---- 3D custom node objects (stable accessor) --------------------------
  const nodeThreeObject = useCallback((node: GNode) => {
    if (!texRef.current) {
      texRef.current = {
        glow: radialTexture([[0, 'rgba(255,255,255,1)'], [0.4, 'rgba(255,255,255,0.35)'], [1, 'rgba(255,255,255,0)']]),
        ring: ringTexture(),
        badge: badgeTexture(),
      }
    }
    const tex = texRef.current
    const r = nodeSize(node)
    const group = new THREE.Group()

    const body = new THREE.Mesh(
      new THREE.SphereGeometry(r, 20, 20),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(baseColor(node)) }),
    )
    group.add(body)
    node.__body = body

    const glow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: tex.glow, color: new THREE.Color(baseColor(node)), transparent: true,
        depthWrite: false, blending: THREE.AdditiveBlending,
        opacity: node.kind === 'file' ? 0 : 0.45,
      }),
    )
    const gs = r * 4.5
    glow.scale.set(gs, gs, 1)
    group.add(glow)
    node.__glow = glow

    const badge = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: tex.badge, color: new THREE.Color(C.red), transparent: true, depthWrite: false }),
    )
    badge.visible = false
    group.add(badge)
    node.__badge = badge

    if (node.kind !== 'file') {
      const { tex: lt, aspect } = labelTexture(node.label)
      const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: lt, transparent: true, depthWrite: false }))
      const lh = 5
      label.scale.set(lh * aspect, lh, 1)
      label.position.set(0, -(r + 5), 0)
      group.add(label)
    }
    return group
  }, [])

  // ---- 2D custom node drawing (stable accessor) --------------------------
  const nodeCanvasObject = useCallback((node: GNode, ctx: CanvasRenderingContext2D, scale: number) => {
    const x = node.x ?? 0
    const y = node.y ?? 0
    const r = nodeSize(node)
    const reducedM = dataRef.current.reduced
    const now = performance.now()
    const pulse = reducedM ? 1 : 0.55 + 0.45 * Math.sin(now / 320)

    const ta0 = node.__ta ?? 0
    const ta = ta0 + ((node.__trouble ? 1 : 0) - ta0) * 0.1
    node.__ta = ta
    const base = baseColor(node)
    const troubleCol = node.__trouble ? (node.__trouble.level === 'red' ? C.red : C.amber) : null
    const fill = ta > 0.02 && (troubleCol || node.__trouble) ? (troubleCol ?? base) : base

    // hubs: subtle glow halo (carries "active body" info)
    if (node.kind !== 'file') {
      const halo = ctx.createRadialGradient(x, y, 0, x, y, r * 3)
      const hc = troubleCol && ta > 0.3 ? troubleCol : C.acc
      halo.addColorStop(0, hc)
      halo.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.globalAlpha = (node.kind === 'ari' ? 0.35 : 0.22) * (0.8 + 0.2 * pulse) + ta * 0.4
      ctx.fillStyle = halo
      ctx.beginPath()
      ctx.arc(x, y, r * 3, 0, Math.PI * 2)
      ctx.fill()
      ctx.globalAlpha = 1
    }

    ctx.fillStyle = fill
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
    if (node.kind !== 'file') {
      ctx.lineWidth = 1 / scale
      ctx.strokeStyle = troubleCol && ta > 0.3 ? troubleCol : C.acc
      ctx.stroke()
    }

    // trouble ring + "!" marker
    if (node.__trouble && ta > 0.05) {
      ctx.globalAlpha = ta * (reducedM ? 1 : pulse)
      ctx.strokeStyle = troubleCol ?? C.red
      ctx.lineWidth = 1.5 / scale
      ctx.beginPath()
      ctx.arc(x, y, r + 3 / scale, 0, Math.PI * 2)
      ctx.stroke()
      if (node.__trouble.badge) {
        const bx = x + r + 4 / scale
        const by = y - r - 4 / scale
        const bs = 4 / scale
        ctx.fillStyle = troubleCol ?? C.red
        ctx.beginPath()
        ctx.arc(bx, by, bs, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = C.bg
        ctx.font = `700 ${6 / scale}px "JetBrains Mono", monospace`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText('!', bx, by + 0.5 / scale)
      }
      ctx.globalAlpha = 1
    }

    // labels: hubs always, files only when zoomed in
    if (node.kind !== 'file' || scale > 2.4) {
      const fontPx = (node.kind === 'file' ? 3.5 : 4.5) / scale
      ctx.font = `${node.kind === 'file' ? 400 : 500} ${fontPx}px "JetBrains Mono", monospace`
      ctx.fillStyle = node.kind === 'file' ? C.textDim : C.text
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      ctx.fillText(node.label, x, y + r + 2 / scale)
    }
  }, [])

  // ---- 2D overlay: agents, tethers, bursts (stable accessor) -------------
  const onRenderFramePost = useCallback((ctx: CanvasRenderingContext2D, scale: number) => {
    const ari = nodeByIdRef.current.get('__ari__')
    const reducedM = dataRef.current.reduced
    const now = performance.now()

    // bursts
    for (const b of burstsRef.current) {
      const t = b.age / b.life
      ctx.globalAlpha = (1 - t) * 0.8
      ctx.strokeStyle = b.color
      ctx.lineWidth = 1.5 / scale
      ctx.beginPath()
      ctx.arc(b.x, b.y, (6 + t * 34) / scale, 0, Math.PI * 2)
      ctx.stroke()
    }
    ctx.globalAlpha = 1

    for (const ar of agentRenderRef.current.values()) {
      const col = AGENT_COLOR[ar.type] ?? C.acc
      // tether from ari
      if (ari && ar.status !== 'recalled') {
        ctx.globalAlpha = 0.12 * ar.alpha
        ctx.strokeStyle = col
        ctx.lineWidth = 0.6 / scale
        ctx.beginPath()
        ctx.moveTo(ari.x ?? 0, ari.y ?? 0)
        ctx.lineTo(ar.x, ar.y)
        ctx.stroke()
      }
      // glow
      const gr = 6 / scale
      const g = ctx.createRadialGradient(ar.x, ar.y, 0, ar.x, ar.y, gr)
      g.addColorStop(0, col)
      g.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.globalAlpha = 0.8 * ar.alpha
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(ar.x, ar.y, gr, 0, Math.PI * 2)
      ctx.fill()
      ctx.globalAlpha = ar.alpha
      ctx.fillStyle = col
      ctx.beginPath()
      ctx.arc(ar.x, ar.y, 1.6 / scale, 0, Math.PI * 2)
      ctx.fill()
      // progress ring while working
      if (ar.status === 'working') {
        const pr = 4 / scale + (reducedM ? 0 : Math.sin(now / 240 + ar.phase) * 0.6 / scale)
        ctx.globalAlpha = ar.alpha
        ctx.strokeStyle = 'rgba(255,255,255,0.15)'
        ctx.lineWidth = 1 / scale
        ctx.beginPath(); ctx.arc(ar.x, ar.y, pr, 0, Math.PI * 2); ctx.stroke()
        ctx.strokeStyle = col
        ctx.lineWidth = 1.4 / scale
        ctx.beginPath(); ctx.arc(ar.x, ar.y, pr, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ar.progress); ctx.stroke()
      }
      ctx.globalAlpha = 1
    }
  }, [])

  // ---- Traffic particle tuning (re-read live) ----------------------------
  const rps = metrics?.rps ?? 400
  const surge = metrics?.mode === 'surge'
  const particleCount = useMemo(() => {
    const base = Math.max(1, Math.min(6, Math.round(rps / 240)))
    return reduced ? Math.min(2, base) : base + (surge ? 2 : 0)
  }, [rps, surge, reduced])

  const linkParticles = useCallback((l: GLink) => (l.infra ? particleCount : 0), [particleCount])
  const linkParticleColor = useCallback(
    (l: GLink) => (l.__seed < errFracRef.current ? C.red : C.acc),
    [],
  )
  const linkColor = useCallback((l: GLink) => (l.infra ? C.linkInfra : C.link), [])

  const common: Record<string, unknown> = {
    graphData,
    width,
    height,
    backgroundColor: C.bg,
    nodeLabel: (n: GNode) => `${n.label}${n.dir ? `  ·  ${n.dir}` : ''}${n.loc ? `  ·  ${n.loc} loc` : ''}`,
    linkColor,
    linkDirectionalParticles: linkParticles,
    linkDirectionalParticleColor: linkParticleColor,
    linkDirectionalParticleWidth: mode === '3d' ? 1.6 : 2,
    linkDirectionalParticleSpeed: surge ? 0.012 : 0.006,
    enableNodeDrag: false,
    warmupTicks: 50,
    cooldownTicks: 200,
    onEngineTick,
  }

  if (mode === '3d') {
    const p3d: any = {
      ...common,
      nodeThreeObject,
      nodeThreeObjectExtend: false,
      linkOpacity: 0.5,
      showNavInfo: false,
    }
    return <ForceGraph3D ref={fgRef} {...p3d} />
  }
  const p2d: any = {
    ...common,
    nodeCanvasObjectMode: () => 'replace',
    nodeCanvasObject,
    onRenderFramePost,
    autoPauseRedraw: false,
  }
  return <ForceGraph2D ref={fgRef} {...p2d} />
}
