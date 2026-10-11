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
// Optional live target: set LIVE_TARGET=http://localhost:8070 to sample MyFiat.
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

// Live mode uses observed ingress requests. Simulation is an explicit opt-in.
function observedMetrics(m) {
  if (process.env.TELEMETRY_SIM === '1') return { ...m, source: 'simulated' };
  return fleet.requests.snapshot(fleet.incidentView());
}

const app = express();
app.use(cors());                       // permissive CORS for the dashboard
app.use(express.json({ limit: '256kb' }));

// ---- HTTP API ----
app.get('/api/metrics', (_req, res) => res.json(observedMetrics(sim.snapshot())));

app.get('/api/logs', (req, res) => res.json({ logs: process.env.TELEMETRY_SIM === '1' ? sim.getLogs(req.query.limit) : fleet.requests.logs(Math.min(200, Number(req.query.limit) || 200)) }));

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
function localDemoOnly(req, res, next) {
  if (!isLoopback(req.socket.remoteAddress) || !['localhost', '127.0.0.1', '[::1]'].includes(req.hostname)) return res.sendStatus(403);
  try {
    if (req.headers.origin && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(req.headers.origin).hostname)) return res.sendStatus(403);
  } catch { return res.sendStatus(403); }
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
  if (fleet.demo.resetting) return res.status(409).json({ error: 'Demo reset is in progress' });
  try {
    const { ips, incidentId } = req.body || {};
    if (ips != null && !Array.isArray(ips)) return res.status(400).json({ ok: false, error: 'ips must be an array' });
    res.json(await fleet.blockIps(ips, incidentId));
  } catch (e) { sendErr(res, e); }
});

app.post('/api/fleet/activate-web', localOnly, (req, res) => {
  if (fleet.demo.resetting) return res.status(409).json({ error: 'Demo reset is in progress' });
  try { res.status(202).json({ operation: fleet.activateStandby(req.body?.incidentId) }); }
  catch (e) { sendErr(res, e); }
});

app.get('/api/demo/status', localOnly, (_req, res) => res.json({
  resetting: !!fleet.demo.resetting,
  cooldownRemainingMs: Math.max(0, ...fleet.requests.window(180).filter(r => /^203\.0\.113\.(10|11|12|13|14)$/.test(r.ip)).map(r => r.ts + 180000 - Date.now())),
  metrics: fleet.requests.snapshot(fleet.incidentView()), incident: fleet.incidentView(),
  serving: fleet.demo.serving, operations: fleet.demo.operations, notifications: fleet.demo.notifications,
  standby: [...fleet.instances.keys()].map(id => fleet.nodeView(id)).find(n => n.label === 'web-03') || null,
}));

// Browser reset requests use the telemetry origin; orchestration stays in the
// backend process that owns the durable voice/PR jobs.
app.all('/api/demo/reset-run', localDemoOnly, async (req, res) => {
  try {
    if (!['GET', 'POST'].includes(req.method)) return res.sendStatus(405);
    const response = await fetch(`${process.env.ARI_BACKEND_URL || 'http://localhost:8080'}/demo/reset-run`, {
      method: req.method, ...(req.method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: '{}' } : {}), signal: AbortSignal.timeout(5000),
    });
    res.status(response.status).json(await response.json());
  } catch (e) { sendErr(res, e); }
});

app.post('/api/demo/maintenance', localDemoOnly, async (req, res) => {
  if (typeof req.body?.resetting !== 'boolean') return res.sendStatus(400);
  fleet.demo.resetting = req.body.resetting;
  fleet.saveDemo();
  const deadline = Date.now() + 20000;
  while (fleet.incident._busy && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  if (fleet.incident._busy) return res.status(409).json({ error: 'Incident detector is still finishing; retry reset' });
  res.json({ ok: true });
});

app.post('/api/demo/standby', localOnly, async (_req, res) => {
  try {
    const existing = fleet.nodesOfRole('app').find(n => n.label === 'web-03');
    const node = existing ? fleet.nodeView(existing.id) : await fleet.createNode('app', { standby: true });
    res.status(202).json({ node });
  } catch (e) { sendErr(res, e); }
});

app.post('/api/demo/reset', localDemoOnly, async (_req, res) => {
  try {
    if (Object.values(fleet.demo.operations).some(o => !['ready', 'failed'].includes(o.status))) throw Object.assign(new Error('activation is still running'), { status: 409 });
    const ips = [...new Set(fleet.demo.incidents.flatMap(i => i.attackerIps.map(a => a.ip)))];
    if (ips.length) await fleet.unblockIps({ ips });
    for (const node of fleet.nodesOfRole('app').filter(n => n.label === 'web-03')) fleet.demo.serving[node.id] = 'standby';
    fleet.demo.operations = {}; fleet.demo.notifications = {}; fleet.demo.incidents = [];
    Object.assign(fleet.incident, { active: false, id: null, since: null, clearedAt: null, attackerIps: [], _trip: 0, _clear: 0, _baseline: 1 });
    const lb = fleet.lbNode();
    if (lb) fleet.issues.set(lb.id, 'ddos', null);
    fleet.saveDemo();
    await fleet.syncUpstream(); fleet.publish();
    res.json({ ok: true });
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
app.post('/api/reasoning', localOnly, (req, res) => {
  if (typeof req.body?.text !== 'string' || req.body.text.length > 1000) return res.sendStatus(400);
  res.json(pushReasoning(req.body.text));
});

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
  try { ws.send(JSON.stringify({ type: 'metrics', data: observedMetrics(sim.snapshot()) })); } catch { /* ignore */ }
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
sim.onLog((entry) => { if (process.env.TELEMETRY_SIM === '1') broadcast({ type: 'log', data: entry }); });
fleet.onRequests = (fresh) => {
  // Batches avoid hundreds of React updates per second during the real burst.
  const ids = new Set(fresh.map(r => r.id));
  const logs = fleet.requests.logs(200).filter(r => ids.has(r.id));
  if (logs.length) broadcast({ type: 'logs', data: { logs } });
};

// push each new reasoning line as it appears
onReasoning((entry) => broadcast({ type: 'reasoning', data: entry }));

// 1s tick: advance sim + swarm, push metrics + agents. Every other tick, emit
// a fresh reasoning line (so ~1 line / 2s) based on current state.
let tickCount = 0;
setInterval(() => {
  const data = observedMetrics(sim.tick());
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
  console.log(`[ari-telemetry] WS at ws://localhost:${PORT}/ws | ${process.env.TELEMETRY_SIM === '1' ? 'explicit simulation' : 'observed nginx request metrics'}`);
});
