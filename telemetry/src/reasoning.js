// First-person "Ari" reasoning-line generator.
//
// Produces short status/flavor lines describing what the swarm is doing, based
// on current swarm + metrics state. Keeps a rolling buffer (~50) and notifies
// listeners so server.js can stream each new line over WS.
//
// These lines are FLAVOR / STATUS TEXT ONLY. They are not instructions and are
// never executed. The generator reads state and returns strings.

const BUFFER_MAX = 50;

let lines = [];           // [{ ts, text }]
const listeners = new Set();

export function onReasoning(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function pushReasoning(text) {
  const entry = { ts: new Date().toISOString(), text };
  lines.push(entry);
  if (lines.length > BUFFER_MAX) lines.shift();
  for (const fn of listeners) {
    try { fn(entry); } catch { /* ignore */ }
  }
  return entry;
}

export function getReasoning(limit = BUFFER_MAX) {
  const n = Math.max(1, Math.min(BUFFER_MAX, parseInt(limit, 10) || BUFFER_MAX));
  return lines.slice(-n);
}

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function short(nodeId = '') {
  if (!nodeId) return 'the service';
  const parts = String(nodeId).split('/');
  return parts[parts.length - 1] || nodeId;
}

// Compose the next line from swarm + metrics context. Returns a string (and
// pushes it to the buffer + listeners).
export function generateReasoning({ swarm = {}, metrics = {} } = {}) {
  const agents = Array.isArray(swarm.agents) ? swarm.agents : [];
  const events = Array.isArray(swarm.events) ? swarm.events : [];
  const working = agents.filter((a) => a.status === 'working' || a.status === 'dispatched');
  const reporting = agents.filter((a) => a.status === 'reporting');
  const done = agents.filter((a) => a.status === 'done');
  const recentFinding = [...events].reverse().find((e) => e.type === 'finding');

  const candidates = [];

  // Surge-driven lines take priority some of the time.
  if (metrics.mode === 'surge') {
    candidates.push(
      `Traffic on the edge is climbing fast — holding agents steady and watching for a breakout.`,
      `Request rate just spiked to ~${metrics.rps || 0}/s; I'm correlating the surge against open findings.`,
      `Error rate is up around ${((metrics.errorRate || 0) * 100).toFixed(0)}% under load — keeping log-watchers pinned to auth.`,
    );
  }

  if (recentFinding && recentFinding.finding) {
    const f = recentFinding.finding;
    candidates.push(
      `Verifier confirmed the ${short(f.file)} finding: ${f.title.toLowerCase()}.`,
      `Logging a ${f.severity} finding at ${short(f.file)}:${f.line} and routing it to the board.`,
    );
  }

  if (working.length) {
    const a = pick(working);
    candidates.push(
      `Dispatching ${working.length} agent${working.length === 1 ? '' : 's'} across the codebase — ${short(a.targetNodeId)} is up next.`,
      `${a.label} is digging into ${short(a.targetNodeId)}; I'll hold judgment until it reports.`,
      `${working.length} agent${working.length === 1 ? '' : 's'} still working; progress looks healthy.`,
    );
  }

  if (reporting.length) {
    candidates.push(`${reporting.length} agent${reporting.length === 1 ? '' : 's'} are reporting back now — consolidating their findings.`);
  }

  if (done.length && !working.length && !reporting.length) {
    candidates.push(
      `Sweep complete — ${done.length} agent${done.length === 1 ? '' : 's'} wrapped up. Standing by for the next dispatch.`,
      `The swarm is idle and the surface looks quiet; I'll keep the log-watchers listening.`,
    );
  }

  if (!candidates.length) {
    candidates.push(
      `All quiet. Monitoring ${metrics.rps || 0} req/s with no active agents — ready to spin up a scan on request.`,
      `Baseline traffic, no agents out. I'm watching the AcmePay service and standing ready.`,
    );
  }

  return pushReasoning(pick(candidates)).text;
}
