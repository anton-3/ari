// Per-node sampling over SSH + link-rate computation.
//
// One SSH round-trip per node per sample (multiplexed over ControlMaster):
// /proc/stat, /proc/meminfo, loadavg, df, listening sockets, established TCP
// sockets with byte counters (ss -tinpH), and on the lb the last 60s of the
// nginx access log (5xx rate).
import { sshRun } from './ssh.js';

export const PORT_PROTOCOL = { 80: 'http', 3000: 'http-app', 5432: 'postgres', 6379: 'redis', 22: 'ssh' };

const SAMPLE_SCRIPT = `
echo "@READY $(cat /etc/ari-net/ready 2>/dev/null)"
echo "@CLIENT $SSH_CLIENT"
echo "@STAT $(head -1 /proc/stat)"
echo "@MEM $(awk '/^MemTotal|^MemAvailable/{print $2}' /proc/meminfo | tr '\\n' ' ')"
echo "@LOAD $(cat /proc/loadavg)"
echo "@DISK $(df -P / | awk 'NR==2{print $5}')"
echo "@MODE $(cat /etc/ari-net/traffic.mode 2>/dev/null)"
echo "@DEPS $(grep -sE '^(DB_HOST|REDIS_HOST)=' /etc/ari-net/env | tr -d "'" | tr '\n' ' ')"
if [ -f /var/log/nginx/ari-access.log ]; then
  echo "@HTTP $(tail -n 20000 /var/log/nginx/ari-access.log | awk -v t=$(( $(date +%s) - 60 )) '$1>=t{n++; if($2>=500)e++} END{print n+0, e+0}')"
fi
echo "@LISTEN"; ss -tlnpH
echo "@CONN"; ss -tinpH state established
echo "@END"
`;

// "[::ffff:192.168.1.2]:3000" | "192.168.1.2:3000" | "*:80" -> { ip, port }
function splitAddr(s) {
  const i = s.lastIndexOf(':');
  let ip = s.slice(0, i).replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return { ip, port: Number(s.slice(i + 1)) };
}

function parseUsers(s) {
  // users:(("nginx",pid=123,fd=6),("nginx",pid=124,fd=6))
  const out = [];
  const re = /\("([^"]+)",pid=(\d+)/g;
  let m;
  while ((m = re.exec(s || ''))) out.push({ name: m[1], pid: Number(m[2]) });
  return out;
}

export function parseSample(text) {
  const s = { ready: null, controllerIp: null, cpuTimes: null, memTotal: 0, memAvail: 0, load1: 0,
    diskPct: null, http: null, listen: [], conns: [], complete: false };
  let section = null;
  let lastConn = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('@')) {
      const [tag, ...rest] = line.split(' ');
      const val = rest.join(' ').trim();
      section = null;
      if (tag === '@READY') s.ready = val || null;
      else if (tag === '@CLIENT') s.controllerIp = val.split(' ')[0] || null;
      else if (tag === '@STAT') s.cpuTimes = val.split(/\s+/).slice(1).map(Number);
      else if (tag === '@MEM') { const [t, a] = val.split(/\s+/).map(Number); s.memTotal = t * 1024; s.memAvail = a * 1024; }
      else if (tag === '@LOAD') s.load1 = Number(val.split(' ')[0]) || 0;
      else if (tag === '@MODE') s.trafficMode = val || null;
      else if (tag === '@DEPS') {
        // non-secret wiring of this node, e.g. DB_HOST=192.168.1.2 REDIS_HOST=192.168.1.3
        if (val) s.deps = Object.fromEntries(val.split(/\s+/).filter((kv) => kv.includes('=')).map((kv) => kv.split('=')));
      }
      else if (tag === '@DISK') s.diskPct = Number(val.replace('%', '')) || null;
      else if (tag === '@HTTP') { const [n, e] = val.split(' ').map(Number); s.http = { total: n || 0, errors5xx: e || 0 }; }
      else if (tag === '@LISTEN') section = 'listen';
      else if (tag === '@CONN') section = 'conn';
      else if (tag === '@END') s.complete = true;
      continue;
    }
    if (!line.trim()) continue;
    if (section === 'listen') {
      // LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(...)
      const parts = line.trim().split(/\s+/);
      const local = splitAddr(parts[3]);
      s.listen.push({ ip: local.ip, port: local.port, procs: parseUsers(parts.slice(5).join(' ')) });
    } else if (section === 'conn') {
      if (/^\s/.test(raw)) {
        // info line for the previous connection
        if (lastConn) {
          const g = (k) => { const m = line.match(new RegExp(`\\b${k}:(\\d+)`)); return m ? Number(m[1]) : 0; };
          lastConn.acked = g('bytes_acked');
          lastConn.received = g('bytes_received');
        }
        continue;
      }
      // Recv-Q Send-Q Local Peer [users:(...)]
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4) continue;
      const local = splitAddr(parts[2]);
      const peer = splitAddr(parts[3]);
      lastConn = { local, peer, procs: parseUsers(parts.slice(4).join(' ')), acked: 0, received: 0 };
      s.conns.push(lastConn);
    }
  }
  return s;
}

export async function sampleNode(ip) {
  const r = await sshRun(ip, 'bash -s', { input: SAMPLE_SCRIPT, timeoutMs: 8000 });
  if (r.code !== 0) return { ok: false, error: (r.stderr || '').trim().split('\n').pop() || `ssh exit ${r.code}` };
  const s = parseSample(r.stdout);
  if (!s.complete) return { ok: false, error: 'incomplete sample' };
  return { ok: true, sample: s, at: Date.now() };
}

export function cpuUtil(prev, cur) {
  if (!prev || !cur) return null;
  const tot = (a) => a.slice(0, 8).reduce((x, y) => x + y, 0);
  const idle = (a) => (a[3] || 0) + (a[4] || 0);
  const dt = tot(cur) - tot(prev);
  if (dt <= 0) return null;
  return Math.max(0, Math.min(1, 1 - (idle(cur) - idle(prev)) / dt));
}

// Processes for the API: listening processes with their ports, plus processes
// that hold established connections without listening (clients like the
// traffic generator / worker).
export function processesOf(s) {
  const map = new Map();
  for (const l of s.listen) {
    for (const p of l.procs) {
      const k = `${p.name}:${p.pid}`;
      if (!map.has(k)) map.set(k, { name: p.name, pid: p.pid, ports: [] });
      const e = map.get(k);
      if (!e.ports.includes(l.port)) e.ports.push(l.port);
    }
  }
  for (const c of s.conns) {
    for (const p of c.procs) {
      const k = `${p.name}:${p.pid}`;
      if (!map.has(k) && p.name !== 'sshd' && p.name !== 'sshd-session') map.set(k, { name: p.name, pid: p.pid, ports: [] });
    }
  }
  return [...map.values()].map((p) => ({ ...p, ports: p.ports.sort((a, b) => a - b) }))
    .sort((a, b) => (b.ports.length - a.ports.length) || a.name.localeCompare(b.name));
}

/*
 * Link computation.
 *
 * Each established socket is classified on the node that reported it: if its
 * local port is one the node listens on, the node is the server and the peer
 * the client; otherwise the node is the client. A link is aggregated per
 * (client node, server node, server port), directed client -> server.
 * bytesPerSec = client->server bytes/s, bytesPerSecReverse = server->client.
 *
 * Intra-fleet sockets are seen from both ends; we take the server side's
 * counters and fall back to the client side if the server wasn't sampled.
 * Byte rates are counter deltas between consecutive samples of the same
 * socket; a socket that appears between samples contributes its full counters.
 */
export class LinkTracker {
  constructor() {
    this.prevConn = new Map();   // nodeId -> Map(connKey -> {acked, received})
    this.prevAt = new Map();     // nodeId -> ts of previous sample
  }

  forget(nodeId) { this.prevConn.delete(nodeId); this.prevAt.delete(nodeId); }

  // nodes: [{ id, privateIp, publicIp }], samples: Map(nodeId -> {sample, at}) (fresh this round)
  compute(nodes, samples) {
    const byIp = new Map();
    for (const n of nodes) {
      if (n.privateIp) byIp.set(n.privateIp, n.id);
      if (n.publicIp) byIp.set(n.publicIp, n.id);
    }
    const links = new Map(); // key -> link
    const seenTuples = new Map(); // tuple -> 'server' | 'client' (for dedupe)

    const addFlow = (src, dst, port, fwd, rev, protocol) => {
      const key = `${src}->${dst}:${port}`;
      if (!links.has(key)) {
        links.set(key, { id: key, source: src, target: dst, protocol: protocol || PORT_PROTOCOL[port] || `tcp/${port}`,
          port, bytesPerSec: 0, bytesPerSecReverse: 0, conns: 0 });
      }
      const l = links.get(key);
      l.bytesPerSec += fwd;
      l.bytesPerSecReverse += rev;
      l.conns += 1;
    };

    // Two passes: server-side observations first so they win the dedupe.
    const observations = [];
    for (const [nodeId, { sample, at }] of samples) {
      const listenPorts = new Set(sample.listen.map((l) => l.port));
      const prev = this.prevConn.get(nodeId);
      const prevAt = this.prevAt.get(nodeId);
      const dt = prevAt ? Math.max(0.5, (at - prevAt) / 1000) : null;
      const next = new Map();
      for (const c of sample.conns) {
        const ck = `${c.local.ip}:${c.local.port}|${c.peer.ip}:${c.peer.port}`;
        next.set(ck, { acked: c.acked, received: c.received });
        let dA = 0, dR = 0;
        if (dt) {
          const p = prev && prev.get(ck);
          dA = p ? c.acked - p.acked : c.acked;
          dR = p ? c.received - p.received : c.received;
          if (dA < 0) dA = c.acked;
          if (dR < 0) dR = c.received;
          dA /= dt; dR /= dt;
        }
        const isServer = listenPorts.has(c.local.port);
        observations.push({ nodeId, c, isServer, sentRate: dA, recvRate: dR, controllerIp: sample.controllerIp });
      }
      this.prevConn.set(nodeId, next);
      this.prevAt.set(nodeId, at);
    }
    observations.sort((a, b) => Number(b.isServer) - Number(a.isServer));

    for (const o of observations) {
      const { nodeId, c, isServer } = o;
      const peerNode = byIp.get(c.peer.ip) || null;
      const tuple = isServer
        ? `${c.peer.ip}:${c.peer.port}>${c.local.ip}:${c.local.port}`
        : `${c.local.ip}:${c.local.port}>${c.peer.ip}:${c.peer.port}`;
      if (seenTuples.has(tuple)) continue;
      seenTuples.set(tuple, true);
      if (isServer) {
        // forward (client->server) = what we received; reverse = what we sent
        if (peerNode) {
          if (peerNode !== nodeId) addFlow(peerNode, nodeId, c.local.port, o.recvRate, o.sentRate);
        } else if (c.local.port === 22 && o.controllerIp && c.peer.ip === o.controllerIp) {
          addFlow('controller', nodeId, 22, o.recvRate, o.sentRate, 'control');
        } else if (c.peer.ip !== '127.0.0.1' && c.peer.ip !== '::1') {
          addFlow('internet', nodeId, c.local.port, o.recvRate, o.sentRate);
        }
      } else if (peerNode && peerNode !== nodeId) {
        // client side: forward = what we sent; only used when the server side
        // wasn't sampled this round (otherwise deduped above).
        // Mark the server's tuple too so its later observation is skipped.
        addFlow(nodeId, peerNode, c.peer.port, o.sentRate, o.recvRate);
      }
      // client sockets to non-fleet hosts (apt mirrors etc.) are ignored
    }

    for (const l of links.values()) {
      l.bytesPerSec = Math.round(l.bytesPerSec);
      l.bytesPerSecReverse = Math.round(l.bytesPerSecReverse);
    }
    return [...links.values()];
  }
}
