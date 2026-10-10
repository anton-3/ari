import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer } from 'ws';
import { Simulator } from './simulator.js';

const PORT = parseInt(process.env.PORT || '8090', 10);
// Optional live target: set LIVE_TARGET=http://localhost:8070 to sample AcmePay.
const LIVE_TARGET = process.env.LIVE_TARGET || null;

const sim = new Simulator({ liveTarget: LIVE_TARGET });

const app = express();
app.use(cors());                       // permissive CORS for the dashboard
app.use(express.json({ limit: '256kb' }));

// ---- HTTP API ----
app.get('/api/metrics', (_req, res) => res.json(sim.snapshot()));

app.get('/api/logs', (req, res) => res.json({ logs: sim.getLogs(req.query.limit) }));

app.get('/api/topology', (_req, res) => res.json(sim.topology));

app.get('/api/vulns', (_req, res) => res.json({ vulns: sim.vulns }));

app.post('/api/mode', (req, res) => {
  const { mode, target } = req.body || {};
  if (!sim.setMode(mode, target)) {
    return res.status(400).json({ ok: false, error: 'mode must be "normal" or "surge"' });
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

wss.on('connection', (ws) => {
  // send a snapshot immediately on connect
  try { ws.send(JSON.stringify({ type: 'metrics', data: sim.snapshot() })); } catch { /* ignore */ }
});

// push every log entry as it arrives
sim.onLog((entry) => broadcast({ type: 'log', data: entry }));

// 1s tick: advance sim, push metrics
setInterval(() => {
  const data = sim.tick();
  broadcast({ type: 'metrics', data });
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
