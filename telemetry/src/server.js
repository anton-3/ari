import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer } from 'ws';
import { Simulator } from './simulator.js';
import { getRepoGraph, scanRepo } from './repograph.js';
import { deployAgents, recallAgents, listAgents, step as swarmStep, configureSwarm } from './swarm.js';
import { generateReasoning, getReasoning, onReasoning, pushReasoning } from './reasoning.js';
import { Fleet, isLoopback } from './fleet/index.js';
import { FleetAgents, fleetStatusLine } from './fleet/agents.js';
import { scanCodemap, codemapView } from './fleet/codemap.js';

const PORT = parseInt(process.env.PORT || '8090', 10);
// Optional live target: set LIVE_TARGET=http://localhost:8070 to sample AcmePay.
const LIVE_TARGET = process.env.LIVE_TARGET || null;

const sim = new Simulator({ liveTarget: LIVE_TARGET });

// Simulated agent swarm records its findings into the existing vulns store via
// this local upsert (no real scanning / network).
configureSwarm({ upsertVuln: (v) => sim.upsertVuln(v) });

// Scan the repo at startup, then refresh every ~30s.
scanRepo();
scanCodemap();
setInterval(() => {
  try { scanRepo(); } catch { /* ignore */ }
  try { scanCodemap(); } catch { /* ignore */ }
}, 30000);

// Real ari-net fleet (Linode) + real agent jobs against it. When no fleet
// exists the simulated swarm below is used instead.
const fleet = new Fleet();
const fleetAgents = new FleetAgents(fleet, { upsertVuln: (v) => sim.upsertVuln(v) });
fleet.start();

// Override the simulator's synthetic activeUsers with the REAL count of
// distinct client IPs the lb logged over the rolling window, when available.
function withRealActiveUsers(m) {
  if (!m || fleet.activeUsers == null) return m;
  return { ...m, activeUsers: fleet.activeUsers };
}

const app = express();
app.use(cors());                       // permissive CORS for the dashboard
app.use(express.json({ limit: '256kb' }));

// ---- HTTP API ----
app.get('/api/metrics', (_req, res) => res.json(withRealActiveUsers(sim.snapshot())));

app.get('/api/logs', (req, res) => res.json({ logs: sim.getLogs(req.query.limit) }));

app.get('/api/topology', (_req, res) => res.json(sim.topology));

app.get('/api/vulns', (_req, res) => res.json({ vulns: sim.vulns }));

app.post('/api/mode', (req, res) => {
  const { mode, target } = req.body || {};
  if (!sim.setMode(mode, target)) {
    return res.status(400).json({ ok: false, error: 'mode must be "normal" or "surge"' });
  }
  // Real traffic: switch the fleet's load generators (localhost callers only).
  if (fleet.active() && isLoopback(req.socket.remoteAddress)) {
    fleet.setTrafficMode(sim.mode).catch(() => {});
  }
  res.json({ ok: true, mode: sim.mode });
});

// Add or update a vuln (Ari reports findings)
app.post('/api/vulns', (req, res) => {
  const v = sim.upsertVuln(req.body);
  if (!v) return res.status(400).json({ ok: false, error: 'invalid vuln body' });
  res.json({ ok: true, vuln: v });
});

// Update a vuln's status (e.g. mark remediated)
app.patch('/api/vulns/:id', (req, res) => {
  const { status } = req.body || {};
  const v = sim.setVulnStatus(req.params.id, status);
  if (!v) return res.status(404).json({ ok: false, error: 'vuln not found' });
  res.json({ ok: true, vuln: v });
});

// ---- Repo graph + agent swarm + reasoning (simulation) ----
app.get('/api/repograph', (_req, res) => res.json(getRepoGraph()));

// Agents: real fleet jobs when an ari-net fleet exists, else the simulation.
const agentsState = () => (fleet.active() ? fleetAgents.list() : listAgents());

app.get('/api/agents', (_req, res) => res.json(agentsState()));

app.post('/api/agents/deploy', (req, res) => {
  const { count, type, focus } = req.body || {};
  const created = fleet.active()
    ? fleetAgents.deploy({ count, type, focus })
    : deployAgents({ count, type, focus });
  res.json({ ok: true, agents: created });
});

app.post('/api/agents/recall', (_req, res) => {
  res.json({ ok: true, ...(fleet.active() ? fleetAgents.recall() : recallAgents()) });
});

// ---- ari-net fleet (REAL infrastructure; localhost only) ----
function localOnly(req, res, next) {
  if (!isLoopback(req.socket.remoteAddress)) return res.status(403).json({ ok: false, error: 'fleet API is localhost-only' });
  next();
}
const sendErr = (res, e) => res.status(e.status || 500).json({ ok: false, error: e.message });

app.get('/api/fleet', localOnly, (_req, res) => res.json(fleet.snapshot()));
app.get('/api/fleet/roles', localOnly, (_req, res) => res.json(fleet.rolesView()));
app.get('/api/fleet/codemap', localOnly, (_req, res) => res.json(codemapView()));

app.post('/api/fleet/nodes', localOnly, async (req, res) => {
  try {
    const node = await fleet.createNode(String((req.body || {}).role || ''));
    res.status(202).json({ node });
  } catch (e) { sendErr(res, e); }
});

app.get('/api/fleet/incident', localOnly, (_req, res) => res.json(fleet.incidentView()));

app.post('/api/fleet/block-ips', localOnly, async (req, res) => {
  try {
    const { ips } = req.body || {};
    if (!Array.isArray(ips)) return res.status(400).json({ ok: false, error: 'body must be { ips: [...] }' });
    res.json(await fleet.blockIps(ips));
  } catch (e) { sendErr(res, e); }
});

app.post('/api/fleet/unblock-ips', localOnly, async (req, res) => {
  try {
    const { ips, all } = req.body || {};
    if (!all && !Array.isArray(ips)) return res.status(400).json({ ok: false, error: 'body must be { ips: [...] } or { all: true }' });
    res.json(await fleet.unblockIps({ ips, all }));
  } catch (e) { sendErr(res, e); }
});

app.delete('/api/fleet/nodes/:id', localOnly, async (req, res) => {
  try {
    res.status(202).json(await fleet.deleteNode(req.params.id, req.get('X-Confirm-Label')));
  } catch (e) { sendErr(res, e); }
});

app.get('/api/reasoning', (req, res) => res.json({ lines: getReasoning(req.query.limit) }));

app.get('/health', (_req, res) => res.json({ ok: true, mode: sim.mode, uptimeMs: Date.now() - sim.startTime }));

// ---- WebSocket ----
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(obj) {
  const str = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      try { client.send(str); } catch { /* ignore */ }
    }
  }
}

wss.on('connection', (ws, req) => {
  ws.isLocal = isLoopback(req.socket.remoteAddress);
  // send a snapshot immediately on connect
  try { ws.send(JSON.stringify({ type: 'metrics', data: withRealActiveUsers(sim.snapshot()) })); } catch { /* ignore */ }
  try { ws.send(JSON.stringify({ type: 'agents', data: agentsState() })); } catch { /* ignore */ }
  if (ws.isLocal && fleet.active()) {
    try { ws.send(JSON.stringify({ type: 'fleet', data: fleet.snapshot() })); } catch { /* ignore */ }
  }
});

// fleet frames (~every 2s, after each collector pass) go to localhost clients only
fleet.onUpdate((data) => {
  const str = JSON.stringify({ type: 'fleet', data });
  for (const client of wss.clients) {
    if (client.readyState === 1 && client.isLocal) {
      try { client.send(str); } catch { /* ignore */ }
    }
  }
});

// push every log entry as it arrives
sim.onLog((entry) => broadcast({ type: 'log', data: entry }));

// push each new reasoning line as it appears
onReasoning((entry) => broadcast({ type: 'reasoning', data: entry }));

// 1s tick: advance sim + swarm, push metrics + agents. Every other tick, emit
// a fresh reasoning line (so ~1 line / 2s) based on current state.
let tickCount = 0;
setInterval(() => {
  const data = withRealActiveUsers(sim.tick());
  broadcast({ type: 'metrics', data });

  const real = fleet.active();
  const swarm = real ? fleetAgents.list() : swarmStep();
  broadcast({ type: 'agents', data: swarm });

  tickCount++;
  if (real) {
    // Real lines come from agent jobs as they run; add a fleet status line
    // built from live data every ~4s.
    if (tickCount % 4 === 0) {
      const line = fleetStatusLine(fleet, swarm);
      if (line) pushReasoning(line);
    }
  } else if (tickCount % 2 === 0) {
    generateReasoning({ swarm, metrics: data }); // pushReasoning -> onReasoning -> WS
  }
}, 1000);

// optional benign live sampling every 5s
if (LIVE_TARGET) {
  setInterval(() => sim.sampleLiveTarget(), 5000);
  sim.sampleLiveTarget();
}

server.listen(PORT, () => {
  console.log(`[ari-telemetry] listening on http://localhost:${PORT}`);
  console.log(`[ari-telemetry] WS at ws://localhost:${PORT}/ws | mode=${sim.mode}` + (LIVE_TARGET ? ` | live target=${LIVE_TARGET}` : ' | synthetic mode'));
});
