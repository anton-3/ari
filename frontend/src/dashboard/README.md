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
- `GET /api/fleet`, `/api/fleet/codemap`, `/api/fleet/roles`, `/api/alerts`:
  the isometric infrastructure map (servers, links, code tree, addable roles).
- `GET /api/agents`: check jobs drawn on the map.
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

## Infrastructure map

The infrastructure card renders the isometric fleet map from `src/graph`
(`IsoView`, fed by `useFleet`), the same scene as `/graph.html`: pan, wheel zoom,
double-click to refit, click a server to open its files and symbols, Esc to step
out, drag servers on the grid. Selecting a server, file, symbol or connection
shows a small detail popup in the map's top-right corner. The "reboot server" button restarts the selected running server while preserving
its disks and map position. The block shrinks during shutdown, then grows back
with the existing boot loading ring until telemetry confirms it is ready.
The Ari controller node
and the add-server buttons are hidden for now.

Every server opens into layers that suit it: app, worker and traffic nodes into
their source files, then routes and functions; the Postgres node into tables,
then columns and indexes; the Redis node into keys, then hash fields; the nginx
node into config files, then blocks, locations and directives. The non-code
layers come from `src/graph/inventorySnapshot.ts`, a baked copy of what the live
servers held, so they open on the first frame; the telemetry service re-reads
the servers every minute and its answer in `/api/fleet/codemap` replaces the
baked copy. Regenerate the snapshot with `npm run snapshot:inventory` in
`telemetry/`.

The fleet API is localhost-only. When it has no servers or cannot be reached,
the card shows the built-in simulated fleet after a four-second grace period and
says so in its footer; it switches back as soon as real servers appear. Server
positions are shared with `/graph.html` through `localStorage`.

## Ari activity

The bottom card is a teletype of Ari's own narration (`GET /api/reasoning` and
`reasoning` WebSocket frames), agent events, and warning or error log lines,
oldest at the top with the newest line entering at the bottom. Ordinary traffic
logs only fill the card while there is nothing else to show.

## Reference values without an API source

Node CPU percentages are replaced by reported health. Repo and weekly-fix
counts become project and remediated-finding counts. Scan progress, cloud region,
and agent/call status are not fabricated. The findings footer identifies watched
projects; navigation opens findings, event, agent, and integration details.
The local telemetry service itself generates synthetic traffic; its connection
status means a working feed, not production traffic.

The demo baseline generator sends real requests with per-request noise, short
bursts and slow random drift around 60 requests/minute. Its cadence leaves
headroom inside the ±50% limit for five-second request-count buckets.
