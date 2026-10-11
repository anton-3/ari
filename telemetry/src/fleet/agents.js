// Real agent jobs against the ari-net fleet. Same public shapes as swarm.js
// ({ agents, events }), but every agent is one real check job on one real node:
//   scanner     -> public-exposure TCP probe of 3000/5432/6379 on the node's public IP
//   log-watcher -> SSH auth-log analysis (+ nginx access-log analysis on the lb)
//   verifier    -> re-runs the check behind each open issue on the node
//   remediator  -> proposes concrete fixes for the node's issues (changes nothing)
// Status moves dispatched -> working -> reporting -> done as the job's steps
// actually complete; progress = completed steps / total steps.
import { checkNginxLog } from './issues.js';
import { pushReasoning } from '../reasoning.js';

export const AGENT_TYPES = ['scanner', 'log-watcher', 'verifier', 'remediator'];
const AGENT_LABELS = { scanner: 'Port Scanner', 'log-watcher': 'Log Watcher', verifier: 'Finding Verifier', remediator: 'Remediator' };
const EVENT_MAX = 200;
const AGENT_MAX = 60;
const CONCURRENCY = 4;

// which periodic check re-validates an issue kind
const KIND_CHECK = {
  'public-exposure': 'exposure', 'ssh-bruteforce': 'auth', 'security-updates': 'updates', 'app-vuln': 'code',
};

function recommend(issue, node) {
  const L = node.label;
  switch (issue.kind) {
    case 'public-exposure': {
      const port = issue.id.split(':').pop();
      return `ufw deny ${port}/tcp on ${L} (keep "ufw allow from 192.168.128.0/17"), then re-run the scanner`;
    }
    case 'ssh-bruteforce':
      return `on ${L}: set "PasswordAuthentication no" in /etc/ssh/sshd_config.d/ and reload ssh; add fail2ban (apt install fail2ban) or restrict 22/tcp to the operator IP`;
    case 'security-updates':
      return `on ${L}: apt-get update && apt-get -y upgrade${/linux-|kernel/.test(issue.detail) ? ' then reboot in a maintenance window' : ''}; enable unattended-upgrades`;
    case 'http-5xx':
      return `check app node health behind ${L} (journalctl -u acmepay on each app) and remove failing nodes from the upstream`;
    case 'service-down':
      return `on ${L}: systemctl restart the role service and inspect journalctl for the crash (${issue.title})`;
    case 'cpu-high': return `${L} is CPU-bound: add another node of role ${node.role} or reduce load`;
    case 'mem-high': return `${L} is low on memory: add a node of role ${node.role} or move to g6-standard-1`;
    case 'disk-full': return `on ${L}: clear /var/log (journalctl --vacuum-size=100M) or grow the disk`;
    case 'dependency-missing':
      return `${L} points at a dead ${issue.id.endsWith(':db') ? 'db' : 'cache'}: add a ${issue.id.endsWith(':db') ? 'db' : 'cache'} node; the controller re-wires apps one at a time automatically`;
    case 'unreachable': return `${L} is unreachable over SSH: check the Linode console / Lish and reboot if hung`;
    case 'app-vuln': {
      const fixes = {
        SQLI: 'use the parameterized branch (ACMEPAY_SAFE_SEARCH=1) and delete the concatenated query',
        SECRETS: 'move stripeSecretKey/jwtSecret to environment variables and rotate the keys',
        IDOR: 'require a verified session on GET /api/users/:id and only return the caller\'s own record',
        VERBOSE: 'return a generic error + id and log err.stack server-side only',
        MD5: 'hash passwords with bcrypt/argon2 and migrate on next login',
      };
      return `${issue.file}:${issue.line}: ${fixes[issue.id.split(':').pop()] || 'see SECURITY-NOTES.md'}`;
    }
    default: return `investigate ${issue.title} on ${L}`;
  }
}

export class FleetAgents {
  constructor(fleet, { upsertVuln } = {}) {
    this.fleet = fleet;
    this.upsertVuln = upsertVuln;
    this.agents = [];
    this.events = [];
    this.seq = 0;
    this.agentSeq = 0;
    this.typeCursor = {};
    this.queue = [];
    this.running = 0;
  }

  _event(evt) {
    const full = { ts: new Date().toISOString(), id: `EVT-${++this.seq}`, ...evt };
    this.events.push(full);
    if (this.events.length > EVENT_MAX) this.events.shift();
    return full;
  }

  _say(text) { try { pushReasoning(text); } catch { /* ignore */ } }

  _targets(focus) {
    let nodes = this.fleet.readyNodes();
    if (focus && typeof focus === 'string') {
      const f = focus.toLowerCase();
      const m = nodes.filter((n) => n.role === f || n.label.toLowerCase().includes(f) || n.id === f);
      if (m.length) nodes = m;
    }
    return nodes;
  }

  deploy({ count = 4, type = null, focus = null } = {}) {
    const n = Math.max(1, Math.min(50, parseInt(count, 10) || 4));
    const useType = AGENT_TYPES.includes(type) ? type : null;
    const targets = this._targets(focus);
    if (!targets.length) return [];
    const created = [];
    for (let i = 0; i < n; i++) {
      const t = useType || AGENT_TYPES[i % AGENT_TYPES.length];
      let pool = targets;
      // verifiers/remediators are most useful where there are open issues
      if (t === 'verifier' || t === 'remediator') {
        const withIssues = targets.filter((x) => this.fleet.issues.list(x.id).length);
        if (withIssues.length) pool = withIssues;
      }
      if (t === 'log-watcher' && !focus) {
        const lbFirst = [...targets].sort((a, b) => Number(b.role === 'lb') - Number(a.role === 'lb'));
        pool = lbFirst;
      }
      const cur = this.typeCursor[t] || 0;
      this.typeCursor[t] = cur + 1;
      const node = pool[(focus || t === 'log-watcher' ? i : cur) % pool.length];
      const id = `AGT-${String(++this.agentSeq).padStart(4, '0')}`;
      const agent = { id, type: t, label: `${AGENT_LABELS[t]} ${id}`, status: 'dispatched', targetNodeId: node.id,
        progress: 0, spawnedAt: new Date().toISOString(), note: `Queued for ${node.label}`, _cancel: false };
      this.agents.push(agent);
      created.push(agent);
      this._event({ type: 'deploy', agentId: id, agentType: t, targetNodeId: node.id, text: `${agent.label} dispatched to ${node.label}` });
      this.queue.push(agent);
    }
    this._prune();
    this._pump();
    return created.map((a) => this._pub(a));
  }

  recall() {
    let n = 0;
    for (const a of this.agents) {
      if (a.status === 'done' || a.status === 'idle') continue;
      a._cancel = true;
      if (a.status === 'dispatched') { a.status = 'idle'; a.note = 'Recalled before starting'; }
      else { a.note = 'Recalled; finishing current step'; }
      n++;
    }
    this.queue = this.queue.filter((a) => a.status === 'dispatched');
    this._event({ type: 'recall', text: `Recalled ${n} active agent(s)` });
    return { recalled: n, ...this.list() };
  }

  list() {
    return { agents: this.agents.map((a) => this._pub(a)), events: this.events.slice(-EVENT_MAX) };
  }

  _pub(a) { const { _cancel, ...p } = a; return p; }

  _prune() {
    if (this.agents.length <= AGENT_MAX) return;
    const extra = this.agents.length - AGENT_MAX;
    const drop = new Set(this.agents.filter((a) => a.status === 'done' || a.status === 'idle').slice(0, extra).map((a) => a.id));
    this.agents = this.agents.filter((a) => !drop.has(a.id));
  }

  _pump() {
    while (this.running < CONCURRENCY && this.queue.length) {
      const a = this.queue.shift();
      if (a.status !== 'dispatched') continue;
      this.running++;
      this._run(a).catch((e) => { a.status = 'done'; a.note = `Failed: ${e.message}`; })
        .finally(() => { this.running--; this._pump(); });
    }
  }

  _finding(agent, node, issue) {
    const finding = { id: issue.id, title: issue.title, severity: issue.severity, kind: issue.kind, detail: issue.detail,
      file: issue.file || null, line: issue.line || null, endpoint: issue.endpoint || null, symbolId: issue.symbolId || null,
      nodeId: node.id, nodeLabel: node.label };
    this._event({ type: 'finding', agentId: agent.id, agentType: agent.type, targetNodeId: node.id, finding,
      text: `${agent.label} found on ${node.label}: ${issue.title} (${issue.severity})${issue.file ? ` at ${issue.file}:${issue.line}` : ''}` });
    if (this.upsertVuln) {
      try {
        this.upsertVuln({ id: `FLEET-${issue.id}`, severity: issue.severity, title: `${issue.title} [${node.label}]`,
          project: 'ari-net', endpoint: issue.endpoint || node.label, status: 'open' });
      } catch { /* ignore */ }
    }
  }

  async _run(agent) {
    const node = this.fleet.readyNodes().find((x) => x.id === agent.targetNodeId)
      || (() => { const n = this.fleet.instances.get(agent.targetNodeId); return n ? { id: agent.targetNodeId, ...n } : null; })();
    if (!node) { agent.status = 'done'; agent.progress = 1; agent.note = 'Target node is gone'; return; }
    const steps = this._plan(agent, node);
    agent.status = 'working';
    const results = [];
    for (let i = 0; i < steps.length; i++) {
      if (agent._cancel) break;
      agent.note = steps[i].label;
      const out = await steps[i].run();
      if (out) results.push(out);
      agent.progress = Number(((i + 1) / (steps.length + 1)).toFixed(3)); // last slot = reporting
    }
    agent.status = 'reporting';
    const issues = results.flatMap((r) => r.issues || []);
    for (const iss of issues) this._finding(agent, node, iss);
    const summary = results.map((r) => r.summary).filter(Boolean).join('; ');
    agent.note = agent._cancel ? `Recalled. ${summary}` : (summary || 'No result');
    agent.progress = 1;
    agent.status = 'done';
    this._event({ type: 'done', agentId: agent.id, agentType: agent.type, targetNodeId: node.id, text: `${agent.label} on ${node.label}: ${agent.note}` });
  }

  _plan(agent, node) {
    const F = this.fleet;
    const say = (t) => this._say(t);
    const tag = `${agent.type} on ${node.label}`;
    if (agent.type === 'scanner') {
      return [{
        label: `Probing ${node.publicIp} on 3000/5432/6379`,
        run: async () => {
          let stepped = false;
          const res = await F.runCheck(node, 'exposure', {
            onStep: async ({ port, open: o }) => {
              stepped = true;
              say(`${tag}: ${port} ${o ? 'REACHABLE from public' : 'not reachable from public, ok'}`);
              agent.progress = Math.min(0.9, agent.progress + 0.25);
            },
          });
          if (!res) return { summary: 'exposure check failed' };
          const open = res.filter((r) => r.open).map((r) => r.port);
          if (!stepped) say(`${tag}: joined an in-flight probe; ${open.length ? `open: ${open.join(', ')}` : '3000/5432/6379 not reachable from public, ok'}`);
          const issues = open.map((p) => F.issues.get(node.id, `public-exposure:${p}`)).filter(Boolean);
          return { issues, summary: open.length ? `public ports open: ${open.join(', ')}` : 'no internal ports reachable from the internet' };
        },
      }];
    }
    if (agent.type === 'log-watcher') {
      const steps = [{
        label: 'Reading sshd auth log (last 10 min)',
        run: async () => {
          const r = await F.runCheck(node, 'auth');
          if (!r) return { summary: 'auth log unavailable' };
          const iss = F.issues.get(node.id, 'ssh-bruteforce');
          const top = r.top.slice(0, 3).map(([ip, n]) => `${ip}x${n}`).join(', ');
          say(`${tag}: ${r.count} failed SSH logins in 10 min from ${r.sources} IPs${top ? ` (top ${top})` : ''}${iss ? ' - flagging brute force' : ''}`);
          return { issues: iss ? [iss] : [], summary: `${r.count} failed SSH logins / 10 min` };
        },
      }];
      if (node.role === 'lb') {
        steps.push({
          label: 'Reading nginx access log (last 60s)',
          run: async () => {
            const r = await checkNginxLog(node);
            if (!r) return { summary: 'nginx log unavailable' };
            const c = Object.entries(r.classes).sort().map(([k, v]) => `${k}=${v}`).join(' ');
            say(`${tag}: ${r.total} requests in the last 60s (${c || 'none'})`);
            const iss = F.issues.get(node.id, 'http-5xx');
            return { issues: iss ? [iss] : [], summary: `nginx ${r.total} req/60s ${c}` };
          },
        });
      }
      return steps;
    }
    if (agent.type === 'verifier') {
      const open = F.issues.list(node.id);
      if (!open.length) {
        return [{ label: 'No open issues; re-sampling node', run: async () => {
          say(`${tag}: no open issues to verify, node looks clean`);
          return { summary: 'no open issues' };
        } }];
      }
      const kinds = [...new Set(open.map((i) => KIND_CHECK[i.kind]).filter(Boolean))];
      const steps = kinds.map((k) => ({
        label: `Re-checking ${k}`,
        run: async () => {
          const before = open.filter((i) => KIND_CHECK[i.kind] === k);
          await F.runCheck(node, k);
          const still = before.filter((i) => F.issues.get(node.id, i.id.slice(node.id.length + 1)));
          const cleared = before.length - still.length;
          say(`${tag}: ${still.length} of ${before.length} ${k} issue(s) still hold${cleared ? `, ${cleared} cleared` : ''}`);
          return { issues: still.map((i) => F.issues.get(node.id, i.id.slice(node.id.length + 1))), summary: `${k}: ${still.length} confirmed, ${cleared} cleared` };
        },
      }));
      const live = open.filter((i) => !KIND_CHECK[i.kind]);
      if (live.length) {
        steps.push({ label: 'Confirming live-sampled issues', run: async () => {
          const still = live.filter((i) => F.issues.get(node.id, i.id.slice(node.id.length + 1)));
          say(`${tag}: ${still.length} live issue(s) confirmed by the latest sample`);
          return { issues: still, summary: `live: ${still.length} confirmed` };
        } });
      }
      return steps;
    }
    // remediator: recommendations only, never changes anything
    const open = F.issues.list(node.id);
    if (!open.length) {
      return [{ label: 'Nothing to remediate', run: async () => {
        say(`${tag}: no open issues, nothing to recommend`);
        return { summary: 'no open issues; no changes recommended' };
      } }];
    }
    return open.map((iss) => ({
      label: `Drafting fix for ${iss.title}`,
      run: async () => {
        const fix = recommend(iss, node);
        say(`${tag}: recommend ${fix}`);
        return { summary: `${iss.kind}: ${fix}` };
      },
    }));
  }
}

// Real status line for the reasoning stream, built from current fleet data.
export function fleetStatusLine(fleet, agents) {
  const snap = fleet.snapshot();
  const real = snap.nodes.filter((n) => n.role !== 'controller' && n.role !== 'internet');
  const running = real.filter((n) => n.status === 'running').length;
  const issues = real.flatMap((n) => n.issues.map((i) => ({ ...i, label: n.label })));
  const active = agents.agents.filter((a) => a.status === 'working' || a.status === 'dispatched' || a.status === 'reporting');
  const opts = [];
  const top = [...snap.links].filter((l) => l.protocol !== 'control').sort((a, b) => (b.bytesPerSec + b.bytesPerSecReverse) - (a.bytesPerSec + a.bytesPerSecReverse))[0];
  if (top) {
    const lab = (id) => (snap.nodes.find((n) => n.id === id) || {}).label || id;
    opts.push(`Busiest link: ${lab(top.source)} -> ${lab(top.target)} ${top.protocol} at ${((top.bytesPerSec + top.bytesPerSecReverse) / 1024).toFixed(1)} KB/s over ${top.conns} conn(s).`);
  }
  const hot = [...real].sort((a, b) => b.cpu - a.cpu)[0];
  if (hot) opts.push(`${running}/${real.length} nodes running; hottest is ${hot.label} at ${(hot.cpu * 100).toFixed(0)}% CPU, load ${hot.load1}.`);
  if (issues.length) {
    const sevOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    const worst = issues.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity])[0];
    opts.push(`${issues.length} open issue(s) across the fleet; worst is ${worst.severity}: ${worst.title} on ${worst.label}.`);
  }
  if (active.length) opts.push(`${active.length} agent job(s) in flight against real nodes.`);
  if (!opts.length) return null;
  return opts[Math.floor(Math.random() * opts.length)];
}
