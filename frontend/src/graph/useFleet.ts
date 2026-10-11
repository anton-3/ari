import { useCallback, useEffect, useRef, useState } from 'react'
import { API, WS_URL } from './config'
import { MockFleet } from './fleetMock'
import { INVENTORY } from './inventorySnapshot'
import { aliasNode, setPlacement } from './positions'
import type {
  Agent,
  Codemap,
  Fleet,
  FleetAlert,
  FleetLogLine,
  FleetNode,
  FleetRoleInfo,
} from './types'

/**
 * Fleet feed.
 *  - LIVE:     /api/fleet answers (WS "fleet" frames preferred, REST poll as backstop)
 *  - OFFLINE:  :8090 unreachable — no data is shown, we keep probing and switch to
 *              LIVE automatically the moment the API answers
 *  - SIM:      only with ?sim=1 — explicit offline-demo simulator
 */
export type FleetSource = 'connecting' | 'live' | 'offline' | 'sim'

export interface FleetApi {
  fleet: Fleet | null
  roles: FleetRoleInfo[]
  source: FleetSource
  log: FleetLogLine[]
  alerts: FleetAlert[]
  simAgents: Agent[]
  codemap: Codemap | null
  addNode: (role: string, pos?: { x: number; y: number }) => void
  deleteNode: (id: string, label: string) => Promise<boolean>
  rebootNode: (id: string) => Promise<boolean>
  retry: () => void
}

const POLL_MS = 2500
const MAX_LOG = 40
const MAX_ALERTS = 50

async function readError(res: Response): Promise<string> {
  try {
    const txt = await res.text()
    try {
      const j = JSON.parse(txt) as { error?: string; message?: string }
      return j.error ?? j.message ?? txt
    } catch {
      return txt || res.statusText
    }
  } catch {
    return res.statusText
  }
}

let tempSeq = 0

export function useFleet(sim: boolean, surge: boolean): FleetApi {
  const [fleet, setFleet] = useState<Fleet | null>(null)
  const [roles, setRoles] = useState<FleetRoleInfo[]>([])
  const [source, setSource] = useState<FleetSource>(sim ? 'sim' : 'connecting')
  const [log, setLog] = useState<FleetLogLine[]>([])
  const [alerts, setAlerts] = useState<FleetAlert[]>([])
  const [simAgents, setSimAgents] = useState<Agent[]>([])
  // The baked inventory opens db / cache / lb nodes from the first frame; the service's
  // own introspection replaces a role as soon as it reports it.
  const [codemap, setCodemap] = useState<Codemap | null>(INVENTORY)

  const surgeRef = useRef(surge)
  surgeRef.current = surge
  const sourceRef = useRef<FleetSource>(source)
  const lastFleetRef = useRef<Fleet | null>(null)
  const pendingRef = useRef<FleetNode[]>([])
  const mockRef = useRef<MockFleet | null>(null)
  const pollNowRef = useRef<() => void>(() => {})

  const pushLog = useCallback((level: FleetLogLine['level'], text: string) => {
    setLog((prev) => [...prev, { ts: Date.now(), level, text }].slice(-MAX_LOG))
  }, [])

  const pushAlert = useCallback((a: FleetAlert) => {
    setAlerts((prev) => {
      if (a.state === 'cleared') {
        let hit = false
        const next = prev.map((x) => {
          if (!hit && x.issueId === a.issueId && x.state === 'raised') {
            hit = true
            return { ...x, state: 'cleared', ts: a.ts }
          }
          return x
        })
        return hit ? next : [a, ...prev].slice(0, MAX_ALERTS)
      }
      if (prev.some((x) => x.id === a.id)) return prev
      return [a, ...prev].slice(0, MAX_ALERTS)
    })
  }, [])

  // Merge optimistic (pending) nodes into whatever the server reported.
  const publish = useCallback((f: Fleet | null) => {
    lastFleetRef.current = f
    if (!f) {
      setFleet(null)
      return
    }
    // Single normalization boundary for every fleet frame (WS, poll, SIM, optimistic).
    // The API sends null for fields that don't apply (e.g. the controller and
    // internet nodes have no IPs); the view expects strings, numbers and arrays.
    f = {
      ...f,
      nodes: (f.nodes ?? []).map((n) => ({
        ...n,
        label: n.label ?? n.id,
        publicIp: n.publicIp ?? '—',
        privateIp: n.privateIp ?? '—',
        region: n.region ?? '—',
        type: n.type ?? '—',
        cpu: n.cpu ?? 0,
        memUsed: n.memUsed ?? 0,
        memTotal: n.memTotal ?? 0,
        load1: n.load1 ?? 0,
        processes: (n.processes ?? []).map((p) => ({ ...p, name: p.name ?? '?', ports: p.ports ?? [] })),
        issues: (n.issues ?? []).map((i) => ({
          ...i,
          severity: i.severity ?? 'low',
          title: i.title ?? i.kind ?? 'issue',
          detail: i.detail ?? '',
          source: i.source ?? '—',
        })),
      })),
      links: (f.links ?? []).map((l) => ({
        ...l,
        protocol: l.protocol ?? 'other',
        port: l.port ?? 0,
        bytesPerSec: l.bytesPerSec ?? 0,
        bytesPerSecReverse: l.bytesPerSecReverse ?? 0,
        conns: l.conns ?? 0,
      })),
    }
    const ids = new Set(f.nodes.map((n) => n.id))
    const pend = pendingRef.current.filter((p) => !ids.has(p.id))
    setFleet(pend.length ? { ...f, nodes: [...f.nodes, ...pend] } : f)
  }, [])

  const setSrc = (s: FleetSource) => {
    sourceRef.current = s
    setSource(s)
  }

  useEffect(() => {
    let cancelled = false
    const timers: number[] = []

    // ---------------- SIM (explicit ?sim=1 only) ----------------------------
    if (sim) {
      const mock = new MockFleet()
      mockRef.current = mock
      setRoles(mock.roles())
      setCodemap(mock.codemap())
      setSrc('sim')
      pushLog('info', 'SIM mode (?sim=1): simulated fleet, no real servers are touched')
      let prevIssues = new Map<string, { node: FleetNode; sev: string; title: string; detail: string; kind: string }>()
      const step = () => {
        mock.tick(surgeRef.current)
        const snap = mock.snapshot()
        // synthesize alert frames from issue diffs, same shape as the backend
        const cur = new Map<string, { node: FleetNode; sev: string; title: string; detail: string; kind: string }>()
        for (const n of snap.nodes) for (const i of n.issues ?? []) cur.set(i.id, { node: n, sev: i.severity, title: i.title, detail: i.detail, kind: i.kind })
        const now = Date.now()
        for (const [id, v] of cur) if (!prevIssues.has(id)) pushAlert({ id: `${id}@${now}`, issueId: id, nodeId: v.node.id, label: v.node.label, role: v.node.role, severity: v.sev, kind: v.kind, title: v.title, detail: v.detail, state: 'raised', ts: now })
        for (const [id, v] of prevIssues) if (!cur.has(id)) pushAlert({ id: `${id}@${now}:c`, issueId: id, nodeId: v.node.id, label: v.node.label, role: v.node.role, severity: v.sev, kind: v.kind, title: v.title, detail: v.detail, state: 'cleared', ts: now })
        prevIssues = cur
        publish(snap)
        setSimAgents(mock.agentSnapshot())
        setCodemap(mock.codemap()) // per-route rps changes every tick
      }
      step()
      timers.push(window.setInterval(step, 2000))
      return () => {
        cancelled = true
        timers.forEach((t) => window.clearInterval(t))
        mockRef.current = null
      }
    }

    // ---------------- LIVE ---------------------------------------------------
    let ws: WebSocket | null = null
    let fails = 0
    let lastFrame = 0

    const goLive = async () => {
      if (sourceRef.current === 'live') return
      setSrc('live')
      pushLog('info', 'fleet feed online at :8090')
      try {
        const r = await fetch(API.fleetRoles)
        if (r.ok) setRoles((await r.json()) as FleetRoleInfo[])
      } catch { /* roles optional */ }
      void loadCodemap()
      try {
        const r = await fetch(API.alerts(MAX_ALERTS))
        if (r.ok) {
          const j = (await r.json()) as { alerts?: FleetAlert[] }
          if (!cancelled && j.alerts) setAlerts(j.alerts.slice().sort((a, b) => toMs(b.ts) - toMs(a.ts)).slice(0, MAX_ALERTS))
        }
      } catch { /* history optional */ }
    }

    // Codemap is optional: without it nodes simply don't expand (no invented files).
    // Re-polled every 30s (symbols may appear later); every 3s once it carries
    // per-route traffic (`routes`) so rps stays live.
    let codemapLive = false
    const loadCodemap = async () => {
      try {
        const r = await fetch(API.codemap)
        if (r.ok) {
          const j = (await r.json()) as Codemap
          if (!cancelled && j && j.roles) {
            setCodemap({ roles: { ...INVENTORY.roles, ...j.roles } })
            codemapLive = Object.values(j.roles).some((r) => (r?.routes?.length ?? 0) > 0)
          }
        }
      } catch { /* not available yet */ }
    }
    timers.push(window.setInterval(() => { if (sourceRef.current === 'live' && !codemapLive) void loadCodemap() }, 30000))
    timers.push(window.setInterval(() => { if (sourceRef.current === 'live' && codemapLive) void loadCodemap() }, 3000))

    const goOffline = () => {
      if (sourceRef.current === 'offline') return
      const was = sourceRef.current
      setSrc('offline')
      publish(null)
      if (was === 'live') pushLog('error', 'fleet feed lost: telemetry offline at :8090')
    }

    const poll = async () => {
      try {
        const ctrl = new AbortController()
        const t = window.setTimeout(() => ctrl.abort(), 2500)
        const res = await fetch(API.fleet, { signal: ctrl.signal })
        window.clearTimeout(t)
        if (!res.ok) throw new Error(String(res.status))
        const f = (await res.json()) as Fleet
        if (cancelled) return
        fails = 0
        await goLive()
        // WS frames are fresher; only take the poll when the socket is quiet.
        if (Date.now() - lastFrame > POLL_MS * 1.5) publish(f)
      } catch {
        if (cancelled) return
        fails += 1
        const wsQuiet = Date.now() - lastFrame > 6000
        if (sourceRef.current !== 'live' || (fails >= 3 && wsQuiet)) goOffline()
      }
    }
    pollNowRef.current = () => void poll()

    const connect = () => {
      if (cancelled) return
      try {
        ws = new WebSocket(WS_URL)
      } catch {
        timers.push(window.setTimeout(connect, 4000))
        return
      }
      ws.onmessage = (ev) => {
        if (cancelled) return
        try {
          const msg = JSON.parse(ev.data as string) as { type: string; data: unknown }
          if (msg.type === 'fleet') {
            lastFrame = Date.now()
            fails = 0
            void goLive()
            publish(msg.data as Fleet)
          } else if (msg.type === 'alert') {
            const a = msg.data as FleetAlert
            pushAlert(a)
            if (a.state === 'raised') pushLog(a.severity === 'critical' || a.severity === 'high' ? 'error' : 'info', `ALERT ${a.severity} ${a.label}: ${a.title}`)
            else pushLog('info', `cleared ${a.label}: ${a.title}`)
          }
        } catch { /* ignore malformed frames */ }
      }
      ws.onclose = () => {
        if (!cancelled) timers.push(window.setTimeout(connect, 4000))
      }
    }

    void poll()
    connect()
    timers.push(window.setInterval(() => void poll(), POLL_MS))

    return () => {
      cancelled = true
      timers.forEach((t) => { window.clearInterval(t); window.clearTimeout(t) })
      try { ws?.close() } catch { /* ignore */ }
    }
  }, [sim, publish, pushAlert, pushLog])

  const addNode = useCallback((role: string, pos?: { x: number; y: number }) => {
    const src = sourceRef.current
    if (src !== 'live' && src !== 'sim') {
      pushLog('error', `cannot add ${role}: no fleet feed`)
      return
    }
    tempSeq += 1
    const temp: FleetNode = {
      id: `pending-${tempSeq}`, label: `${role}-…`, role, status: 'provisioning', publicIp: '—', privateIp: '—',
      region: '—', type: '—', cpu: 0, memUsed: 0, memTotal: 0, load1: 0, processes: [], deletable: false, issues: [],
    }
    if (pos) setPlacement(temp.id, pos)
    pendingRef.current = [...pendingRef.current, temp]
    publish(lastFleetRef.current)
    pushLog('info', `POST /api/fleet/nodes {role:"${role}"}`)

    const settle = (node: FleetNode | null, err: string | null) => {
      pendingRef.current = pendingRef.current.filter((p) => p.id !== temp.id)
      const f = lastFleetRef.current
      if (node) {
        aliasNode(temp.id, node.id)
        pushLog('info', `202 provisioning ${node.label} (${role})`)
        if (f && !f.nodes.some((n) => n.id === node.id)) {
          publish({ ...f, nodes: [...f.nodes, node] })
          return
        }
      }
      if (err) pushLog('error', err)
      publish(f)
    }

    if (src === 'sim') {
      const r = mockRef.current?.add(role)
      if (r && r.status === 202 && r.node) settle(r.node, null)
      else settle(null, `POST /api/fleet/nodes → ${r?.status ?? 500} ${r?.error ?? 'failed'}`)
      return
    }
    void (async () => {
      try {
        const res = await fetch(API.fleetNodes, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role }),
        })
        if (res.status === 202 || res.ok) {
          const j = (await res.json()) as { node?: FleetNode }
          settle(j.node ?? null, j.node ? null : `POST /api/fleet/nodes → ${res.status} (no node in response)`)
        } else {
          settle(null, `POST /api/fleet/nodes → ${res.status} ${await readError(res)}`)
        }
      } catch (e) {
        settle(null, `POST /api/fleet/nodes → network error ${(e as Error).message}`)
      }
    })()
  }, [publish, pushLog])

  const deleteNode = useCallback(async (id: string, label: string): Promise<boolean> => {
    const markDeleting = () => {
      const f = lastFleetRef.current
      if (f) publish({ ...f, nodes: f.nodes.map((n) => (n.id === id ? { ...n, status: 'deleting' } : n)) })
    }
    if (sourceRef.current === 'sim') {
      const r = mockRef.current?.remove(id, label)
      if (r?.status === 202) {
        pushLog('info', `202 destroying ${label} (simulated)`)
        markDeleting()
        return true
      }
      pushLog('error', `DELETE /api/fleet/nodes/${id} → ${r?.status ?? 500} ${r?.error ?? 'failed'}`)
      return false
    }
    try {
      const res = await fetch(API.fleetNode(id), { method: 'DELETE', headers: { 'X-Confirm-Label': label } })
      if (res.status === 202 || res.ok) {
        pushLog('info', `202 destroying ${label}`)
        markDeleting()
        return true
      }
      pushLog('error', `DELETE /api/fleet/nodes/${id} → ${res.status} ${await readError(res)}`)
    } catch (e) {
      pushLog('error', `DELETE /api/fleet/nodes/${id} → network error ${(e as Error).message}`)
    }
    return false
  }, [publish, pushLog])

  const rebootNode = useCallback(async (id: string): Promise<boolean> => {
    const node = lastFleetRef.current?.nodes.find((n) => n.id === id)
    if (!node || node.status !== 'running') return false
    try {
      if (sourceRef.current === 'sim') {
        const result = mockRef.current?.reboot(id)
        if (result?.status !== 202) throw new Error(result?.error ?? 'reboot failed')
      } else {
        if (sourceRef.current !== 'live') throw new Error('no fleet feed')
        const res = await fetch(API.fleetReboot(id), { method: 'POST' })
        if (!res.ok) throw new Error(await readError(res))
      }
      const f = lastFleetRef.current
      if (f) publish({ ...f, nodes: f.nodes.map((n) => n.id === id ? { ...n, status: 'rebooting' } : n) })
      pushLog('info', `rebooting ${node.label}`)
      return true
    } catch (error) {
      pushLog('error', `reboot ${node.label} failed: ${(error as Error).message}`)
      return false
    }
  }, [publish, pushLog])

  const retry = useCallback(() => {
    if (sourceRef.current === 'offline') setSrc('connecting')
    pollNowRef.current()
  }, [])

  return { fleet, roles, source, log, alerts, simAgents, codemap, addNode, deleteNode, rebootNode, retry }
}

export function toMs(ts: number | string | undefined): number {
  if (ts === undefined) return Date.now()
  if (typeof ts === 'number') return ts
  const n = Date.parse(ts)
  return Number.isNaN(n) ? Date.now() : n
}
