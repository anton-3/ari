# Ari dashboard

The dashboard implements `/tmp/dashboard-html.zip`'s infrastructure map, live-user
chart, findings panel, and Ari activity strip using the landing page's shared
Instrument Sans typography, black surfaces, blue accent, and six-pixel corners.

From `frontend/`, run `npm ci` and `npm run dev`, then open
http://localhost:5173/dashboard.html. The landing page remains at `/`.
`npm run build` emits both HTML entries.

## Telemetry

Start the `telemetry/` service on port 8090. The frontend reads:

- `GET /api/metrics`: current active users and their three-minute history.
- `GET /api/topology`: node health and network connections.
- `GET /api/vulns`: findings, projects, status, and severity counts.
- `GET /api/logs`: recent activity and warning/error events.
- `WS /ws`: metric and log updates.

REST polling continues every two seconds and reconnects the WebSocket after a
failure. Initial service failures fall back to clearly labeled demo data; after
receiving service data, an outage preserves the last snapshot and shows offline.
The service is probed continuously so either mode recovers automatically.
ISO timestamps are normalized to milliseconds at the frontend boundary.

Optional `frontend/.env.local` settings (restart Vite after changing them):

```dotenv
VITE_TELEMETRY_URL=http://localhost:8090
VITE_ARI_PHONE=+15551234567
```

Only the public phone number goes in Vite configuration; backend credentials
must stay in the backend environment. A remote HTTPS deployment needs an HTTPS
telemetry endpoint with WebSocket support.

## Reference values without an API source

Node CPU percentages are replaced by reported health. Repo and weekly-fix
counts become project and remediated-finding counts. Scan progress, cloud region,
and agent/call status are not fabricated. The findings footer identifies watched
projects; navigation opens findings, event, agent, and integration details.
The local telemetry service itself generates synthetic traffic; its connection
status means a working feed, not production traffic.

“Push to talk” shows `alert('not implemented yet')`, as requested. It does not
request microphone access, provision instances, or make calls.
