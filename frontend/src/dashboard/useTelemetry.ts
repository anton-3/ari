import { useEffect, useState } from 'react'
import { API, POLL_INTERVAL_MS, WS_URL } from './config'
import {
  advanceMetrics,
  jitterTopology,
  makeLog,
  makeLogSeed,
  makeMetricsSeed,
  makeTopology,
  makeVuln,
  makeVulnSeed,
} from './mockData'
import type {
  FeedSource,
  LogEntry,
  LogsResponse,
  Metrics,
  Topology,
  VulnsResponse,
  Vuln,
  WsMessage,
} from './types'

const MAX_LOGS = 200
const MAX_VULNS = 40

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

export interface TelemetryState {
  metrics: Metrics | null
  logs: LogEntry[]
  topology: Topology | null
  vulns: Vuln[]
  source: FeedSource
}

/**
 * Live telemetry feed with graceful degradation:
 *   1. WebSocket push  (source = "live")
 *   2. REST polling    (source = "polling")
 *   3. Built-in mock   (source = "mock")
 * The dashboard always renders regardless of what is reachable.
 */
export function useTelemetry(): TelemetryState {
  const [metrics, setMetrics] = useState<Metrics | null>(null)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [topology, setTopology] = useState<Topology | null>(null)
  const [vulns, setVulns] = useState<Vuln[]>([])
  const [source, setSource] = useState<FeedSource>('connecting')

  useEffect(() => {
    let cancelled = false
    let ws: WebSocket | null = null
    let pollTimer: number | undefined
    let staticTimer: number | undefined
    const mockTimers: number[] = []

    const pushLog = (entry: LogEntry) => {
      if (cancelled) return
      setLogs((prev) => [entry, ...prev].slice(0, MAX_LOGS))
    }

    // ---- Mode 3: built-in mock ---------------------------------------------
    const startMock = () => {
      if (cancelled) return
      setSource('mock')
      let m = makeMetricsSeed()
      let topo = makeTopology()
      setMetrics(m)
      setLogs(makeLogSeed().reverse())
      setTopology(topo)
      setVulns(makeVulnSeed())

      mockTimers.push(
        window.setInterval(() => {
          m = advanceMetrics(m)
          setMetrics(m)
        }, 2000),
      )
      mockTimers.push(
        window.setInterval(() => pushLog(makeLog()), 1200),
      )
      mockTimers.push(
        window.setInterval(() => {
          topo = jitterTopology(topo)
          setTopology(topo)
        }, 4000),
      )
      mockTimers.push(
        window.setInterval(() => {
          if (Math.random() < 0.55) {
            setVulns((prev) => [makeVuln(), ...prev].slice(0, MAX_VULNS))
          } else {
            // Ari remediates an open finding.
            setVulns((prev) => {
              const idx = prev.findIndex((v) => v.status !== 'remediated')
              if (idx === -1) return prev
              const next = prev.slice()
              next[idx] = { ...next[idx], status: 'remediated' }
              return next
            })
          }
        }, 5000),
      )
    }

    // ---- Mode 2: REST polling ----------------------------------------------
    const startPolling = () => {
      if (cancelled || pollTimer !== undefined) return
      setSource('polling')
      const poll = async () => {
        const m = await fetchJson<Metrics>(API.metrics)
        if (!cancelled && m) setMetrics(m)
        const lg = await fetchJson<LogsResponse>(API.logs(100))
        if (!cancelled && lg) setLogs(lg.logs.slice().reverse().slice(0, MAX_LOGS))
      }
      void poll()
      pollTimer = window.setInterval(() => void poll(), POLL_INTERVAL_MS)
    }

    // Topology + vulns are REST-only (never pushed over WS), so poll them
    // whenever the REST API is reachable (both live and polling modes).
    const startStaticPolling = () => {
      if (staticTimer !== undefined) return
      const poll = async () => {
        const topo = await fetchJson<Topology>(API.topology)
        if (!cancelled && topo) setTopology(topo)
        const vl = await fetchJson<VulnsResponse>(API.vulns)
        if (!cancelled && vl) setVulns(vl.vulns.slice(0, MAX_VULNS))
      }
      void poll()
      staticTimer = window.setInterval(() => void poll(), 5000)
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
          if (msg.type === 'metrics') setMetrics(msg.data)
          else if (msg.type === 'log') pushLog(msg.data)
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

    // ---- Boot: probe REST, then prefer WS ----------------------------------
    const boot = async () => {
      const m = await fetchJson<Metrics>(API.metrics)
      if (cancelled) return
      if (!m) {
        startMock()
        return
      }
      setMetrics(m)
      const lg = await fetchJson<LogsResponse>(API.logs(100))
      if (!cancelled && lg) setLogs(lg.logs.slice().reverse().slice(0, MAX_LOGS))
      startStaticPolling()
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
      if (staticTimer !== undefined) window.clearInterval(staticTimer)
      mockTimers.forEach((t) => window.clearInterval(t))
    }
  }, [])

  return { metrics, logs, topology, vulns, source }
}
