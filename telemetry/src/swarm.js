// In-memory simulation of Ari's helper agent swarm.
// Used only when no ari-net fleet exists (see fleet/agents.js for the real
// agent jobs); agents and events from here carry `simulated: true`.
//
// This is a SIMULATION ONLY. It never touches the network, never runs code and
// never performs any real scanning or attacking. It only mutates in-memory
// state on a ~1s tick and (optionally) records findings into the existing vulns
// store via an injected local upsert function.
//
// Agents prefer to target the files that correspond to the pre-documented
// MyFiat findings (target-app/SECURITY-NOTES.md) so the demo lands on real
// issues; otherwise they spread across the scanned repo graph.

import { getRepoGraph } from './repograph.js';

export const AGENT_TYPES = ['scanner', 'log-watcher', 'verifier', 'remediator'];

const AGENT_LABELS = {
  'scanner': 'Code Scanner',
  'log-watcher': 'Log Watcher',
  'verifier': 'Finding Verifier',
  'remediator': 'Remediator',
};

// Real items from target-app/SECURITY-NOTES.md (the demo "answer key").
// file paths are repo-relative so they line up with repograph node ids.
const FINDINGS = [
  { key: 'SQLI', title: 'SQL injection in transaction search', severity: 'critical',
    file: 'target-app/src/server.js', line: 131, endpoint: 'GET /api/transactions' },
  { key: 'SECRETS', title: 'Hard-coded secrets committed to source', severity: 'high',
    file: 'target-app/src/config.js', line: 20, endpoint: 'ALL' },
  { key: 'IDOR', title: 'Broken access control / IDOR on user profile', severity: 'high',
    file: 'target-app/src/server.js', line: 81, endpoint: 'GET /api/users/:id' },
  { key: 'VERBOSE', title: 'Verbose error messages leak stack traces & SQL', severity: 'medium',
    file: 'target-app/src/server.js', line: 136, endpoint: 'GET /api/transactions' },
  { key: 'MD5', title: 'Weak password hashing (unsalted MD5)', severity: 'medium',
    file: 'target-app/src/db.js', line: 33, endpoint: 'POST /api/login' },
];

const EVENT_MAX = 200;
const AGENT_MAX = 60; // prune oldest done agents beyond this

let agents = [];
let events = [];
let seq = 0;
let findingSeq = 0;
let upsertVulnFn = null;

// Inject the local vuln-store upsert (sim.upsertVuln) so simulated findings can
// optionally be recorded without any real scanning.
export function configureSwarm({ upsertVuln } = {}) {
  if (typeof upsertVuln === 'function') upsertVulnFn = upsertVuln;
}

function now() { return Date.now(); }
function rand(a, b) { return a + Math.random() * (b - a); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function pushEvent(evt) {
  const full = { ts: new Date().toISOString(), id: `EVT-${++seq}`, ...evt, simulated: true };
  events.push(full);
  if (events.length > EVENT_MAX) events.shift();
  return full;
}

// Build a pool of candidate targets. Prefer the documented-finding files that
// actually exist in the scanned graph; fall back to spreading across the graph.
function targetPool(focus) {
  const graph = getRepoGraph();
  const byPath = new Map(graph.nodes.map((n) => [n.path, n]));
  const findingTargets = [];
  for (const f of FINDINGS) {
    const node = byPath.get(f.file);
    if (node) findingTargets.push({ nodeId: node.id, label: node.label, finding: f });
  }
  // Spread targets = every scanned node (with any finding attached).
  const spreadTargets = graph.nodes.map((n) => {
    const f = FINDINGS.find((x) => x.file === n.path) || null;
    return { nodeId: n.id, label: n.label, finding: f };
  });

  let candidates = findingTargets.length ? findingTargets : spreadTargets;
  // If the caller asked to focus on a substring of the path, honor it.
  if (focus && typeof focus === 'string') {
    const f = focus.toLowerCase();
    const focused = spreadTargets.filter((t) => t.nodeId.toLowerCase().includes(f) || t.label.toLowerCase().includes(f));
    if (focused.length) candidates = focused;
  }
  if (!candidates.length) {
    // no graph at all -> fall back to topology-style node ids
    candidates = [
      { nodeId: 'app-1', label: 'MyFiat App 1', finding: null },
      { nodeId: 'app-2', label: 'MyFiat App 2', finding: null },
    ];
  }
  return candidates;
}

export function deployAgents({ count = 4, type = null, focus = null } = {}) {
  const n = Math.max(1, Math.min(50, parseInt(count, 10) || 4));
  const useType = AGENT_TYPES.includes(type) ? type : null;
  const pool = targetPool(focus);
  const created = [];

  for (let i = 0; i < n; i++) {
    const t = useType || AGENT_TYPES[i % AGENT_TYPES.length];
    // Prefer targets that carry a documented finding; weight them higher.
    const withFinding = pool.filter((p) => p.finding);
    const target = (withFinding.length && Math.random() < 0.7)
      ? pick(withFinding)
      : pick(pool);
    const id = `AGT-${String(++seq).padStart(4, '0')}`;
    const agent = {
      id,
      type: t,
      label: `${AGENT_LABELS[t] || t} ${id}`,
      status: 'dispatched',
      targetNodeId: target.nodeId,
      progress: 0,
      spawnedAt: new Date().toISOString(),
      note: `Dispatched to ${target.label}`,
      simulated: true,
      _findingKey: target.finding ? target.finding.key : null,
      _reported: false,
    };
    agents.push(agent);
    created.push(agent);
    pushEvent({ type: 'deploy', agentId: id, agentType: t, targetNodeId: target.nodeId,
      text: `${agent.label} dispatched to ${target.label}` });
  }

  // prune very old done agents if roster is huge
  pruneAgents();
  return created.map(publicAgent);
}

function pruneAgents() {
  if (agents.length <= AGENT_MAX) return;
  const done = agents.filter((a) => a.status === 'done');
  const keep = agents.length - AGENT_MAX;
  if (keep > 0 && done.length) {
    const toRemove = new Set(done.slice(0, Math.min(keep, done.length)).map((a) => a.id));
    agents = agents.filter((a) => !toRemove.has(a.id));
  }
}

function emitFinding(agent) {
  const f = FINDINGS.find((x) => x.key === agent._findingKey);
  if (!f) return;
  const vulnId = `AGT-VULN-${f.key}`;
  findingSeq++;
  pushEvent({
    type: 'finding',
    agentId: agent.id,
    agentType: agent.type,
    targetNodeId: agent.targetNodeId,
    finding: { id: vulnId, title: f.title, severity: f.severity, file: f.file, line: f.line, endpoint: f.endpoint },
    text: `${agent.label} confirmed: ${f.title} (${f.severity}) at ${f.file}:${f.line}`,
  });
  // Optionally record into the existing vulns store via the injected local fn.
  if (upsertVulnFn) {
    try {
      upsertVulnFn({
        id: vulnId,
        severity: f.severity,
        title: f.title,
        project: 'MyFiat',
        endpoint: f.endpoint,
        status: agent.type === 'remediator' ? 'remediated' : 'open',
      });
    } catch { /* never let a sim finding break the tick */ }
  }
}

// Advance the whole swarm one tick (~1s). Returns the public state.
export function step() {
  for (const a of agents) {
    if (a.status === 'done' || a.status === 'idle') continue;
    // progress advances a bit each tick with some jitter
    const delta = rand(0.04, 0.16);
    a.progress = Math.min(1, a.progress + delta);

    if (a.status === 'dispatched' && a.progress > 0.08) {
      a.status = 'working';
      a.note = 'Analyzing target';
    } else if (a.status === 'working' && a.progress >= 0.85) {
      a.status = 'reporting';
      a.note = a._findingKey ? 'Reporting a finding' : 'Reporting all-clear';
      if (a._findingKey && !a._reported) {
        a._reported = true;
        emitFinding(a);
      }
    } else if (a.status === 'reporting' && a.progress >= 1) {
      a.status = 'done';
      a.progress = 1;
      a.note = 'Complete';
      pushEvent({ type: 'done', agentId: a.id, agentType: a.type, targetNodeId: a.targetNodeId,
        text: `${a.label} finished` });
    }
  }
  return listAgents();
}

export function recallAgents() {
  let n = 0;
  for (const a of agents) {
    if (a.status !== 'done') {
      a.status = a.progress > 0.5 ? 'done' : 'idle';
      if (a.status === 'done') a.progress = 1;
      a.note = 'Recalled';
      n++;
    }
  }
  pushEvent({ type: 'recall', text: `Recalled ${n} active agent(s)` });
  return { recalled: n, ...listAgents() };
}

function publicAgent(a) {
  // strip internal underscore-prefixed bookkeeping fields
  const { _findingKey, _reported, ...pub } = a;
  return pub;
}

export function listAgents() {
  return {
    agents: agents.map(publicAgent),
    events: events.slice(-EVENT_MAX),
  };
}
