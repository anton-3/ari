import { useEffect, useRef, useState } from 'react'
import { API, POLL_INTERVAL_MS, WS_URL } from './config'
import {
  advanceAgents,
  advanceMetrics,
  jitterTopology,
  makeAgentsSeed,
  makeMetricsSeed,
  makeReasoningLine,
  makeReasoningSeed,
  makeRepoGraph,
  makeTopology,
} from './mockData'
import type {
  Agent,
  AgentEvent,
  AgentsResponse,
  FeedSource,
  Metrics,
  ReasoningLine,
  ReasoningResponse,
  RepoGraph,
  Topology,
  WsMessage,
} from './types'

const MAX_REASONING = 60
const MAX_EVENTS = 40

async function fetchJson<T>(url: string, timeoutMs = 2500): Promise<T | null> {
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    const res = await fetch(url, { signal: ctrl.signal })
    clearTimeout(timer)
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

export interface GraphTelemetry {
  repoGraph: RepoGraph | null
  topology: Topology | null
  metrics: Metrics | null
  agents: Agent[]
  events: AgentEvent[]
  reasoning: ReasoningLine[]
  source: FeedSource
}

function hubTargetIds(topo: Topology | null, repo: RepoGraph | null): string[] {
  const ids: string[] = []
  if (repo) ids.push(...repo.nodes.map((n) => n.id))
  if (topo) ids.push(...topo.nodes.map((n) => n.id))
  return ids.length > 0 ? ids : ['api', 'auth', 'db']
}

/**
 * Live telemetry feed for the graph page with graceful degradation:
 *   1. WebSocket push  (source = "live")
 *   2. REST polling    (source = "polling")
 *   3. Built-in self-evolving mock (source = "mock")
 * The page always renders and animates regardless of what is reachable.
 */
export function useTelemetry(): GraphTelemetry {
  const [repoGraph, setRepoGraph] = useState<RepoGraph | null>(null)
  const [topology, setTopology] = useState<Topology | null>(null)
  const [metrics, setMetrics] = useState<Metrics | null>(null)
  const [agents, setAgents] = useState<Agent[]>([])
  const [events, setEvents] = useState<AgentEvent[]>([])
  const [reasoning, setReasoning] = useState<ReasoningLine[]>([])
  const [source, setSource] = useState<FeedSource>('connecting')

  // Keep latest graph refs so mock agent dispatch can target real nodes.
  const topoRef = useRef<Topology | null>(null)
  const repoRef = useRef<RepoGraph | null>(null)
  topoRef.current = topology
  repoRef.current = repoGraph

  useEffect(() => {
    let cancelled = false
    let ws: WebSocket | null = null
    let pollTimer: number | undefined
    const mockTimers: number[] = []

    const pushReasoning = (line: ReasoningLine) => {
      if (cancelled) return
      setReasoning((prev) => [...prev, line].slice(-MAX_REASONING))
    }
    // The service tags events with `type` ("finding" | "deploy" | …); the page
    // reads `kind`. Normalise so both the live and mock paths behave the same.
    const normalize = (evs: AgentEvent[] | undefined): AgentEvent[] =>
      (evs ?? []).map((e) => {
        const withType = e as AgentEvent & { type?: string }
        return e.kind ? e : { ...e, kind: withType.type ?? 'event' }
      })
    const pushEvents = (evs: AgentEvent[] | undefined) => {
      const norm = normalize(evs)
      if (cancelled || norm.length === 0) return
      setEvents((prev) => [...norm, ...prev].slice(0, MAX_EVENTS))
    }

    // ---- Mode 3: built-in self-evolving mock -------------------------------
    const startMock = () => {
      if (cancelled) return
      setSource('mock')
      let m = makeMetricsSeed()
      let topo = makeTopology()
      const repo = makeRepoGraph()
      const targets = hubTargetIds(topo, repo)
      let swarm: AgentsResponse = makeAgentsSeed(targets)

      setMetrics(m)
      setTopology(topo)
      setRepoGraph(repo)
      setAgents(swarm.agents)
      setReasoning(makeReasoningSeed())

      mockTimers.push(
        window.setInterval(() => {
          m = advanceMetrics(m)
          setMetrics(m)
        }, 2000),
      )
      mockTimers.push(
        window.setInterval(() => {
          topo = jitterTopology(topo)
          setTopology(topo)
        }, 4000),
      )
      mockTimers.push(
        window.setInterval(() => {
          swarm = advanceAgents(swarm, hubTargetIds(topo, repo))
          setAgents(swarm.agents)
          pushEvents(swarm.events)
        }, 1400),
      )
      mockTimers.push(
        window.setInterval(() => pushReasoning(makeReasoningLine()), 3500),
      )
    }

    // ---- Mode 2: REST polling ----------------------------------------------
    const startPolling = () => {
      if (cancelled || pollTimer !== undefined) return
      setSource('polling')
      const poll = async () => {
        const [m, ag, rs] = await Promise.all([
          fetchJson<Metrics>(API.metrics),
          fetchJson<AgentsResponse>(API.agents),
          fetchJson<ReasoningResponse>(API.reasoning(MAX_REASONING)),
        ])
        if (cancelled) return
        if (m) setMetrics(m)
        if (ag) {
          setAgents(ag.agents)
          pushEvents(ag.events ?? [])
        }
        if (rs) setReasoning(rs.lines.slice(-MAX_REASONING))
      }
      void poll()
      pollTimer = window.setInterval(() => void poll(), POLL_INTERVAL_MS)
    }

    // ---- Mode 1: WebSocket -------------------------------------------------
    const connectWs = () => {
      let opened = false
      try {
        ws = new WebSocket(WS_URL)
      } catch {
        startPolling()
        return
      }
      const failTimer = window.setTimeout(() => {
        if (!opened) {
          try {
            ws?.close()
          } catch {
            /* ignore */
          }
          startPolling()
        }
      }, 3000)

      ws.onopen = () => {
        opened = true
        window.clearTimeout(failTimer)
        if (!cancelled) setSource('live')
      }
      ws.onmessage = (ev) => {
        if (cancelled) return
        try {
          const msg = JSON.parse(ev.data as string) as WsMessage
          if (msg.type === 'metrics') setMetrics(msg.data as Metrics)
          else if (msg.type === 'agents') {
            const d = msg.data as AgentsResponse
            setAgents(d.agents)
            pushEvents(d.events ?? [])
          } else if (msg.type === 'reasoning') {
            pushReasoning(msg.data as ReasoningLine)
          }
        } catch {
          /* ignore malformed frames */
        }
      }
      ws.onerror = () => {
        /* onclose drives the fallback */
      }
      ws.onclose = () => {
        window.clearTimeout(failTimer)
        if (!cancelled) startPolling()
      }
    }

    // ---- Boot: probe REST, fetch static graphs, then prefer WS -------------
    const boot = async () => {
      const m = await fetchJson<Metrics>(API.metrics)
      if (cancelled) return
      if (!m) {
        startMock()
        return
      }
      setMetrics(m)
      const [repo, topo, ag, rs] = await Promise.all([
        fetchJson<RepoGraph>(API.repograph),
        fetchJson<Topology>(API.topology),
        fetchJson<AgentsResponse>(API.agents),
        fetchJson<ReasoningResponse>(API.reasoning(MAX_REASONING)),
      ])
      if (cancelled) return
      // Fill any gaps from the service with mock so the page is always complete.
      setRepoGraph(repo ?? makeRepoGraph())
      setTopology(topo ?? makeTopology())
      if (ag) setAgents(ag.agents)
      else setAgents(makeAgentsSeed(hubTargetIds(topo, repo)).agents)
      setReasoning(rs ? rs.lines.slice(-MAX_REASONING) : makeReasoningSeed())
      connectWs()
    }

    void boot()

    return () => {
      cancelled = true
      try {
        ws?.close()
      } catch {
        /* ignore */
      }
      if (pollTimer !== undefined) window.clearInterval(pollTimer)
      mockTimers.forEach((t) => window.clearInterval(t))
    }
  }, [])

  return { repoGraph, topology, metrics, agents, events, reasoning, source }
}
