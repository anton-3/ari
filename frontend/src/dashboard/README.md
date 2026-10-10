# Ari — Security Operations Dashboard

A live SOC / "mission control" dashboard for **Ari**, the always-on AI security
engineer. It shows live traffic, an animated network topology, a vulnerability
feed, and a streaming log ticker.

This is a **separate, self-contained area** of the Vite app. It does not touch
the existing landing page (`src/App.tsx`, entry `index.html`).

## How to view it

```bash
cd frontend
npm install        # first time only (adds `recharts`)
npm run dev
```

Then open:

- **Dashboard:** http://localhost:5173/dashboard.html
- Landing page (unchanged): http://localhost:5173/

Production build serves both pages too:

```bash
npm run build      # emits dist/index.html  AND  dist/dashboard.html
npm run preview
```

### Why a second HTML entry?
The app has no router, so instead of adding one (and risking the landing page)
the dashboard is a second Vite entry: `frontend/dashboard.html` +
`src/dashboard/main.tsx`, registered in `vite.config.ts` under
`build.rollupOptions.input` alongside the original `index.html`. The landing
page's entry and code are untouched.

## Telemetry dependency

The dashboard reads from a separate **telemetry service** expected at
`http://localhost:8090` (CORS enabled). The base URL lives in exactly one place:
`src/dashboard/config.ts` (`TELEMETRY_BASE_URL`).

API consumed:

| Endpoint | Purpose |
|---|---|
| `GET /api/metrics` | current metrics + rolling `series` for the traffic chart & tiles |
| `GET /api/logs?limit=100` | recent log entries |
| `GET /api/topology` | nodes + edges for the graph |
| `GET /api/vulns` | vulnerability findings |
| `WS /ws` | pushes `{type:"metrics", data}` every ~1s and `{type:"log", data}` |

## Data source priority & mock fallback

`useTelemetry.ts` degrades gracefully, and the top-bar chip shows which mode is
active:

1. **WebSocket** (`ws://localhost:8090/ws`) — preferred for live metrics & logs.
2. **REST polling** — if the socket can't connect/closes (topology & vulns are
   REST-only and are always polled when the API is reachable).
3. **Built-in mock data** (`mockData.ts`) — if the service is unreachable, the
   dashboard generates realistic, continuously-evolving data so it always
   renders during development/demos. No service required.

## Files

```
src/dashboard/
  main.tsx            # entry (mounts to #dashboard-root in dashboard.html)
  Dashboard.tsx       # layout: composes the panels
  config.ts           # TELEMETRY_BASE_URL + endpoints (single config constant)
  types.ts            # API types
  useTelemetry.ts     # WS -> polling -> mock data hook
  mockData.ts         # fallback data generators
  helpers.ts          # formatting + sparkline geometry
  dashboard.css       # scoped dark theme (.ari)
  components/
    TopBar.tsx        # brand + Ari presence chip + feed status + clock
    StatTiles.tsx     # active users / error rate / latency / bandwidth
    TrafficPanel.tsx  # requests-per-second area chart (recharts)
    TopologyPanel.tsx # animated SVG node-graph
    VulnsPanel.tsx    # severity-badged vulnerability feed
    LogStream.tsx     # live log ticker
```

## Added dependency

- [`recharts`](https://recharts.org) — the live traffic chart.
