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
  source: FeedSource
}

export function useTelemetry(): TelemetryState {
  const [state, setState] = useState<TelemetryState>({
    metrics: null,
    logs: [],
    topology: null,
    vulns: [],
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
        const [metrics, logs, topology, findings] = await Promise.all([
          request<Metrics>(API.metrics),
          request<LogsResponse>(API.logs(MAX_LOGS)),
          request<Topology>(API.topology),
          request<VulnsResponse>(API.vulns),
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
