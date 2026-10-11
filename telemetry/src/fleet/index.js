// ari-net fleet controller: a real fleet of Linode nanodes running MyFiat
// (lb -> app x N -> db + cache, plus traffic / worker), provisioned over SSH,
// sampled every ~2s over SSH, and exposed as a live topology.
//
// SAFETY: only instances tagged "ari-net" (label "ari-net-*") are ever listed,
// SSHed into, or deleted. See linode.js (assertAriNet / denylist).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as linode from './linode.js';
import { sshRun, sshPipeTar, forgetHost, closeMaster, PUBKEY_PATH } from './ssh.js';
import { sampleNode, cpuUtil, processesOf, LinkTracker } from './collector.js';
import { IssueStore, fastChecks, checkExposure, checkAuthLog, checkUpdates, checkCode } from './issues.js';
import { ingestNginx } from './codemap.js';
import { refreshInventory } from './inventory.js';
import { analyzeWindow, blocklistContent, incidentConfContent, isPlausibleSourceIp, INCIDENT_CONF, BLOCKLIST_FILE } from './incident.js';
import { RequestTelemetry } from './requests.js';
import { pushReasoning } from '../reasoning.js';
import crypto from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TELEMETRY_DIR = path.resolve(HERE, '..', '..');
const REPO_ROOT = path.resolve(TELEMETRY_DIR, '..');

export const ROLES = [
  { role: 'lb', label: 'Load balancer', description: 'nginx on :80, proxies to every app node over the private network', singleton: true },
  { role: 'app', label: 'MyFiat app', description: 'MyFiat payments API (Node 20) on :3000, joins the lb automatically', singleton: false },
  { role: 'db', label: 'PostgreSQL', description: 'PostgreSQL on the private interface (:5432), MyFiat schema + seed', singleton: true },
  { role: 'cache', label: 'Redis cache', description: 'Redis on the private interface (:6379); request counters + merchants cache', singleton: false },
  { role: 'traffic', label: 'Traffic generator', description: 'Steady realistic request mix to the lb (normal / surge)', singleton: false },
  { role: 'worker', label: 'Settlement worker', description: 'Background job that polls Postgres every few seconds', singleton: false },
];
const ROLE_SET = new Set(ROLES.map((r) => r.role));

const SAMPLE_MS = 2000;
const REFRESH_MS = 10000;
const SLOW = { exposure: 60e3, auth: 60e3, updates: 600e3, code: 600e3 };
// DDoS detector thresholds (attacker req/s; see incident.js for per-IP floor/window).
const TRIP_ABS_ = 20, TRIP_MULT_ = 3, CLEAR_ABS_ = 8, TRIP_DEBOUNCE_ = 2, CLEAR_DEBOUNCE_ = 3;
// Rolling window (seconds) for the real distinct-client-IP 'active users' count.


function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function isLoopback(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

// simple async mutex
function makeLock() {
  let tail = Promise.resolve();
  return (fn) => { const run = tail.then(fn, fn); tail = run.catch(() => {}); return run; };
}

export class Fleet {
  constructor({ log = console.log, stateFile = path.join(TELEMETRY_DIR, '.fleet', 'demo-state.json'), ssh = sshRun } = {}) {
    this.log = log;
    this.ssh = ssh;
    this.instances = new Map(); // id -> { inst, role, label, publicIp, privateIp }
    this.st = new Map();        // id -> runtime state
    this.links = [];
    this.updatedAt = null;
    this.issues = new IssueStore();
    this.tracker = new LinkTracker();
    this.mode = 'normal';
    this.upstreamIds = [];
    this.pendingCreates = 0;
    this.deleted = new Map();   // id -> ts; instances we destroyed (ignored if the API still lists them briefly)
    this.depsLock = makeLock();
    this.createLock = makeLock();
    this.appLock = makeLock();
    this.upstreamLock = makeLock();
    this.listeners = new Set();
    this.controllerIp = null;
    this._cpuPrev = null;
    this.controllerCpu = null;
    this.activeUsers = null;   // real distinct client IPs over the window (null = unknown)
    this.activeUsersAt = null;
    this.incident = { active: false, since: null, reqPerSec: 0, baselineRps: 3, attackerIps: [],
      blockedIps: [], _baseline: 3, _trip: 0, _clear: 0, _confAt: 0, _busy: false };
    this.incidentLock = makeLock();
    this.requests = new RequestTelemetry();
    this.requestCursor = null;
    this.stateFile = stateFile;
    this.demo = { serving: {}, operations: {}, incidents: [], notifications: {} };
    try { Object.assign(this.demo, JSON.parse(fs.readFileSync(stateFile, 'utf8'))); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const latest = this.demo.incidents.at(-1);
    if (latest) Object.assign(this.incident, latest, { active: false });
    for (const operation of Object.values(this.demo.operations)) {
      if (!['ready', 'failed'].includes(operation.status)) {
        operation.status = 'failed'; operation.error = 'Controller restarted during activation; reset before retrying.';
        this.demo.serving[operation.nodeId] = 'failed';
      }
    }
    this.onRequests = () => {};
    this.enabled = linode.hasToken() && fs.existsSync(PUBKEY_PATH);
    this.pubkey = this.enabled ? fs.readFileSync(PUBKEY_PATH, 'utf8').trim() : null;
  }

  // ---------- lifecycle ----------
  start() {
    if (!this.enabled) { this.log('[fleet] disabled (no LINODE_API_TOKEN or ~/.ssh/id_ed25519.pub)'); return; }
    this.refresh().catch((e) => this.log('[fleet] refresh failed:', e.message));
    setInterval(() => this.refresh().catch((e) => this.log('[fleet] refresh failed:', e.message)), REFRESH_MS);
    setInterval(() => this.collect().catch((e) => this.log('[fleet] collect failed:', e.message)), SAMPLE_MS);
    setInterval(() => this.slowChecks(), 5000);
    setInterval(() => this.syncUpstream().catch(() => {}), 20000);
    setInterval(() => this.syncDeps().catch((e) => this.log('[fleet] dep sync failed:', e.message)), 10000);
    setInterval(() => this.pollRoutes().catch(() => {}), 5000);
    setInterval(() => this.pollRequests().catch((e) => this.log('[fleet] request poll failed:', e.message)), 1000);
    // What is inside the db / cache / lb nodes (tables, keys, nginx config) for the map's drill-down.
    setTimeout(() => refreshInventory(this).catch(() => {}), 8000);
    setInterval(() => refreshInventory(this).catch(() => {}), 60000);
  }

  saveDemo() {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.writeFileSync(`${this.stateFile}.tmp`, JSON.stringify(this.demo), { mode: 0o600 });
    fs.renameSync(`${this.stateFile}.tmp`, this.stateFile);
  }

  servingState(id) {
    return this.demo.serving[id] || (this.instances.get(id)?.inst.tags?.includes('ari-standby') ? 'standby' : 'serving');
  }

  publish() { for (const fn of this.listeners) fn(this.snapshot()); }

  async pollRequests() {
    if (this._requestsBusy) return;
    const lb = this.lbNode();
    if (!lb) return;
    this._requestsBusy = true;
    try {
      const arg = this.requestCursor ? ' ' + Buffer.from(JSON.stringify(this.requestCursor)).toString('base64url') : '';
      const r = await this.ssh(lb.publicIp, `python3 /opt/ari-net/request-reader.py${arg}`, { timeoutMs: 4000 });
      if (r.code !== 0) throw new Error('request reader unavailable; run demo prepare');
      const batch = JSON.parse(r.stdout);
      const fresh = this.requests.ingest(batch);
      this.requestCursor = batch.cursor;
      if (!batch.gap) {
        await this.pollIncident();
        this.onRequests(fresh);
        await this.notifyIncident();
      }
    } finally { this._requestsBusy = false; }
  }

  async notifyIncident() {
    const inc = this.incidentView();
    if (!inc.active || !inc.id || process.env.DEMO_CALLS_ENABLED === '0' || this.demo.notifications[inc.id]) return;
    this.demo.notifications[inc.id] = { status: 'dispatching', at: Date.now() };
    this.saveDemo();
    pushReasoning('Detected a request flood. Calling the on-call engineer for permission to block the sources.');
    try {
      const res = await fetch(`${process.env.ARI_BACKEND_URL || 'http://localhost:8080'}/incident`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(inc), signal: AbortSignal.timeout(8000),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `backend ${res.status}`);
      this.demo.notifications[inc.id] = { status: 'placed', callSid: data.callSid, at: Date.now() };
      pushReasoning('Incident call placed. Waiting for approval before changing the blocklist.');
    } catch (e) {
      this.demo.notifications[inc.id] = { status: 'failed', error: e.message, at: Date.now() };
      pushReasoning(`Incident call failed: ${e.message}. No automatic duplicate call will be placed.`);
    }
    this.saveDemo();
  }

  active() { return this.instances.size > 0; }
  onUpdate(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  _state(id) {
    if (!this.st.has(id)) {
      this.st.set(id, { sample: null, prevCpuTimes: null, cpu: null, failStreak: 0, lastError: null, inflight: false,
        ready: null, deleting: false, phase: null, error: null,
        boot: { running: false, attempts: 0, lastAt: 0 }, slow: {}, slowBusy: {} });
    }
    return this.st.get(id);
  }

  async refresh() {
    const list = await linode.listFleet(); // ari-net only
    const seen = new Set();
    for (const [id, ts] of this.deleted) if (Date.now() - ts > 15 * 60e3) this.deleted.delete(id);
    for (const inst of list) {
      const id = String(inst.id);
      if (this.deleted.has(id)) continue;
      seen.add(id);
      this.instances.set(id, { inst, role: linode.roleOf(inst), label: inst.label, ...linode.ipsOf(inst) });
      this._state(id);
    }
    for (const id of [...this.instances.keys()]) {
      if (!seen.has(id)) this._dropNode(id);
    }
  }

  _dropNode(id) {
    const n = this.instances.get(id);
    this.instances.delete(id);
    this.st.delete(id);
    this.issues.drop(id);
    this.tracker.forget(id);
    if (n?.publicIp) { closeMaster(n.publicIp); forgetHost(n.publicIp); }
  }

  // ---------- collection ----------
  async collect() {
    const targets = [...this.instances.entries()].filter(([id, n]) => {
      const st = this._state(id);
      return n.inst.status === 'running' && n.publicIp && !st.deleting && !st.inflight;
    });
    const fresh = new Map();
    await Promise.all(targets.map(async ([id, n]) => {
      const st = this._state(id);
      st.inflight = true;
      try {
        const r = await sampleNode(n.publicIp);
        if (r.ok) {
          const s = r.sample;
          st.cpu = cpuUtil(st.prevCpuTimes, s.cpuTimes) ?? st.cpu;
          st.prevCpuTimes = s.cpuTimes;
          st.sample = s;
          st.failStreak = 0;
          st.everOk = true;
          st.lastError = null;
          st.ready = s.ready;
          if (s.ready && !st.boot.running) { st.error = null; st.phase = null; }
          if (s.controllerIp) this.controllerIp = s.controllerIp;
          fresh.set(id, { sample: s, at: r.at });
        } else {
          st.failStreak++;
          st.lastError = r.error;
        }
      } finally { st.inflight = false; }
    }));

    const nodes = [...this.instances.entries()].map(([id, n]) => ({ id, privateIp: n.privateIp, publicIp: n.publicIp }));
    const links = this.tracker.compute(nodes, fresh);
    // Keep links for nodes that weren't freshly sampled this round (in flight) from the last round.
    const freshIds = new Set(fresh.keys());
    const carried = this.links.filter((l) => !freshIds.has(l.target) && !freshIds.has(l.source)
      && this.instances.has(l.target) && (this.instances.has(l.source) || l.source === 'controller' || l.source === 'internet')
      && !links.some((x) => x.id === l.id));
    this.links = [...links, ...carried];

    for (const [id, n] of this.instances) {
      const st = this._state(id);
      if (n.inst.status !== 'running' || st.deleting) { this.issues.set(id, 'unreachable', null); continue; }
      if (st.phase === 'creating instance') st.phase = 'waiting for ssh';
      // keep traffic generators on the current mode (e.g. after a reboot)
      if (n.role === 'traffic' && fresh.has(id) && st.ready && st.sample.trafficMode && st.sample.trafficMode !== this.mode
          && !st.modeSyncing) {
        st.modeSyncing = true;
        this.ssh(n.publicIp, `echo ${this.mode} > /etc/ari-net/traffic.mode`, { timeoutMs: 10000 })
          .finally(() => { st.modeSyncing = false; });
      }
      fastChecks(this.issues, { id, role: n.role, cpu: st.cpu }, st);
      if (n.role === 'app') this._depIssues(id, st);
      // (Re)bootstrap nodes that are reachable but not configured yet. This also
      // resumes after a telemetry restart, since the scripts are idempotent.
      if (fresh.has(id) && !st.ready && !st.boot.running && st.boot.attempts < 4
          && Date.now() - st.boot.lastAt > 45000) {
        this.bootstrap(id).catch(() => {});
      }
    }
    this._sampleController();
    this.updatedAt = new Date().toISOString();
    const snap = this.snapshot();
    for (const fn of this.listeners) { try { fn(snap); } catch { /* ignore */ } }
  }

  _sampleController() {
    const cpus = os.cpus();
    const t = cpus.reduce((a, c) => { const x = c.times; a.idle += x.idle; a.total += x.user + x.nice + x.sys + x.idle + x.irq; return a; }, { idle: 0, total: 0 });
    if (this._cpuPrev) {
      const dt = t.total - this._cpuPrev.total;
      if (dt > 0) this.controllerCpu = Math.max(0, Math.min(1, 1 - (t.idle - this._cpuPrev.idle) / dt));
    }
    this._cpuPrev = t;
  }

  // ---------- slow checks (also used by agents) ----------
  readyNodes() {
    return [...this.instances.entries()]
      .filter(([id, n]) => { const st = this._state(id); return st.ready && !st.deleting && st.failStreak === 0 && n.inst.status === 'running'; })
      .map(([id, n]) => ({ id, ...n }));
  }

  async runCheck(node, kind, opts = {}) {
    const st = this._state(node.id);
    // a check already in flight for this node is shared rather than repeated
    if (st.slowBusy[kind]) return st.slowBusy[kind];
    const p = (async () => {
      let res = null;
      if (kind === 'exposure') res = await checkExposure(this.issues, node, opts.onStep);
      else if (kind === 'auth') res = await checkAuthLog(this.issues, node);
      else if (kind === 'updates') res = await checkUpdates(this.issues, node);
      else if (kind === 'code') res = await checkCode(this.issues, node);
      st.slow[kind] = Date.now();
      return res;
    })();
    st.slowBusy[kind] = p;
    try { return await p; } finally { st.slowBusy[kind] = null; }
  }

  slowChecks() {
    for (const node of this.readyNodes()) {
      const st = this._state(node.id);
      for (const [kind, every] of Object.entries(SLOW)) {
        if (kind === 'code' && node.role !== 'app') continue;
        if (Date.now() - (st.slow[kind] || 0) < every) continue;
        st.slow[kind] = Date.now(); // claim the slot even if it fails
        this.runCheck(node, kind).catch(() => {});
      }
    }
  }

  // ---------- provisioning ----------
  nodesOfRole(role) {
    return [...this.instances.entries()].filter(([, n]) => n.role === role).map(([id, n]) => ({ id, ...n }))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  }

  async waitReady(role, id, maxMs = 25 * 60e3) {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      const n = this.nodesOfRole(role).find((x) => { const st = this._state(x.id); return st.ready && !st.deleting; });
      if (n) return n;
      this._state(id).phase = `waiting for ${role}`;
      await sleep(5000);
      if (!this.instances.has(id) || this._state(id).deleting) throw new Error('node removed');
    }
    throw new Error(`no ready ${role} node`);
  }

  async readSecret(node, file) {
    const r = await this.ssh(node.publicIp, `cat ${file}`, { timeoutMs: 10000 });
    const v = r.stdout.trim();
    if (r.code !== 0 || !/^[0-9a-f]{32,128}$/.test(v)) throw new Error(`could not read ${path.basename(file)} from ${node.label}`);
    return v;
  }

  async bootstrap(id) {
    const n = this.instances.get(id);
    const st = this._state(id);
    if (!n || st.boot.running) return;
    st.boot.running = true;
    st.boot.attempts++;
    st.boot.lastAt = Date.now();
    st.error = null;
    const ip = n.publicIp;
    try {
      const env = { ROLE: n.role, LABEL: n.label, PRIV_IP: n.privateIp, MODE: this.mode };
      if (n.role === 'app' || n.role === 'worker') {
        const db = await this.waitReady('db', id);
        env.DB_HOST = db.privateIp;
        env.DB_PASS = await this.readSecret(db, '/etc/ari-net/db.pass');
        env.DB_USER = 'myfiat'; env.DB_NAME = 'myfiat';
        // Existing fleets may predate the MyFiat rename. Reuse the serving
        // pool's actual database instead of assuming a new database/role exists.
        const reference = this.readyNodes().find(a => a.role === 'app' && a.id !== id);
        if (reference) {
          const config = await this.ssh(reference.publicIp, 'cat /etc/ari-net/app.env');
          const value = config.stdout.match(/^DATABASE_URL=(.*)$/m)?.[1];
          if (!value || config.code !== 0) throw new Error('could not read serving database configuration');
          const url = new URL(value.replace(/^['"]|['"]$/g, ''));
          if (url.hostname !== db.privateIp) throw new Error('serving database does not match owned database node');
          env.DB_USER = decodeURIComponent(url.username);
          env.DB_NAME = decodeURIComponent(url.pathname.slice(1));
          env.DB_PASS = decodeURIComponent(url.password);
        }
        if (!/^[a-zA-Z0-9_]+$/.test(env.DB_USER) || !/^[a-zA-Z0-9_]+$/.test(env.DB_NAME)) throw new Error('unsupported database identifier');
        // The deployed database uses per-node pg_hba entries. Admit this owned
        // node before schema/application startup instead of waiting for a failure.
        if (!/^192\.168\.\d+\.\d+$/.test(n.privateIp)) throw new Error('missing private application IP');
        const rule = `host ${env.DB_NAME} ${env.DB_USER} ${n.privateIp}/32 scram-sha-256`;
        const admitted = await this.ssh(db.publicIp,
          `set -eu; hba=$(sudo -u postgres psql -Atc 'SHOW hba_file'); grep -Fqx '${rule}' "$hba" || printf '\\n${rule}\\n' >> "$hba"; sudo -u postgres psql -Atc 'SELECT pg_reload_conf()'`, { timeoutMs: 10000 });
        if (admitted.code !== 0) throw new Error('could not admit application node to PostgreSQL');
      }
      if (n.role === 'app') {
        // The cache is optional: wait for one only if a cache node exists;
        // otherwise come up without Redis and get wired later by syncDeps().
        const cache = this.nodesOfRole('cache').some((c) => !this._state(c.id).deleting)
          ? await this.waitReady('cache', id).catch(() => null) : null;
        env.REDIS_HOST = cache ? cache.privateIp : '';
        env.REDIS_PASS = cache ? await this.readSecret(cache, '/etc/ari-net/redis.pass') : '';
      }
      if (n.role === 'traffic') env.LB_HOST = (await this.waitReady('lb', id)).privateIp;

      st.phase = 'uploading bundle';
      const tarArgs = ['-czf', '-', '--exclude', 'node_modules', '--exclude', 'target-app/data', '--exclude', '.DS_Store',
        '-C', TELEMETRY_DIR, 'fleet-roles'];
      if (n.role === 'app') tarArgs.push('-C', REPO_ROOT, 'target-app');
      const up = await sshPipeTar(ip, tarArgs,
        'rm -rf /opt/ari-net/bundle && mkdir -p /opt/ari-net/bundle && tar -xzf - -C /opt/ari-net/bundle 2>/dev/null',
        { timeoutMs: 180000 });
      if (up.code !== 0) throw new Error(`upload failed: ${up.stderr.trim().split('\n').pop()}`);

      st.phase = 'writing config';
      const envText = Object.entries(env).map(([k, v]) => `${k}='${String(v ?? '').replace(/'/g, '')}'`).join('\n') + '\n';
      const w = await this.ssh(ip, 'mkdir -p /etc/ari-net && umask 077 && cat > /etc/ari-net/env', { input: envText, timeoutMs: 15000 });
      if (w.code !== 0) throw new Error('could not write /etc/ari-net/env');

      st.phase = `configuring ${n.role}`;
      const runScript = () => this.ssh(ip,
        `bash /opt/ari-net/bundle/fleet-roles/${n.role}.sh > /var/log/ari-net-bootstrap.log 2>&1; rc=$?; tail -n 12 /var/log/ari-net-bootstrap.log; exit $rc`,
        { timeoutMs: 20 * 60e3 });
      // App bootstraps are serialized so only one seeds the database at a time.
      const r = n.role === 'app' ? await this.appLock(runScript) : await runScript();
      if (r.code !== 0) throw new Error(`${n.role}.sh failed (exit ${r.code}): ${r.stdout.trim().split('\n').slice(-3).join(' | ')}`);

      st.ready = n.role;
      st.phase = null;
      this.log(`[fleet] ${n.label} ready (${n.role})`);
      if (n.role === 'app' || n.role === 'lb') await this.syncUpstream();
    } catch (e) {
      st.error = e.message;
      st.phase = 'bootstrap failed, will retry';
      this.log(`[fleet] bootstrap ${n.label} failed: ${e.message}`);
    } finally {
      st.boot.running = false;
    }
  }

  async syncUpstream() {
    return this.upstreamLock(async () => {
      const lb = this.nodesOfRole('lb').find((x) => { const st = this._state(x.id); return st.ready && !st.deleting; });
      if (!lb) return null;
      const apps = this.nodesOfRole('app').filter((a) => {
        const st = this._state(a.id);
        return st.ready && !st.deleting && a.inst.status === 'running' && a.privateIp && this.servingState(a.id) === 'serving';
      });
      const conf = apps.length
        ? apps.map((a) => `server ${a.privateIp}:3000 max_fails=2 fail_timeout=5s; # ${a.label}`).join('\n') + '\n'
        : 'server 127.0.0.1:65535 max_fails=0; # no app nodes yet\n';
      const U = '/etc/nginx/ari-net-upstream.conf';
      const cmd = `set -eu; cat > ${U}.new && if cmp -s ${U}.new ${U}; then rm -f ${U}.new; echo same; else cp ${U} ${U}.bak 2>/dev/null; mv ${U}.new ${U}; `
        + `if nginx -t >/dev/null 2>&1; then systemctl reload nginx && echo reloaded; else mv ${U}.bak ${U}; echo invalid; exit 1; fi; fi`;
      const r = await this.ssh(lb.publicIp, cmd, { input: conf, timeoutMs: 20000 });
      if (r.code === 0) {
        this.upstreamIds = apps.map((a) => a.id);
        if (r.stdout.includes('reloaded')) this.log(`[fleet] lb upstream -> ${apps.map((a) => a.label).join(', ') || '(none)'}`);
      }
      return r.code === 0;
    });
  }

  // Per-route traffic for the codemap: last 60s of the lb's nginx access log,
  // reduced on the lb to "status request_time METHOD path" per request.
  // The current ari-net load balancer node, or null.
  lbNode() {
    return this.nodesOfRole('lb').find((x) => { const st = this._state(x.id); return st.ready && !st.deleting && st.failStreak === 0 && x.inst.status === 'running'; }) || null;
  }

  // Private IPs of all fleet nodes (so our own load generators are never "attackers").
  _fleetPrivateIps() {
    const s = new Set();
    for (const n of this.instances.values()) if (n.privateIp) s.add(n.privateIp);
    return s;
  }

  // Ensure the lb has conf.d/ari-net-incident.conf (real client IP from the
  // controller's egress + blocklist include) and an existing blocklist file.
  async ensureIncidentConf(lb) {
    if (!lb || !this.controllerIp) return;
    if (Date.now() - this.incident._confAt < 60000) return;
    // Trust X-Forwarded-For from the controller's egress (DDoS drill) AND every
    // traffic node's private IP (the many-users generator), so the lb logs the
    // real/spoofed client IP for both.
    const trusted = [this.controllerIp, ...this.nodesOfRole('traffic').map((t) => t.privateIp)];
    const cmd = `test -f ${BLOCKLIST_FILE} || printf '# ari-net incident blocklist\\n' > ${BLOCKLIST_FILE}; `
      + `cat > ${INCIDENT_CONF}.new && if ! cmp -s ${INCIDENT_CONF}.new ${INCIDENT_CONF}; then mv ${INCIDENT_CONF}.new ${INCIDENT_CONF}; `
      + `nginx -t >/dev/null 2>&1 && systemctl reload nginx && echo applied || echo testfail; else rm -f ${INCIDENT_CONF}.new; echo same; fi`;
    const r = await this.ssh(lb.publicIp, cmd, { input: incidentConfContent(trusted), timeoutMs: 20000 });
    if (r.code === 0 && /applied/.test(r.stdout)) this.log(`[fleet] lb real-ip/blocklist config applied (${lb.label}) trusting ${trusted.length} source(s)`);
    if (r.code === 0) this.incident._confAt = Date.now();
  }

  // Read a short window of the lb access log and run the DDoS detector.
  async pollIncident() {
    if (this.incident._busy) return;
    const lb = this.lbNode();
    const inc = this.incident;
    if (!lb) { if (inc.active) this._setIncident(false, null); return; }
    this.incident._busy = true;
    try {
      await this.ensureIncidentConf(lb);
      const blocked = new Set(inc.blockedIps);
      const { reqPerSec, attackers } = analyzeWindow(this.requests.window(10).map(r => `${r.ts / 1000} ${r.status} ${r.ip}`).join('\n'), { windowSec: 10, fleetPrivateIps: this._fleetPrivateIps(), controllerIp: this.controllerIp });
      // attackers still hitting us (blocked ones are mitigated -> excluded)
      const live = attackers.filter((a) => !blocked.has(a.ip));
      const attackRate = live.reduce((s, a) => s + a.reqPerSec, 0);
      inc.reqPerSec = reqPerSec;
      if (inc.active) {
        const observed = new Map(inc.attackerIps.map(a => [a.ip, a]));
        for (const a of live) observed.set(a.ip, a);
        const count = inc.attackerIps.length;
        inc.attackerIps = [...observed.values()].slice(0, 10);
        if (inc.attackerIps.length !== count) this.rememberIncident();
      }
      if (!inc.active) {
        // learn baseline from calm periods only
        if (attackRate < CLEAR_ABS_) inc._baseline = inc._baseline * 0.8 + reqPerSec * 0.2;
        inc.baselineRps = Number(inc._baseline.toFixed(2));
      }
      const tripping = live.length >= 2 && attackRate >= Math.max(TRIP_ABS_, inc._baseline * TRIP_MULT_);
      if (tripping) { inc._trip++; inc._clear = 0; } else { inc._clear++; inc._trip = 0; }
      if (!inc.active && inc._trip >= TRIP_DEBOUNCE_) this._setIncident(true, lb, live);
      else if (inc.active && attackRate < CLEAR_ABS_ && inc._clear >= CLEAR_DEBOUNCE_) this._setIncident(false, lb);
      this._refreshIncidentIssue(lb);
    } finally { this.incident._busy = false; }
  }

  _setIncident(active, lb, attackers = []) {
    const inc = this.incident;
    if (active === inc.active) return;
    inc.active = active;
    if (active) {
      inc.id = crypto.randomUUID();
      inc.since = new Date().toISOString();
      inc.attackerIps = attackers.slice(0, 10);
      inc.clearedAt = null;
    } else inc.clearedAt = new Date().toISOString();
    inc._trip = 0; inc._clear = 0;
    inc.lbNodeId = lb ? lb.id : inc.lbNodeId;
    inc.lbLabel = lb ? lb.label : inc.lbLabel;
    this.rememberIncident();
    this.publish();
    this.log(active ? `[fleet] DDoS incident DETECTED on ${lb.label}: ${inc.reqPerSec} req/s, attackers ${inc.attackerIps.map((a) => a.ip).join(', ')}`
      : `[fleet] DDoS incident CLEARED on ${lb ? lb.label : 'lb'}`);
  }

  _refreshIncidentIssue(lb) {
    const inc = this.incident;
    if (!lb) return;
    if (inc.active) {
      const ips = inc.attackerIps.map((a) => `${a.ip} (${a.reqPerSec}/s)`).join(', ') || 'none currently';
      this.issues.set(lb.id, 'ddos', {
        severity: inc.reqPerSec >= inc._baseline * 6 ? 'critical' : 'high', kind: 'ddos',
        title: 'L7 request flood (possible DDoS)',
        detail: `${inc.reqPerSec} req/s vs ~${inc.baselineRps} baseline; sources: ${ips}${inc.blockedIps.length ? `; blocked: ${inc.blockedIps.join(', ')}` : ''}`,
        source: 'nginx access log', attackerIps: inc.attackerIps.map((a) => a.ip), blockedIps: [...inc.blockedIps],
      });
    } else {
      this.issues.set(lb.id, 'ddos', null);
    }
  }

  rememberIncident() {
    if (!this.incident.id) return;
    const view = this.incidentView();
    const previous = this.demo.incidents.findIndex(i => i.id === view.id);
    if (previous >= 0) this.demo.incidents[previous] = view;
    else this.demo.incidents.push(view);
    this.demo.incidents = this.demo.incidents.slice(-10);
    this.saveDemo();
  }

  incidentView() {
    const inc = this.incident;
    const lb = this.lbNode();
    return {
      id: inc.id || null,
      clearedAt: inc.clearedAt || null,
      active: inc.active,
      since: inc.since,
      lbNodeId: lb ? lb.id : (inc.lbNodeId || null),
      label: lb ? lb.label : (inc.lbLabel || null),
      reqPerSec: inc.reqPerSec,
      baselineRps: inc.baselineRps,
      attackerIps: inc.attackerIps,
      blockedIps: [...inc.blockedIps],
    };
  }

  // Block source IPs at the lb (nginx deny + reload). ari-net lb only.
  async blockIps(ips, incidentId = null) {
    return this.incidentLock(async () => {
      const lb = this.lbNode();
      if (!lb) throw httpError(409, 'no ready ari-net lb to block at');
      if (!ips?.length) {
        const incident = incidentId ? this.demo.incidents.find(i => i.id === incidentId) : this.demo.incidents.at(-1);
        if (!incident) throw httpError(409, 'no retained incident to block');
        ips = incident.attackerIps.map(a => a.ip);
      }
      const protectedIps = new Set([...this.instances.values()].flatMap(n => [n.privateIp, n.publicIp]).concat(this.controllerIp));
      const allowed = ip => isPlausibleSourceIp(ip) && !protectedIps.has(ip) && !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
      const valid = [...new Set((ips || []).map((x) => String(x).trim()))].filter(allowed);
      const rejected = (ips || []).filter((x) => !allowed(String(x).trim()));
      if (!valid.length) throw httpError(400, 'no valid source IPs to block');
      const set = new Set(this.incident.blockedIps);
      for (const ip of valid) set.add(ip);
      await this._writeBlocklist(lb, set);
      const traffic = this.nodesOfRole('traffic').find(n => n.inst.status === 'running');
      if (!traffic) throw httpError(409, 'no traffic node available to verify bans');
      const verify = valid.map(ip => `test "$(curl -sS --max-time 2 -o /dev/null -w '%{http_code}' -H 'X-Forwarded-For: ${ip}' http://${lb.privateIp}/health)" = 403`).join(' && ');
      const verified = await this.ssh(traffic.publicIp, verify, { timeoutMs: 12000 });
      if (verified.code !== 0) throw httpError(502, 'blocklist reloaded but rejection verification failed');
      this.incident.blockedIps = [...set];
      this.rememberIncident();
      this._refreshIncidentIssue(lb);
      pushReasoning(`Blocked ${valid.length} incident source IPs at the reverse proxy. Baseline traffic remains allowed.`);
      this.log(`[fleet] blocked at ${lb.label}: ${valid.join(', ')}`);
      return { ok: true, blocked: valid, rejected, blockedIps: [...set] };
    });
  }

  async unblockIps({ ips, all } = {}) {
    return this.incidentLock(async () => {
      const lb = this.lbNode();
      if (!lb) throw httpError(409, 'no ready ari-net lb');
      const set = new Set(this.incident.blockedIps);
      let removed;
      if (all) { removed = [...set]; set.clear(); }
      else { removed = (ips || []).map((x) => String(x).trim()).filter((ip) => set.delete(ip)); }
      await this._writeBlocklist(lb, set);
      this.incident.blockedIps = [...set];
      this._refreshIncidentIssue(lb);
      this.log(`[fleet] unblocked at ${lb.label}: ${removed.join(', ') || '(none)'}`);
      return { ok: true, unblocked: removed, blockedIps: [...set] };
    });
  }

  async _writeBlocklist(lb, ipSet) {
    const F = BLOCKLIST_FILE;
    const cmd = `set -eu; cat > ${F}.new && cp ${F} ${F}.bak 2>/dev/null; mv ${F}.new ${F}; `
      + `if nginx -t >/dev/null 2>&1; then systemctl reload nginx && echo ok; else mv ${F}.bak ${F} 2>/dev/null; echo invalid; exit 1; fi`;
    const r = await this.ssh(lb.publicIp, cmd, { input: blocklistContent([...ipSet]), timeoutMs: 20000 });
    if (r.code !== 0) throw httpError(502, `nginx blocklist reload failed on ${lb.label}`);
  }

  async pollRoutes() {
    if (this._routesBusy) return;
    const lb = this.nodesOfRole('lb').find((x) => { const st = this._state(x.id); return st.ready && !st.deleting && st.failStreak === 0; });
    if (!lb) return;
    this._routesBusy = true;
    try {
      const cmd = "tail -n 30000 /var/log/nginx/ari-access.log 2>/dev/null | awk -v t=$(( $(date +%s) - 60 )) "
        + "'$1>=t {print $2, $NF, $4, $5}'";
      const r = await this.ssh(lb.publicIp, cmd, { timeoutMs: 10000 });
      if (r.code === 0) ingestNginx('app', r.stdout, 60);
    } finally { this._routesBusy = false; }
  }

  // ---------- db / cache membership (like the lb upstream) ----------
  // The cache apps should use: oldest ready, running cache node.
  pickCache() {
    return this.nodesOfRole('cache')
      .filter((c) => { const st = this._state(c.id); return st.ready && !st.deleting && st.failStreak === 0 && c.inst.status === 'running'; })
      .sort((a, b) => String(a.inst.created).localeCompare(String(b.inst.created)) || a.id.localeCompare(b.id))[0] || null;
  }

  pickDb() {
    return this.nodesOfRole('db').find((d) => { const st = this._state(d.id); return st.ready && !st.deleting && d.inst.status === 'running'; }) || null;
  }

  // Is there a live fleet node at `ip` with `port` listening (from its latest sample)?
  _serviceAt(ip, port) {
    for (const [id, n] of this.instances) {
      if (n.privateIp !== ip) continue;
      const st = this._state(id);
      if (st.deleting || st.failStreak >= 2 || !st.sample) return false;
      return st.sample.listen.some((l) => l.port === port);
    }
    return false;
  }

  _depIssues(id, st) {
    const deps = st.sample && st.sample.deps;
    if (!deps || !st.ready) return;
    const check = (key, host, port, what) => {
      const down = host && !this._serviceAt(host, port);
      this.issues.set(id, key, down ? {
        severity: 'high', kind: 'dependency-missing', title: `Configured ${what} unreachable`,
        detail: `MyFiat points at ${what} ${host}:${port}, which is not a running fleet node listening on :${port}`,
        source: 'controller (env + fleet samples)',
      } : null);
    };
    check('dependency-missing:cache', deps.REDIS_HOST, 6379, 'Redis cache');
    check('dependency-missing:db', deps.DB_HOST, 5432, 'PostgreSQL db');
  }

  // Re-point app nodes (and the worker, for db) at the current cache/db,
  // one node at a time, restarting only the service and checking /health.
  async syncDeps() {
    return this.depsLock(async () => {
      const cache = this.pickCache();
      const db = this.pickDb();
      const consumers = [...this.nodesOfRole('app'), ...this.nodesOfRole('worker')].filter((a) => {
        const st = this._state(a.id);
        return st.ready && !st.deleting && st.failStreak === 0 && st.sample && st.sample.deps && !st.boot.running;
      });
      for (const a of consumers) {
        const st = this._state(a.id);
        const cur = st.sample.deps;
        const patch = {};
        const why = [];
        if (a.role === 'app') {
          const wantCache = cache ? cache.privateIp : '';
          const curCacheOk = cur.REDIS_HOST && this._serviceAt(cur.REDIS_HOST, 6379);
          // switch if pointing at nothing/dead, or if the chosen cache differs and the current one isn't live
          if ((cur.REDIS_HOST || '') !== wantCache && (!curCacheOk || !cur.REDIS_HOST)) {
            patch.REDIS_HOST = wantCache;
            patch.REDIS_PASS = cache ? await this.readSecret(cache, '/etc/ari-net/redis.pass') : '';
            why.push(`cache -> ${cache ? cache.label : '(none)'}`);
          }
        }
        // db: only re-point when a (replacement) db node exists at a different address
        if (db && cur.DB_HOST && cur.DB_HOST !== db.privateIp && !this._serviceAt(cur.DB_HOST, 5432)) {
          patch.DB_HOST = db.privateIp;
          patch.DB_PASS = await this.readSecret(db, '/etc/ari-net/db.pass');
          why.push(`db -> ${db.label}`);
        }
        if (!Object.keys(patch).length) continue;
        st.phase = `rewiring (${why.join(', ')})`;
        this.log(`[fleet] rewiring ${a.label}: ${why.join(', ')}`);
        const ok = await this._rewire(a, patch);
        st.phase = null;
        if (!ok) { st.error = `rewire failed (${why.join(', ')})`; this.log(`[fleet] rewire ${a.label} failed; stopping roll`); break; }
        st.error = null;
        st.sample.deps = { ...cur, ...(patch.REDIS_HOST !== undefined ? { REDIS_HOST: patch.REDIS_HOST } : {}),
          ...(patch.DB_HOST ? { DB_HOST: patch.DB_HOST } : {}) };
      }
    });
  }

  async _rewire(node, patch) {
    const ip = node.publicIp;
    // ship current scripts (+ app code) so the restart runs what the repo has
    const tarArgs = ['-czf', '-', '--exclude', 'node_modules', '--exclude', 'target-app/data', '--exclude', '.DS_Store',
      '-C', TELEMETRY_DIR, 'fleet-roles'];
    if (node.role === 'app') tarArgs.push('-C', REPO_ROOT, 'target-app');
    const up = await sshPipeTar(ip, tarArgs,
      'rm -rf /opt/ari-net/bundle && mkdir -p /opt/ari-net/bundle && tar -xzf - -C /opt/ari-net/bundle 2>/dev/null', { timeoutMs: 180000 });
    if (up.code !== 0) return false;
    const text = Object.entries(patch).map(([k, v]) => `${k}='${String(v).replace(/'/g, '')}'`).join('\n') + '\n';
    const keys = Object.keys(patch).join(' ');
    const script = node.role === 'app' ? 'app-rewire.sh' : 'worker-rewire.sh';
    const cmd = `umask 077; cat > /etc/ari-net/env.patch && for k in ${keys}; do sed -i "/^$k=/d" /etc/ari-net/env; done; `
      + `cat /etc/ari-net/env.patch >> /etc/ari-net/env; rm -f /etc/ari-net/env.patch; `
      + `bash /opt/ari-net/bundle/fleet-roles/${script} >> /var/log/ari-net-bootstrap.log 2>&1`;
    const r = await this.appLock(() => this.ssh(ip, cmd, { input: text, timeoutMs: 5 * 60e3 }));
    return r.code === 0;
  }

  async createNode(role, { standby = false } = {}) {
    if (!this.enabled) throw httpError(503, 'fleet disabled');
    if (!ROLE_SET.has(role)) throw httpError(400, `role must be one of ${[...ROLE_SET].join(', ')}`);
    return this.createLock(async () => {
      const list = await linode.listFleet();
      if (list.length + this.pendingCreates >= linode.MAX_INSTANCES) throw httpError(409, `fleet cap of ${linode.MAX_INSTANCES} ari-net instances reached`);
      const def = ROLES.find((r) => r.role === role);
      if (def.singleton && list.some((i) => linode.roleOf(i) === role)) throw httpError(409, `${role} is a singleton and already exists`);
      const used = new Set(list.map((i) => i.label));
      let k = 1;
      while (used.has(`ari-net-${role}-${k}`)) k++;
      const label = standby ? 'web-03' : `ari-net-${role}-${k}`;
      if (used.has(label)) throw httpError(409, `${label} already exists`);
      this.pendingCreates++;
      try {
        const inst = await linode.createInstance({ role, label, pubkey: this.pubkey, standby });
        const id = String(inst.id);
        const ips = linode.ipsOf(inst);
        if (ips.publicIp) await forgetHost(ips.publicIp);
        this.instances.set(id, { inst, role, label, ...ips });
        if (standby) { this.demo.serving[id] = 'standby'; this.saveDemo(); }
        this._state(id).phase = 'creating instance';
        this.log(`[fleet] created ${label} (${id}) ${ips.publicIp}`);
        return this.nodeView(id);
      } finally { this.pendingCreates--; }
    });
  }

  // Validates and starts deletion. Throws 404/403/400 before anything is changed.
  activateStandby(incidentId = this.incident.id || 'manual') {
    const key = `scale:${incidentId}`;
    if (this.demo.operations[key]) return this.demo.operations[key];
    const node = this.nodesOfRole('app').find(n => n.label === 'web-03' && this.servingState(n.id) === 'standby');
    if (!node || !this._state(node.id).ready) throw httpError(409, 'web-03 standby is not prepared; run demo prepare');
    const operation = { id: crypto.randomUUID(), kind: 'scale', nodeId: node.id, status: 'activating', progress: 0.15, startedAt: Date.now() };
    this.demo.operations[key] = operation;
    this.demo.serving[node.id] = 'activating';
    this.saveDemo();
    this.publish();
    const stage = (status, progress) => {
      Object.assign(operation, { status, progress });
      this.saveDemo(); this.publish();
      pushReasoning(`web-03: ${status.replaceAll('-', ' ')}.`);
    };
    void (async () => {
      try {
        stage('health-checking', 0.4);
        const checked = await this.ssh(node.publicIp,
          'systemctl is-active --quiet myfiat && curl -fsS --max-time 2 http://127.0.0.1:3000/health >/dev/null && curl -fsS --max-time 2 http://127.0.0.1:3000/api/users/1 >/dev/null && curl -fsS --max-time 2 http://127.0.0.1:3000/api/merchants >/dev/null', { timeoutMs: 7000 });
        if (checked.code !== 0) throw new Error('application/dependency health check failed');
        stage('joining', 0.75);
        this.demo.serving[node.id] = 'serving';
        // Hold publication until the proxy confirms the upstream works.
        if (!await this.syncUpstream()) throw new Error('nginx upstream reload failed');
        const lb = this.lbNode();
        const verified = await this.ssh(lb.publicIp,
          `for i in 1 2 3 4 5 6 7 8 9; do curl -fsS --max-time 1 'http://127.0.0.1/health?ari_activation=${operation.id}' >/dev/null || exit 1; done; grep -F 'ari_activation=${operation.id}' /var/log/nginx/ari-access.log | grep -F '${node.privateIp}:3000' | grep -q ' 200 '`, { timeoutMs: 5000 });
        if (verified.code !== 0) throw new Error('no successful proxied request observed on web-03');
        operation.completedAt = Date.now();
        stage('ready', 1);
      } catch (e) {
        this.demo.serving[node.id] = 'failed';
        await this.syncUpstream().catch(() => {});
        operation.error = e.message;
        stage('failed', operation.progress);
      }
    })();
    return operation;
  }

  async deleteNode(id, confirmLabel) {
    if (!this.enabled) throw httpError(503, 'fleet disabled');
    id = String(id);
    if (linode.isDenied(id)) throw httpError(403, 'not an ari-net instance; refusing');
    if (this.deleted.has(id) || (this.st.get(id) && this.st.get(id).deleting)) return { ok: true, alreadyDeleting: true };
    let inst;
    try { inst = await linode.getInstance(id); } catch (e) {
      // 404 = already gone: report success so the UI clears the node.
      if (e.status === 404) { this.deleted.set(id, Date.now()); if (this.instances.has(id)) this._dropNode(id); return { ok: true, alreadyDeleted: true }; }
      throw httpError(502, e.message);
    }
    if (!linode.isAriNet(inst)) throw httpError(403, 'not an ari-net instance; refusing');
    if (!confirmLabel || confirmLabel !== inst.label) throw httpError(400, 'X-Confirm-Label must equal the instance label exactly');
    const st = this._state(id);
    if (!this.instances.has(id)) this.instances.set(id, { inst, role: linode.roleOf(inst), label: inst.label, ...linode.ipsOf(inst) });
    st.deleting = true;
    st.phase = 'deleting';
    (async () => {
      try {
        if (linode.roleOf(inst) === 'app') {
          st.phase = 'leaving lb upstream';
          await this.syncUpstream();
        }
        st.phase = 'destroying instance';
        try {
          await linode.deleteInstance(id, inst.label); // re-checks tag + label itself
        } catch (e) {
          if (e.status !== 404) throw e; // 404: already destroyed
        }
        this.deleted.set(id, Date.now());
        this._dropNode(id);
        this.log(`[fleet] deleted ${inst.label} (${id})`);
        if (inst && linode.roleOf(inst) === 'cache') this.syncDeps().catch(() => {});
      } catch (e) {
        st.deleting = false;
        st.error = `delete failed: ${e.message}`;
        st.phase = null;
        this.log(`[fleet] delete ${inst.label} failed: ${e.message}`);
      }
    })();
    return { ok: true };
  }

  async setTrafficMode(mode) {
    if (mode !== 'normal' && mode !== 'surge') return;
    this.mode = mode;
    await Promise.all(this.nodesOfRole('traffic').map(async (t) => {
      if (!this._state(t.id).ready) return;
      const r = await this.ssh(t.publicIp, `echo ${mode} > /etc/ari-net/traffic.mode`, { timeoutMs: 10000 });
      if (r.code !== 0) this.log(`[fleet] could not set traffic mode on ${t.label}`);
    }));
  }

  // ---------- views ----------
  nodeView(id) {
    const n = this.instances.get(id);
    const st = this._state(id);
    const s = st.sample;
    let status;
    const ls = n.inst.status;
    if (st.deleting) status = 'deleting';
    else if (ls === 'provisioning' || st.phase === 'creating instance' && ls !== 'running' && ls !== 'booting') status = 'provisioning';
    else if (ls === 'booting' || ls === 'rebooting') status = 'booting';
    else if (ls === 'running') status = st.ready ? (st.failStreak >= 2 ? 'offline' : 'running') : 'booting';
    else status = 'offline';
    return {
      id,
      label: n.label,
      role: n.role,
      status,
      publicIp: n.publicIp,
      privateIp: n.privateIp,
      region: n.inst.region,
      type: n.inst.type,
      cpu: st.cpu != null ? Number(st.cpu.toFixed(3)) : 0,
      memUsed: s ? s.memTotal - s.memAvail : 0,
      memTotal: s ? s.memTotal : 0,
      load1: s ? s.load1 : 0,
      processes: s ? processesOf(s) : [],
      deletable: linode.isAriNet(n.inst),
      issues: this.issues.list(id),
      // additive extras
      phase: st.phase || null,
      error: st.error || null,
      servingState: n.role === 'app' ? this.servingState(id) : undefined,
      activation: Object.values(this.demo.operations).find(o => o.nodeId === id && o.kind === 'scale'),
      inUpstream: n.role === 'app' ? this.upstreamIds.includes(id) : undefined,
    };
  }

  snapshot() {
    const nodes = [...this.instances.keys()].map((id) => this.nodeView(id))
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
    const visible = new Set(nodes.filter(n => n.servingState !== 'standby').map(n => n.id));
    let links = this.links.filter((l) => visible.has(l.target) && (visible.has(l.source) || l.source === 'controller' || l.source === 'internet') && (this.instances.has(l.source) || l.source === 'controller' || l.source === 'internet') && this.instances.has(l.target));
    const lb = nodes.find(n => n.role === 'lb');
    const db = nodes.find(n => n.role === 'db');
    const cache = nodes.find(n => n.role === 'cache');
    for (const app of nodes.filter(n => n.role === 'app' && n.inUpstream && n.servingState === 'serving')) {
      for (const [source, target, port, protocol] of [[lb?.id, app.id, 3000, 'http-app'], [app.id, db?.id, 5432, 'postgres'], [app.id, cache?.id, 6379, 'redis']]) {
        if (!source || !target || links.some(l => l.source === source && l.target === target && l.port === port)) continue;
        links.push({ id: `${source}->${target}:${port}`, source, target, port, protocol, bytesPerSec: 0, bytesPerSecReverse: 0, conns: 0, configured: true });
      }
    }
    links = links.filter(l => !nodes.some(n => (n.id === l.source || n.id === l.target) && n.activation && !['ready', 'failed'].includes(n.activation.status)));
    const synth = [];
    if (links.some((l) => l.source === 'controller')) {
      synth.push({ id: 'controller', label: 'Ari controller', role: 'controller', status: 'running',
        publicIp: this.controllerIp, privateIp: null, region: null, type: null,
        cpu: this.controllerCpu != null ? Number(this.controllerCpu.toFixed(3)) : 0,
        memUsed: os.totalmem() - os.freemem(), memTotal: os.totalmem(), load1: Number(os.loadavg()[0].toFixed(2)),
        processes: [{ name: 'node', pid: process.pid, ports: [] }], deletable: false, issues: [] });
    }
    if (links.some((l) => l.source === 'internet')) {
      synth.push({ id: 'internet', label: 'Internet', role: 'internet', status: 'running', publicIp: null, privateIp: null,
        region: null, type: null, cpu: 0, memUsed: 0, memTotal: 0, load1: 0, processes: [], deletable: false, issues: [] });
    }
    return { nodes: [...synth, ...nodes.filter(n => visible.has(n.id))], links, updatedAt: this.updatedAt || new Date().toISOString() };
  }

  rolesView() {
    const count = this.instances.size + this.pendingCreates;
    return ROLES.map((r) => ({
      role: r.role, label: r.label, description: r.description,
      addable: this.enabled && count < linode.MAX_INSTANCES && (!r.singleton || this.nodesOfRole(r.role).length === 0),
    }));
  }
}
