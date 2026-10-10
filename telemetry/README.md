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

GET /api/repograph
-> { nodes: [{ id, path, dir, label, loc, kind }], edges: [{ from, to }], scannedAt }
   // kind in: app/backend/telemetry ; one node per scanned source file.
   // id/path = repo-relative path (e.g. "target-app/src/server.js"); label = basename;
   // loc = line count. edges = textually-parsed import/require relationships
   // (relative paths resolved to files in the set; externals ignored).
   // Rescans at startup and every ~30s.

GET /api/agents
-> { agents: [{ id, type, label, status, targetNodeId, progress, spawnedAt, note }],
     events: [{ ts, id, type, text, agentId?, agentType?, targetNodeId?, finding? }] }
   // type in: scanner/log-watcher/verifier/remediator
   // status in: idle/dispatched/working/reporting/done ; progress 0..1
   // targetNodeId = a repograph node id (file) or topology node id
   // events = capped activity log (deploy/done/finding/recall); a "finding" event
   //   carries finding:{ id, title, severity, file, line, endpoint } referencing
   //   a real SECURITY-NOTES item.

POST /api/agents/deploy   body { count, type?, focus? }
-> { ok: true, agents: [<new agent>, ...] }
   // spawns `count` (1..50) simulated agents. type optional (one of the 4 types,
   // else mixed). focus optional substring to bias target selection by path/label.
   // Agents prefer files tied to documented AcmePay findings, else spread across
   // the graph. SIMULATION ONLY — no real scanning or network activity.

POST /api/agents/recall
-> { ok: true, recalled, agents, events }   // winds active agents down to done/idle

GET /api/reasoning?limit=50
-> { lines: [{ ts, text }] }                // rolling buffer (~50) of Ari status lines

WebSocket  ws://localhost:8090/ws
-> { type: "metrics",   data: <same shape as GET /api/metrics> }    // every 1s
-> { type: "log",       data: <single log entry> }                 // as logs arrive
-> { type: "agents",    data: { agents, events } }                 // every 1s (same shape as GET /api/agents)
-> { type: "reasoning", data: { ts, text } }                       // ~1 line / 2s, as lines appear
   // On connect a client also receives one immediate "metrics" and one "agents" snapshot.
```

CORS is enabled (permissive) so the dashboard can call from any origin.

## Notes

- In-memory rolling state: ~5 min of metrics at 1s resolution (300 points), ~500 log entries,
  a seeded topology (internet -> WAF/edge -> load balancer -> 2 app nodes -> Postgres + Redis),
  and 3-5 seeded example vulnerabilities (mixed severities/statuses) referencing AcmePay.
- No API keys or secrets required.

### Agent swarm (simulation)

`src/repograph.js`, `src/swarm.js` and `src/reasoning.js` add a simulated swarm of Ari's
helper agents over a live scan of the team's own repo. Everything is in-memory and
read-only: the repo scanner only reads source files, the swarm only mutates in-memory
state on the 1s tick, and reasoning lines are flavor/status text. Nothing here runs code,
scans, or sends any network traffic. Simulated "findings" reference real items from
`target-app/SECURITY-NOTES.md` and are recorded into the existing vulns store (ids
prefixed `AGT-VULN-`) via the local upsert, so they also appear in `GET /api/vulns`.
