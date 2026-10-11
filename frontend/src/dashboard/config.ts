// Single source of truth for the telemetry service location.
// The telemetry service (built separately) serves the REST + WS API described
// in ./types.ts on this origin, with CORS enabled.
export const TELEMETRY_BASE_URL = (
  import.meta.env.VITE_TELEMETRY_URL || 'http://localhost:8090'
).replace(/\/$/, '')

// Public contact numbers only; never expose backend credentials through Vite.
export const ARI_PHONE = import.meta.env.VITE_ARI_PHONE || '+19137046751'

// Derived endpoints — keep all URL construction here.
export const API = {
  metrics: `${TELEMETRY_BASE_URL}/api/metrics`,
  logs: (limit = 100) => `${TELEMETRY_BASE_URL}/api/logs?limit=${limit}`,
  topology: `${TELEMETRY_BASE_URL}/api/topology`,
  vulns: `${TELEMETRY_BASE_URL}/api/vulns`,
  agents: `${TELEMETRY_BASE_URL}/api/agents`,
  reasoning: (limit = 50) =>
    `${TELEMETRY_BASE_URL}/api/reasoning?limit=${limit}`,
}

export const WS_URL = `${TELEMETRY_BASE_URL.replace(/^http/, 'ws')}/ws`

// How often to poll the REST endpoints when the WebSocket is unavailable.
export const POLL_INTERVAL_MS = 2000
