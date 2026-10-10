# Ari Telemetry Service

Traffic generator + live telemetry for the **Ari** always-on AI security engineer demo.
It simulates realistic live traffic and exposes a metrics / logs / topology / vulnerabilities
API over HTTP + WebSocket that the dashboard UI and Ari's backend both read.

- Default **PORT 8090** (override with `PORT`).
- **Synthetic mode (default):** generates fake numbers and log entries only. It sends **no real
  network attack traffic anywhere**. (The separate **ari-net fleet** below is real
  infrastructure with real, modest demo traffic between our own servers.)
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

## ari-net fleet (REAL infrastructure)

`src/fleet/` runs a **real** fleet of Linode nanodes serving AcmePay, maps it live
(real TCP byte counters), and lets the UI add or delete nodes, which **creates or
destroys real Linode servers**. Enabled automatically when `LINODE_API_TOKEN` is set
(env, or read from `backend/.env`) and `~/.ssh/id_ed25519(.pub)` exists.

### Topology / roles

```
traffic ──http:80──▶ lb (nginx) ──http-app:3000──▶ app-1..N (AcmePay)
                                                     ├─postgres:5432──▶ db (PostgreSQL)
                                                     └─redis:6379─────▶ cache (Redis)
worker ──postgres:5432──▶ db
controller (this Mac) ┄┄control:22┄┄▶ every node      internet ──▶ lb:80 / *:22 (bots)
```

| role | what runs | notes |
|------|-----------|-------|
| `lb` | nginx :80, upstream = every ready app node's private IP:3000 | singleton; the controller rewrites `/etc/nginx/ari-net-upstream.conf` over SSH and reloads whenever app nodes come or go (plus a 20s resync) |
| `app` | AcmePay on :3000 (Node 20, systemd `acmepay`) | `DATABASE_URL` -> db, `REDIS_URL` -> cache; joins the lb when ready |
| `db` | PostgreSQL 16 on localhost + private IP | singleton; `pg_hba` allows 192.168.128.0/17 with a password generated on the node (`/etc/ari-net/db.pass`) |
| `cache` | Redis on localhost + private IP, `requirepass` | AcmePay counts requests per route (`HINCRBY acmepay:hits`) and caches `GET /api/merchants` for 5s |
| `traffic` | `fleet-roles/traffic.py` (systemd `ari-traffic`) | keep-alive request mix (merchants, transaction search, logins incl. some bad passwords, payments, user lookups, health, ~4% 404s). `normal` ≈ 3 req/s, `surge` ≈ 40 req/s, read from `/etc/ari-net/traffic.mode` |
| `worker` | `fleet-roles/worker.py` (systemd `ari-worker`) | one persistent Postgres connection; ledger summary every 3s, settles one old `pending` txn every ~9s |

`POST /api/mode {mode}` (from localhost) also writes the mode to every traffic node, so
**surge is real traffic**.

Every node: `g6-nanode-1`, `us-ord`, `linode/ubuntu24.04`, private IP, your
`~/.ssh/id_ed25519.pub` in `authorized_keys`, a random root password that is never
stored or printed, tags `ari-net` + `role:<role>`, label `ari-net-<role>-<n>`,
and ufw (22 open, 80 open on the lb, everything else only from the private network).

### How provisioning works

1. `POST /api/fleet/nodes` creates the Linode (status `provisioning`).
2. Once SSH answers, the controller (`src/fleet/index.js` `bootstrap()`) waits for the
   role's dependencies (app needs db + cache, worker needs db, traffic needs lb),
   reads their generated passwords over SSH (kept in memory only), streams a tarball of
   `fleet-roles/` (+ `target-app/` minus `node_modules`/`data` for app) over SSH, writes
   `/etc/ari-net/env` (0600) and runs `fleet-roles/<role>.sh` (log:
   `/var/log/ari-net-bootstrap.log` on the node). Status is `booting` with a `phase`.
3. The script ends with `/etc/ari-net/ready`; the node becomes `running`. App nodes then
   join the lb upstream. App bootstraps are serialized so only one seeds the db.
4. Scripts are idempotent; a reachable node without the ready marker is re-bootstrapped
   automatically (up to 4 tries), so this survives a telemetry restart.

Delete: `DELETE /api/fleet/nodes/:id` re-fetches the instance, refuses (403) unless it
is tagged `ari-net` with an `ari-net-` label and not on a hard denylist, requires the
exact label in `X-Confirm-Label` (400), removes an app node from the lb upstream, then
destroys it. `linode.deleteInstance()` repeats the tag/label check itself.

Limits: at most **8** ari-net instances; `lb` and `db` are singletons.

**Cost:** each `g6-nanode-1` is about **$5/month** (~$0.0075/hour). The default 7-node
fleet is about $35/month; delete nodes you don't need (`DELETE /api/fleet/nodes/:id`).

### Collector

Every ~2s, one multiplexed SSH round-trip per running node (`ControlMaster`, never blocks
the event loop): `/proc/stat` (CPU from deltas), `/proc/meminfo`, loadavg, `df /`,
`ss -tlnpH` (listening ports + processes), `ss -tinpH state established` (per-socket
`bytes_acked` / `bytes_received`), and on the lb the last 60s of the nginx access log.
Peers are mapped to nodes by private (or public) IP. A socket's direction comes from who
owns the listening port; links are aggregated per (client node, server node, server port).
Intra-fleet sockets are measured on the server side (client side as fallback).
`bytesPerSec` = client→server bytes/s, `bytesPerSecReverse` = server→client, from counter
deltas between samples. The collector's own SSH sessions become one `control` link per node
from the synthetic `controller` node; other inbound traffic from outside the fleet comes
from the synthetic `internet` node. Outbound connections to non-fleet hosts are ignored.

### Fleet API (localhost only: requests from non-loopback addresses get 403)

```
GET /api/fleet
-> { nodes: [{ id, label, role, status, publicIp, privateIp, region, type,
               cpu, memUsed, memTotal, load1,
               processes: [{ name, pid, ports: [number] }],
               deletable, issues: [<issue>],
               phase, error, inUpstream }],        // phase/error/inUpstream are extras
     links: [{ id, source, target, protocol, port, bytesPerSec, bytesPerSecReverse, conns }],
     updatedAt }
   // id = Linode id as string; synthetic nodes "controller" / "internet" (deletable:false)
   // status: provisioning | booting | running | offline | deleting ; cpu 0..1
   // memUsed / memTotal in bytes
   // protocol: http(80) http-app(3000) postgres(5432) redis(6379) ssh(22),
   //           control (controller's SSH, draw dashed), tcp/<port> otherwise
   // link id = "<source>-><target>:<port>"

GET /api/fleet/roles -> [{ role, label, description, addable }]

POST /api/fleet/nodes  body { role }
-> 202 { node }      // appears immediately as "provisioning"
-> 409 cap reached / singleton exists ; 400 unknown role

DELETE /api/fleet/nodes/:id   header  X-Confirm-Label: <exact label>
-> 202 { ok: true }  ; 403 not ari-net ; 400 label mismatch ; 404 unknown id

GET /api/fleet/codemap
-> { roles: { <role>: { root, files: [{ path, label, loc }],
                        edges: [{ from, to, kind: "import" }],
                        ports: [{ dir: "in"|"out", port, file }] } } }

WebSocket /ws  (loopback clients only)
-> { type: "fleet", data: <same shape as GET /api/fleet> }   // after every ~2s sample
```

#### Issues (`nodes[].issues`)

`{ id, severity: critical|high|medium|low, kind, title, detail, since, source }`
(code findings also carry `file`, `line`, `endpoint`). Computed only from observed data;
an issue keeps its id (`<nodeId>:<key>`) and `since` while it holds and disappears when
it stops holding.

| kind | severity | how it is observed | cadence |
|------|----------|--------------------|---------|
| `unreachable` | high | SSH sample failed ≥2 times in a row (after the node first answered) | 2s |
| `cpu-high` | medium | CPU > 90% sustained ≥10s (`/proc/stat`) | 2s |
| `mem-high` | medium | memory > 90% (`MemAvailable`) | 2s |
| `disk-full` | high | `/` > 90% (`df`) | 2s |
| `service-down` | high | role's process not listening: nginx:80, node:3000, postgres:5432, redis-server:6379 | 2s |
| `http-5xx` | high >5% / medium >1% | lb nginx access log, last 60s (≥20 requests) | 2s |
| `public-exposure` | critical | TCP connect from this controller to the node's **public** IP on 3000/5432/6379 succeeds | 60s |
| `ssh-bruteforce` | medium | >20 failed SSH logins in 10 min (`journalctl -u ssh`), top source IPs in `detail` | 60s |
| `security-updates` | low (medium if kernel/openssh) | `apt list --upgradable` filtered to `-security` | 10 min |
| `app-vuln` | per SECURITY-NOTES | static read of the **deployed** AcmePay files on app nodes (`/opt/acmepay`): concatenated SQL, hard-coded secrets, unauthenticated `/api/users/:id`, `err.stack` in responses, MD5 password column. No requests are sent. | 10 min |

#### Code map

`GET /api/fleet/codemap` lists, for each role that runs our own code (`app`, `traffic`,
`worker`), the files actually deployed (repo-relative), the static imports between them
(same parser as `repograph.js`; Python `import` for the scripts), and where network
traffic enters or leaves the code, found by reading the source: `in 3000` is the file
calling `.listen(`, `out 5432` the file creating the `pg.Pool` / `psycopg2.connect`,
`out 6379` the file calling the redis `createClient`, `out 80` the file opening
`http.client.HTTPConnection`. Recomputed on the 30s repo scan. There are no per-file
rates: animate a file from the matching real link on that node (for example the postgres
link's `bytesPerSec` on the file that owns the pg client).

### Agents when a fleet exists

When at least one ari-net instance exists, `/api/agents`, `POST /api/agents/deploy` and
`POST /api/agents/recall` (same shapes as above) run **real jobs** (`src/fleet/agents.js`).
Each agent is one job on one real node (`targetNodeId` = fleet node id):

- `scanner`: public-exposure TCP probe of that node (3000/5432/6379);
- `log-watcher`: SSH auth-log analysis, plus nginx access-log analysis on the lb;
- `verifier`: re-runs the check behind each open issue on the node and reports which still hold;
- `remediator`: **changes nothing**; writes a concrete recommended fix per open issue into
  `note` (for example `ufw deny 5432/tcp on ari-net-db-1`).

`status` moves dispatched → working → reporting → done as steps actually complete;
`progress` = finished steps / (steps + 1). Up to 4 jobs run at once; the rest wait as
`dispatched`. `focus` picks target nodes by role (`"db"`) or label substring.
A `finding` event is emitted only for a real issue and carries
`finding: { id, title, severity, kind, detail, file, line, endpoint, nodeId, nodeLabel }`
(`file`/`line` set for code findings); it is also upserted into `/api/vulns` as `FLEET-<issue id>`.
Reasoning lines come from what jobs did ("scanner on ari-net-db-1: 5432 not reachable from
public, ok") plus a status line from live fleet data every ~4s. With no fleet, the old
simulation runs and its agents/events carry `simulated: true`.

### Files

- `src/fleet/index.js`: controller (Linode reconcile, bootstrap, lb upstream sync, views)
- `src/fleet/linode.js`: Linode API client with the ari-net safety guard
- `src/fleet/ssh.js`: system `ssh` with ControlMaster (`/tmp/arinet-%C`); known_hosts in `telemetry/.fleet/`
- `src/fleet/collector.js`: sampling + link math
- `src/fleet/issues.js`, `src/fleet/agents.js`, `src/fleet/codemap.js`
- `fleet-roles/*.sh`, `traffic.py`, `worker.py`: per-role provisioning, run on the node
