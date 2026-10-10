# Ari Telemetry Service

Traffic generator + live telemetry for the **Ari** always-on AI security engineer demo.
It simulates realistic live traffic and exposes a metrics / logs / topology / vulnerabilities
API over HTTP + WebSocket that the dashboard UI and Ari's backend both read.

- Default **PORT 8090** (override with `PORT`).
- **Synthetic mode (default):** generates fake numbers and log entries only. It sends **no real
  network attack traffic anywhere**.
- **Optional live mode:** set `LIVE_TARGET=http://localhost:8070` to make *benign* HTTP GETs to the
  AcmePay target app to sample real-ish latency. It never floods (one GET every 5s).

## Run

```bash
cd telemetry
npm install
npm start                 # http://localhost:8090  (synthetic mode)
# optional live sampling of AcmePay:
LIVE_TARGET=http://localhost:8070 npm start
```

Flip modes from another terminal:

```bash
npm run surge             # POST /api/mode { mode: "surge" }  -> numbers spike
npm run normal            # POST /api/mode { mode: "normal" } -> back to baseline
```

## Modes

- **normal** — steady realistic baseline with gentle noise + diurnal variation.
- **surge** (aka attack) — sharp spike in requests-per-second, error rate, latency and bandwidth,
  concentrated from a small set of source IPs (looks like a DDoS / brute-force). Topology nodes
  degrade while a surge is active.

Starts in `normal`. Switch at runtime via `POST /api/mode`.

## API contract

```
GET /api/metrics
-> { ts, mode, rps, errorRate, latencyMs, activeUsers, bandwidthMbps,
     series: [{ t, rps, errorRate, latencyMs, activeUsers }] }   // series = last ~300 points

GET /api/logs?limit=100
-> { logs: [{ ts, level, source, ip, method, path, status, msg }] }   // newest last

GET /api/topology
-> { nodes: [{ id, label, type, status }], edges: [{ from, to }] }
   // type in: edge/firewall/lb/app/db/cache ; status in: healthy/degraded/down

GET /api/vulns
-> { vulns: [{ id, severity, title, project, endpoint, status, discoveredAt }] }
   // severity: critical/high/medium/low ; status: open/remediated

POST /api/mode   body { mode: "normal"|"surge", target?: string }
-> { ok: true, mode }

POST /api/vulns  body { ...vuln }
-> { ok: true, vuln }       // adds a new vuln or updates an existing one by `id`

PATCH /api/vulns/:id   body { status: "open"|"remediated" }
-> { ok: true, vuln }       // mark a vuln remediated (or reopen)

GET /health
-> { ok: true, mode, uptimeMs }

WebSocket  ws://localhost:8090/ws
-> { type: "metrics", data: <same shape as GET /api/metrics> }   // every 1s
-> { type: "log",     data: <single log entry> }                 // as logs arrive
```

CORS is enabled (permissive) so the dashboard can call from any origin.

## Notes

- In-memory rolling state: ~5 min of metrics at 1s resolution (300 points), ~500 log entries,
  a seeded topology (internet -> WAF/edge -> load balancer -> 2 app nodes -> Postgres + Redis),
  and 3-5 seeded example vulnerabilities (mixed severities/statuses) referencing AcmePay.
- No API keys or secrets required.
