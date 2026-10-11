import { useEffect, useState } from 'react'
import { API, POLL_INTERVAL_MS, WS_URL } from './config'
import {
  advanceMetrics,
  makeLog,
  makeLogSeed,
  makeMetricsSeed,
  makeTopology,
  makeVulnSeed,
} from './mockData'
import type {
  Agent,
  AgentEvent,
  AgentsResponse,
  ReasoningLine,
  ReasoningResponse,
} from '../graph/types'
import type {
  ActivityLine,
  FeedSource,
  LogEntry,
  LogsResponse,
  Metrics,
  Topology,
  Vuln,
  VulnsResponse,
  WsMessage,
} from './types'

const MAX_LOGS = 200
const MAX_ACTIVITY = 60

// Ari's own narration and agent events arrive by both WebSocket and polling,
// so lines are merged by identity and kept in time order.
function mergeActivity(
  previous: ActivityLine[],
  incoming: ActivityLine[],
): ActivityLine[] {
  if (!incoming.length) return previous
  const seen = new Set(previous.map((line) => `${line.ts}|${line.text}`))
  const fresh = incoming.filter((line) => !seen.has(`${line.ts}|${line.text}`))
  if (!fresh.length) return previous
  return [...previous, ...fresh].sort((a, b) => a.ts - b.ts).slice(-MAX_ACTIVITY)
}
const fromReasoning = (lines: ReasoningLine[] | undefined): ActivityLine[] =>
  (lines ?? []).map((line) => ({
    ts: timestamp(line.ts),
    source: 'ari',
    text: line.text,
  }))
const fromEvents = (events: AgentEvent[] | undefined): ActivityLine[] =>
  (events ?? []).map((event) => ({
    ts: timestamp(event.ts),
    source: 'agent',
    text: event.text,
    severity: event.severity ?? event.finding?.severity,
  }))

// The service sends ISO dates; the UI keeps timestamps in milliseconds.
function timestamp(value: unknown): number {
  const result = typeof value === 'number' ? value : Date.parse(String(value))
  return Number.isFinite(result) ? result : 0
}
function normalizeMetrics(data: Metrics): Metrics {
  return {
    ...data,
    ts: timestamp(data.ts),
    series: data.series.map((point) => ({ ...point, t: timestamp(point.t) })),
  }
}
function normalizeLog(data: LogEntry): LogEntry {
  return { ...data, ts: timestamp(data.ts) }
}

export interface TelemetryState {
  metrics: Metrics | null
  logs: LogEntry[]
  topology: Topology | null
  vulns: Vuln[]
  agents: Agent[]
  activity: ActivityLine[]
  source: FeedSource
}

export function useTelemetry(): TelemetryState {
  const [state, setState] = useState<TelemetryState>({
    metrics: null,
    logs: [],
    topology: null,
    vulns: [],
    agents: [],
    activity: [],
    source: 'connecting',
  })

  useEffect(() => {
    let cancelled = false
    let polling = false
    let receivedServiceData = false
    let socket: WebSocket | null = null
    let lastFrame = 0
    let socketStartedAt = 0
    let nextSocketAttempt = 0
    let demo: Metrics | null = null
    const controllers = new Set<AbortController>()

    async function request<T>(url: string): Promise<T | null> {
      const controller = new AbortController()
      controllers.add(controller)
      const timer = window.setTimeout(() => controller.abort(), 2500)
      try {
        const response = await fetch(url, { signal: controller.signal })
        return response.ok ? ((await response.json()) as T) : null
      } catch {
        return null
      } finally {
        window.clearTimeout(timer)
        controllers.delete(controller)
      }
    }

    function connect() {
      if (cancelled || socket || Date.now() < nextSocketAttempt) return
      nextSocketAttempt = Date.now() + 5000
      let ws: WebSocket
      try {
        ws = new WebSocket(WS_URL)
      } catch {
        return
      }
      socket = ws
      socketStartedAt = Date.now()
      ws.onmessage = (event) => {
        if (cancelled) return
        try {
          const message = JSON.parse(event.data as string) as WsMessage
          if (message.type === 'agents') {
            const agents = message.data.agents ?? []
            const events = fromEvents(message.data.events)
            setState((previous) => ({
              ...previous,
              agents,
              activity: mergeActivity(previous.activity, events),
            }))
            return
          }
          if (message.type === 'reasoning') {
            const lines = fromReasoning([message.data])
            setState((previous) => ({
              ...previous,
              activity: mergeActivity(previous.activity, lines),
            }))
            return
          }
          if (message.type !== 'metrics' && message.type !== 'log') return
          lastFrame = Date.now()
          receivedServiceData = true
          demo = null
          setState((previous) =>
            message.type === 'metrics'
              ? {
                  ...previous,
                  metrics: normalizeMetrics(message.data),
                  source: 'live',
                }
              : {
                  ...previous,
                  logs: [normalizeLog(message.data), ...previous.logs].slice(
                    0,
                    MAX_LOGS,
                  ),
                  source: 'live',
                },
          )
        } catch {
          /* Ignore incomplete frames; polling remains available. */
        }
      }
      ws.onerror = () => ws.close()
      ws.onclose = () => {
        if (socket === ws) socket = null
      }
    }

    async function poll() {
      if (cancelled || polling) return
      polling = true
      try {
        const [metrics, logs, topology, findings, swarm, reasoning] =
          await Promise.all([
          request<Metrics>(API.metrics),
          request<LogsResponse>(API.logs(MAX_LOGS)),
          request<Topology>(API.topology),
          request<VulnsResponse>(API.vulns),
          request<AgentsResponse>(API.agents),
          request<ReasoningResponse>(API.reasoning(20)),
        ])
        if (cancelled) return
        if (metrics) {
          const wasDemo = demo !== null
          receivedServiceData = true
          demo = null
          setState((previous) => ({
            metrics: normalizeMetrics(metrics),
            logs: logs
              ? logs.logs.map(normalizeLog).reverse().slice(0, MAX_LOGS)
              : wasDemo
                ? []
                : previous.logs,
            topology: topology ?? (wasDemo ? null : previous.topology),
            vulns: findings
              ? findings.vulns.map((finding) => ({
                  ...finding,
                  discoveredAt: timestamp(finding.discoveredAt),
                }))
              : wasDemo
                ? []
                : previous.vulns,
            agents: swarm?.agents ?? previous.agents,
            activity: mergeActivity(wasDemo ? [] : previous.activity, [
              ...fromReasoning(reasoning?.lines),
              ...fromEvents(swarm?.events),
            ]),
            source:
              socket?.readyState === WebSocket.OPEN &&
              Date.now() - lastFrame < 5000
                ? 'live'
                : 'polling',
          }))
          if (
            socket &&
            Date.now() - Math.max(lastFrame, socketStartedAt) > 10000
          ) {
            socket.close()
            socket = null
          }
          connect()
        } else if (Date.now() - lastFrame > 5000) {
          if (receivedServiceData) {
            // Keep the last service snapshot rather than replace it with fake activity.
            setState((previous) => ({ ...previous, source: 'offline' }))
          } else if (!demo) {
            demo = makeMetricsSeed()
            setState({
              metrics: demo,
              logs: makeLogSeed().reverse(),
              topology: makeTopology(),
              vulns: makeVulnSeed(),
              agents: [],
              activity: [],
              source: 'mock',
            })
          } else {
            demo = advanceMetrics(demo)
            setState((previous) => ({
              ...previous,
              metrics: demo,
              logs: [makeLog(), ...previous.logs].slice(0, MAX_LOGS),
              source: 'mock',
            }))
          }
        }
      } finally {
        polling = false
      }
    }

    void poll()
    const timer = window.setInterval(() => void poll(), POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      controllers.forEach((controller) => controller.abort())
      socket?.close()
    }
  }, [])

  return state
}
