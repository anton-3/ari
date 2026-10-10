// Single source of truth for the telemetry service location for the graph page.
// The telemetry service (built separately) serves the REST + WS API described in
// ./types.ts on this origin, with CORS enabled. This mirrors the dashboard's
// config.ts intentionally so the two pages stay in sync but remain isolated.
export const TELEMETRY_BASE_URL = 'http://localhost:8090'

// Derived endpoints — keep all URL construction here.
export const API = {
  repograph: `${TELEMETRY_BASE_URL}/api/repograph`,
  topology: `${TELEMETRY_BASE_URL}/api/topology`,
  metrics: `${TELEMETRY_BASE_URL}/api/metrics`,
  agents: `${TELEMETRY_BASE_URL}/api/agents`,
  reasoning: (limit = 50) => `${TELEMETRY_BASE_URL}/api/reasoning?limit=${limit}`,
  fleet: `${TELEMETRY_BASE_URL}/api/fleet`,
  codemap: `${TELEMETRY_BASE_URL}/api/fleet/codemap`,
  fleetRoles: `${TELEMETRY_BASE_URL}/api/fleet/roles`,
  fleetNodes: `${TELEMETRY_BASE_URL}/api/fleet/nodes`,
  alerts: (limit = 50) => `${TELEMETRY_BASE_URL}/api/alerts?limit=${limit}`,
  fleetNode: (id: string) => `${TELEMETRY_BASE_URL}/api/fleet/nodes/${encodeURIComponent(id)}`,
}

export const WS_URL = `${TELEMETRY_BASE_URL.replace(/^http/, 'ws')}/ws`

// How often to poll the REST endpoints when the WebSocket is unavailable.
export const POLL_INTERVAL_MS = 2000
