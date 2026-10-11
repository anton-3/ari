// Offline-demo fleet simulator. Used ONLY when the page is opened with ?sim=1.
// Same shapes as /api/fleet, /api/fleet/roles and /api/agents so the view code
// path is identical; add/delete run a simulated provisioning lifecycle.
import type {
  Agent,
  Codemap,
  RouteStat,
  Sym,
  Fleet,
  FleetIssue,
  FleetLink,
  FleetNode,
  FleetProcess,
  FleetRoleInfo,
} from './types'

const rnd = (a: number, b: number) => a + Math.random() * (b - a)
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v)

const ROLES: FleetRoleInfo[] = [
  { role: 'app', label: 'App server', description: 'MyFiat Node.js app behind the load balancer', addable: true },
  { role: 'worker', label: 'Worker', description: 'Background job runner (postgres + redis)', addable: true },
  { role: 'cache', label: 'Redis cache', description: 'Session/cache store (singleton)', addable: false },
  { role: 'db', label: 'Postgres', description: 'Primary database (singleton)', addable: false },
  { role: 'lb', label: 'Load balancer', description: 'nginx ingress (singleton)', addable: false },
]

const SINGLETON = new Set(['lb', 'db', 'cache', 'traffic'])
const CAP = 10
const PROVISION_S = 3.5
const BOOT_S = 10

function procs(role: string): FleetProcess[] {
  const ssh = { name: 'sshd', pid: 612, ports: [22] }
  switch (role) {
    case 'lb': return [{ name: 'nginx', pid: 901, ports: [80, 443] }, ssh]
    case 'app': return [{ name: 'node myfiat', pid: 1204, ports: [3000] }, { name: 'pm2', pid: 1188, ports: [] }, ssh]
    case 'worker': return [{ name: 'node worker', pid: 1310, ports: [] }, ssh]
    case 'db': return [{ name: 'postgres', pid: 845, ports: [5432] }, ssh]
    case 'cache': return [{ name: 'redis-server', pid: 772, ports: [6379] }, ssh]
    case 'traffic': return [{ name: 'k6 loadgen', pid: 1502, ports: [] }, ssh]
    default: return [ssh]
  }
}

interface MNode extends FleetNode {
  bornAt: number
  deleteAt: number | null
  offlineUntil: number
}

export class MockFleet {
  private nodes: MNode[] = []
  private links: FleetLink[] = []
  private agents: Agent[] = []
  private seq = 0
  private agentSeq = 40
  private ipSeq = 10
  private t0 = Date.now()
  private rps = 0
  private surge = false

  constructor() {
    const old = Date.now() - 600_000
    const traffic = this.make('traffic', 'traffic-1', old, false)
    const lb = this.make('lb', 'lb-1', old, false)
    const a1 = this.make('app', 'app-1', old, true)
    const a2 = this.make('app', 'app-2', old, true)
    const db = this.make('db', 'db-1', old, false)
    const cache = this.make('cache', 'cache-1', old, true)
    this.nodes.push(traffic, lb, a1, a2, db, cache)
    this.link(traffic.id, lb.id, 'http', 80)
    for (const a of [a1, a2]) this.wireApp(a.id, lb.id, db.id, cache.id)
  }

  roles(): FleetRoleInfo[] {
    return ROLES.map((r) => ({ ...r }))
  }

  private make(role: string, label: string, bornAt: number, deletable: boolean): MNode {
    this.seq += 1
    this.ipSeq += 1
    return {
      id: `sim-${this.seq}`,
      label,
      role,
      status: 'running',
      publicIp: `172.105.${40 + (this.ipSeq % 50)}.${(this.ipSeq * 37) % 250}`,
      privateIp: `192.168.128.${this.ipSeq}`,
      region: 'us-ord',
      type: role === 'db' ? 'g6-standard-2' : 'g6-nanode-1',
      cpu: 0.1,
      memUsed: 300,
      memTotal: role === 'db' ? 4096 : 1024,
      load1: 0.2,
      processes: procs(role),
      deletable,
      issues: [],
      bornAt,
      deleteAt: null,
      offlineUntil: 0,
    }
  }

  private link(source: string, target: string, protocol: string, port: number) {
    this.links.push({ id: `${source}>${target}:${port}`, source, target, protocol, port, bytesPerSec: 0, bytesPerSecReverse: 0, conns: 0 })
  }

  private byRole(role: string) {
    return this.nodes.filter((n) => n.role === role && n.deleteAt === null)
  }

  private wireApp(id: string, lb?: string, db?: string, cache?: string) {
    const L = lb ?? this.byRole('lb')[0]?.id
    const D = db ?? this.byRole('db')[0]?.id
    const R = cache ?? this.byRole('cache')[0]?.id
    if (L) this.link(L, id, 'http-app', 3000)
    if (D) this.link(id, D, 'postgres', 5432)
    if (R) this.link(id, R, 'redis', 6379)
  }

  add(role: string): { status: number; node?: FleetNode; error?: string } {
    const info = ROLES.find((r) => r.role === role)
    if (!info) return { status: 400, error: `unknown role "${role}"` }
    if (SINGLETON.has(role) && this.byRole(role).length > 0) return { status: 409, error: `${role} is a singleton and already exists` }
    if (this.nodes.filter((n) => n.deleteAt === null).length >= CAP) return { status: 409, error: `fleet cap reached (${CAP} nodes)` }
    const n = this.byRole(role).length + 1
    let label = `${role}-${n}`
    while (this.nodes.some((x) => x.label === label)) label = `${role}-${n + Math.floor(rnd(2, 99))}`
    const node = this.make(role, label, Date.now(), true)
    node.status = 'provisioning'
    this.nodes.push(node)
    if (role === 'app') this.wireApp(node.id)
    if (role === 'worker') {
      const D = this.byRole('db')[0]?.id
      const R = this.byRole('cache')[0]?.id
      if (D) this.link(node.id, D, 'postgres', 5432)
      if (R) this.link(node.id, R, 'redis', 6379)
    }
    return { status: 202, node: this.strip(node) }
  }

  remove(id: string, label: string): { status: number; error?: string } {
    const n = this.nodes.find((x) => x.id === id)
    if (!n) return { status: 404, error: 'node not found' }
    if (!n.deletable) return { status: 403, error: `${n.label} is not deletable` }
    if (label !== n.label) return { status: 400, error: 'confirmation label does not match' }
    n.deleteAt = Date.now()
    n.status = 'deleting'
    return { status: 202 }
  }

  tick(surge: boolean): void {
    const now = Date.now()
    const t = (now - this.t0) / 1000
    // lifecycle
    for (const n of this.nodes) {
      const age = (now - n.bornAt) / 1000
      if (n.deleteAt !== null) n.status = 'deleting'
      else if (age < PROVISION_S) n.status = 'provisioning'
      else if (age < BOOT_S) n.status = 'booting'
      else if (now < n.offlineUntil) n.status = 'offline'
      else {
        n.status = 'running'
        if (n.role === 'app' && Math.random() < 0.006) n.offlineUntil = now + 9000
      }
    }
    const gone = new Set(this.nodes.filter((n) => n.deleteAt !== null && now - n.deleteAt > 3000).map((n) => n.id))
    if (gone.size) {
      this.nodes = this.nodes.filter((n) => !gone.has(n.id))
      this.links = this.links.filter((l) => !gone.has(l.source) && !gone.has(l.target))
      this.agents = this.agents.filter((a) => !gone.has(a.targetNodeId))
    }

    const up = (id: string) => this.nodes.find((n) => n.id === id)?.status === 'running'
    const rps = (420 + 120 * Math.sin(t / 20)) * (surge ? 3 : 1)
    this.rps = this.byRole('app').some((a) => up(a.id)) ? rps : 0
    this.surge = surge
    const apps = this.byRole('app').filter((a) => up(a.id))
    const share = apps.length ? rps / apps.length : 0
    const j = () => rnd(0.9, 1.1)
    for (const l of this.links) {
      const live = up(l.source) && up(l.target)
      let f = 0
      let r = 0
      if (live) {
        const src = this.nodes.find((n) => n.id === l.source)
        if (l.protocol === 'http') { f = rps * 900; r = rps * 5200 }
        else if (l.protocol === 'http-app') { f = share * 950; r = share * 5400 }
        else if (l.protocol === 'postgres') { f = src?.role === 'worker' ? 9000 : share * 0.6 * 380; r = f * 2.6 }
        else if (l.protocol === 'redis') { f = src?.role === 'worker' ? 4000 : share * 1.4 * 120; r = f * 4.5 }
      }
      l.bytesPerSec = Math.round(f * j())
      l.bytesPerSecReverse = Math.round(r * j())
      l.conns = live ? Math.max(1, Math.round((f / 9000) * j())) : 0
    }

    // load
    for (const n of this.nodes) {
      if (n.status !== 'running') { n.cpu = n.status === 'booting' ? rnd(0.3, 0.6) : 0; continue }
      const base = n.role === 'app' ? 0.12 + share / 1500 : n.role === 'db' ? 0.18 + rps / 5000 : n.role === 'lb' ? 0.06 + rps / 9000 : 0.08
      n.cpu = clamp(base + rnd(-0.04, 0.04), 0.01, 0.99)
      n.memUsed = Math.round(n.memTotal * clamp(0.35 + n.cpu * 0.4 + rnd(-0.02, 0.02), 0.1, 0.97))
      n.load1 = +(n.cpu * 2 + rnd(0, 0.2)).toFixed(2)
    }

    // issues — derived from the simulated conditions, same shape as the backend
    for (const n of this.nodes) {
      const prev = new Map((n.issues ?? []).map((i) => [i.id, i]))
      const out: FleetIssue[] = []
      const keep = (i: Omit<FleetIssue, 'since'>) => out.push({ ...i, since: prev.get(i.id)?.since ?? now })
      if (n.status === 'offline') keep({ id: `${n.id}:unreachable`, severity: 'critical', kind: 'unreachable', title: 'Node unreachable', detail: `no response from ${n.privateIp}:22 for 3 consecutive probes`, source: 'collector/ping' })
      if (n.status === 'running' && n.cpu > 0.9) keep({ id: `${n.id}:cpu`, severity: 'high', kind: 'cpu', title: `CPU ${Math.round(n.cpu * 100)}%`, detail: `load1 ${n.load1} on ${n.type}`, source: 'collector/metrics' })
      if (n.label === 'app-1' && n.status === 'running') keep({ id: `${n.id}:sqli`, severity: 'high', kind: 'vuln', title: 'SQL injection in GET /api/transactions', detail: 'target-app/src/server.js: unparameterized search query', source: 'code/MyFiat SECURITY-NOTES', file: 'target-app/src/server.js', symbolId: 'server.js#GET /api/transactions' })
      if (n.role === 'lb' && surge) keep({ id: `${n.id}:5xx`, severity: 'medium', kind: 'nginx-5xx', title: 'nginx 5xx rate 3.4%', detail: 'upstream timeouts under surge load', source: 'collector/nginx' })
      if (n.role === 'cache' && n.status === 'running') keep({ id: `${n.id}:updates`, severity: 'low', kind: 'updates', title: '12 pending security updates', detail: 'apt list --upgradable (openssl, libc6, …)', source: 'collector/apt' })
      n.issues = out
    }

    // check-job agents against real (simulated) nodes
    for (const a of this.agents) {
      if (a.status === 'dispatched') a.status = 'working'
      else if (a.status === 'working') {
        a.progress = clamp(a.progress + rnd(0.08, 0.2), 0, 1)
        if (a.progress >= 1) { a.status = 'done'; a.note = 'check complete' }
      }
    }
    this.agents = this.agents.filter((a) => a.status !== 'done' || Math.random() > 0.3)
    const targets = this.nodes.filter((n) => n.status === 'running')
    if (targets.length && this.agents.filter((a) => a.status !== 'done').length < 3 && Math.random() < 0.35) {
      const tgt = targets[Math.floor(Math.random() * targets.length)]
      const types = ['scanner', 'log-watcher', 'verifier', 'remediator']
      const type = types[Math.floor(Math.random() * types.length)]
      const notes: Record<string, string> = {
        scanner: `port scan ${tgt.privateIp}`,
        'log-watcher': `tailing auth.log on ${tgt.label}`,
        verifier: `re-checking open issues on ${tgt.label}`,
        remediator: `applying hardening to ${tgt.label}`,
      }
      this.agentSeq += 1
      this.agents.push({ id: `AGT-${String(this.agentSeq).padStart(4, '0')}`, type, label: `${type} AGT-${String(this.agentSeq).padStart(4, '0')}`, status: 'dispatched', targetNodeId: tgt.id, progress: 0, note: notes[type], simulated: true })
    }
  }

  private strip(n: MNode): FleetNode {
    const { bornAt: _b, deleteAt: _d, offlineUntil: _o, ...rest } = n
    void _b; void _d; void _o
    return { ...rest, processes: rest.processes.map((p) => ({ ...p, ports: [...p.ports] })), issues: (rest.issues ?? []).map((i) => ({ ...i })) }
  }

  snapshot(): Fleet {
    return { nodes: this.nodes.map((n) => this.strip(n)), links: this.links.map((l) => ({ ...l })), updatedAt: Date.now() }
  }

  // Mirrors the real target-app/ tree on disk (paths, line counts, imports,
  // listen/client ports) so the SIM expansion shows actual files.
  codemap(): Codemap {
    // Symbols mirror the real target-app source layout (simulated, SIM only).
    const S = (id: string, name: string, kind: string, line: number, endLine: number, calls: string[] = [], extra: Partial<Sym> = {}): Sym =>
      ({ id, name, kind, line, endLine, calls, ...extra })
    const R = (method: string, path: string, line: number, endLine: number, calls: string[], children?: Sym[]): Sym =>
      S(`server.js#${method} ${path}`, `${method} ${path}`, 'route', line, endLine, calls, { route: { method, path }, children })
    const common = ['cache.js#countRequest', 'db.js#getDb']
    const server: Sym[] = [
      R('GET', '/api/transactions', 103, 150, common, [
        S('server.js#txSearch', 'search (concatenated SQL)', 'query', 112, 122, ['db.js#openPostgres.run']),
        S('server.js#txRecent', 'recent transactions', 'query', 130, 136, ['db.js#openPostgres.run']),
      ]),
      R('GET', '/api/merchants', 174, 185, [...common, 'cache.js#cached'], [
        S('server.js#merchantsList', 'merchants by name', 'query', 177, 179, ['db.js#openPostgres.run']),
      ]),
      R('POST', '/api/login', 56, 79, [...common, 'config.js#jwtSecret'], [
        S('server.js#loginLookup', 'user by email', 'query', 61, 63, ['db.js#openPostgres.run']),
      ]),
      R('GET', '/api/users/:id', 81, 101, common),
      R('POST', '/api/payments', 152, 172, common, [
        S('server.js#payInsert', 'insert transaction', 'query', 157, 161, ['db.js#openPostgres.run']),
        S('server.js#paySelect', 'transaction by id', 'query', 162, 164, ['db.js#openPostgres.run']),
      ]),
      R('GET', '/health', 48, 54, []),
      R('GET', '/', 44, 46, []),
      S('server.js#errorHandler', 'errorHandler', 'function', 187, 195),
    ]
    const db: Sym[] = [
      S('db.js#getDb', 'getDb', 'function', 111, 114, ['db.js#openPostgres']),
      S('db.js#openPostgres', 'openPostgres', 'function', 91, 109, ['config.js#dbPath'], {
        children: [
          S('db.js#openPostgres.run', 'pool.query (run/get/all)', 'query', 101, 104),
          S('db.js#openPostgres.exec', 'exec', 'method', 106, 106),
        ],
      }),
      S('db.js#openSqlite', 'openSqlite', 'function', 62, 80, [], { children: [S('db.js#openSqlite.run', 'run', 'method', 72, 80)] }),
      S('db.js#toPg', 'toPg', 'function', 82, 89),
      S('db.js#initSchema', 'initSchema', 'function', 116, 120, ['db.js#openPostgres.run']),
      S('db.js#isSeeded', 'isSeeded', 'function', 122, 128, ['db.js#openPostgres.run']),
      S('db.js#SCHEMA', 'SQLITE_SCHEMA', 'config', 18, 54),
    ]
    const cache: Sym[] = [
      S('cache.js#countRequest', 'countRequest', 'function', 18, 22, ['cache.js#client']),
      S('cache.js#cached', 'cached', 'function', 24, 33, ['cache.js#client']),
      S('cache.js#client', 'redis client', 'query', 8, 14),
    ]
    const config: Sym[] = [
      S('config.js#port', 'port', 'config', 14, 14),
      S('config.js#dbPath', 'dbPath', 'config', 16, 16),
      S('config.js#stripeSecretKey', 'stripeSecretKey', 'config', 20, 20, [], { secret: true }),
      S('config.js#jwtSecret', 'jwtSecret', 'config', 24, 24, [], { secret: true }),
      S('config.js#safeSearch', 'safeSearch', 'config', 30, 30),
    ]
    const seed: Sym[] = [S('seed.js#reseed', 'reseed', 'function', 29, 98, ['db.js#getDb', 'db.js#initSchema', 'db.js#isSeeded'])]
    const mix: [string, number, number][] = [
      ['GET /api/transactions', 0.3, 0.012], ['GET /api/merchants', 0.24, 0], ['GET /api/users/:id', 0.16, 0],
      ['POST /api/login', 0.12, 0.004], ['POST /api/payments', 0.1, 0], ['GET /health', 0.07, 0], ['GET /', 0.01, 0],
    ]
    const routes: RouteStat[] = mix.map(([k, share, err]) => {
      const [method, path] = k.split(' ')
      const rps = +(this.rps * share * rnd(0.9, 1.1)).toFixed(1)
      return { method, path, symbolId: `server.js#${k}`, rps, errorRate: this.surge ? err * 4 + 0.01 : err, p95ms: rps > 0 ? Math.round(rnd(18, 40) * (this.surge ? 3 : 1)) : null }
    })
    return {
      roles: {
        app: {
          root: 'target-app',
          files: [
            { path: 'target-app/src/server.js', label: 'server.js', loc: 195, symbols: server },
            { path: 'target-app/src/db.js', label: 'db.js', loc: 130, symbols: db },
            { path: 'target-app/seed.js', label: 'seed.js', loc: 98, symbols: seed },
            { path: 'target-app/src/cache.js', label: 'cache.js', loc: 33, symbols: cache },
            { path: 'target-app/src/config.js', label: 'config.js', loc: 31, symbols: config },
          ],
          edges: [
            { from: 'target-app/src/server.js', to: 'target-app/src/config.js', kind: 'import' },
            { from: 'target-app/src/server.js', to: 'target-app/src/db.js', kind: 'import' },
            { from: 'target-app/src/server.js', to: 'target-app/src/cache.js', kind: 'import' },
            { from: 'target-app/src/db.js', to: 'target-app/src/config.js', kind: 'import' },
            { from: 'target-app/seed.js', to: 'target-app/src/db.js', kind: 'import' },
          ],
          ports: [
            { dir: 'in', port: 3000, file: 'target-app/src/server.js' },
            { dir: 'out', port: 5432, file: 'target-app/src/db.js' },
            { dir: 'out', port: 6379, file: 'target-app/src/cache.js' },
          ],
          routes,
        },
      },
    }
  }

  agentSnapshot(): Agent[] {
    return this.agents.map((a) => ({ ...a }))
  }
}
