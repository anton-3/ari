// Inventory for the nodes that run no code of ours: what is actually inside the
// Postgres, Redis and nginx servers, introspected over SSH and shaped like a
// codemap role (files -> symbols -> child symbols) so the map opens them the
// same way it opens an app node's source.
//
//   db     tables            -> columns, indexes
//   cache  keys, config      -> hash fields (numeric counters), settings
//   lb     nginx config files -> blocks -> locations / members -> directives
//
// Read-only. Postgres is asked for catalog data only (row counts are the
// planner's estimates, never COUNT(*)) under a statement timeout; Redis string
// values are never read (hash values only when numeric); public IPs in the nginx config are masked.
import { sshRun } from './ssh.js';

export const INVENTORY_ROLES = ['db', 'cache', 'lb'];
const CAP = { tables: 12, columns: 16, indexes: 6, keys: 12, fields: 12, directives: 14 };
const SENSITIVE_RE = /passw|secret|token|ssn|card|last4|cvv|\bpan\b|api_?key/i;

const sym = (id, name, kind, extra = {}) => ({ id, name, kind, line: 0, endLine: 0, calls: [], ...extra });
const more = (prefix, n) => sym(`${prefix}#+more`, `+${n} more`, 'more', { sub: '', info: [['not shown', String(n)]] });

function fmtBytes(b) {
  if (!Number.isFinite(b) || b <= 0) return '0 B';
  const u = ['B', 'kB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  const v = b / Math.pow(1024, i);
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}
function fmtCount(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  return n.toLocaleString('en-US');
}
// 0..1 on a log scale between lo and hi (tile heights stay readable across 6 orders of magnitude).
const logWeight = (v, lo, hi) => Math.max(0.06, Math.min(1, (Math.log10(Math.max(v, lo)) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo) || 1)));

// ------------------------------------------------------------------ postgres
const DB_SCRIPT = `
pg() { sudo -u postgres env "PGOPTIONS=-c statement_timeout=3000 -c default_transaction_read_only=on" psql -qtA "$@"; }
DB=$(pg -c "select datname from pg_database where not datistemplate and datname <> 'postgres' order by pg_database_size(datname) desc limit 1" </dev/null)
echo "@DB $DB"
[ -n "$DB" ] && pg -F "$(printf '\\t')" -d "$DB" <<'SQL'
select 'V', current_setting('server_version'), pg_database_size(current_database());
select 'T', c.relname, c.reltuples::bigint, pg_total_relation_size(c.oid)
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' order by 4 desc, 2 limit 40;
select 'C', table_name, column_name, data_type, is_nullable, coalesce(column_default, '')
  from information_schema.columns where table_schema = 'public' order by table_name, ordinal_position;
select 'I', tablename, indexname, indexdef from pg_indexes where schemaname = 'public' order by 2, 3;
select 'K', conrelid::regclass, contype, pg_get_constraintdef(oid)
  from pg_constraint where connamespace = 'public'::regnamespace and contype in ('p', 'f', 'u');
SQL
echo "@END"
`;

const TYPE_SHORT = { integer: 'int', bigint: 'bigint', 'character varying': 'varchar', 'timestamp without time zone': 'timestamp',
  'timestamp with time zone': 'timestamptz', 'double precision': 'float8', boolean: 'bool' };

export function parseDb(text) {
  if (!/^@END/m.test(text)) return null;
  const dbName = (text.match(/^@DB (.+)$/m) || [])[1];
  if (!dbName) return null;
  let version = '', dbBytes = 0;
  const tables = [];
  const cols = new Map(), idx = new Map();
  const pk = new Set(), uniq = new Set(), fk = new Map(); // "table.col" -> { table, col }
  for (const line of text.split('\n')) {
    const p = line.split('\t');
    if (p[0] === 'V') { version = p[1]; dbBytes = Number(p[2]) || 0; }
    else if (p[0] === 'T') tables.push({ name: p[1], rows: Number(p[2]), bytes: Number(p[3]) || 0 });
    else if (p[0] === 'C') { if (!cols.has(p[1])) cols.set(p[1], []); cols.get(p[1]).push({ name: p[2], type: p[3], nullable: p[4] === 'YES', def: p[5] || '' }); }
    else if (p[0] === 'I') { if (!idx.has(p[1])) idx.set(p[1], []); idx.get(p[1]).push({ name: p[2], def: p[3] || '' }); }
    else if (p[0] === 'K') {
      const t = p[1].replace(/^public\./, '');
      const def = p[3] || '';
      const own = (def.match(/\(([^)]*)\)/) || [])[1]?.split(',').map((s) => s.trim()) ?? [];
      if (p[2] === 'p') own.forEach((c) => pk.add(`${t}.${c}`));
      else if (p[2] === 'u' && own.length === 1) uniq.add(`${t}.${own[0]}`);
      else if (p[2] === 'f') {
        const m = def.match(/REFERENCES\s+([\w."]+)\s*\(([^)]*)\)/i);
        if (m && own.length === 1) fk.set(`${t}.${own[0]}`, { table: m[1].replace(/^public\.|"/g, ''), col: m[2].split(',')[0].trim() });
      }
    }
  }
  if (!tables.length) return null;
  const maxBytes = Math.max(...tables.map((t) => t.bytes), 1e6);
  const shown = tables.slice(0, CAP.tables);
  const names = new Set(shown.map((t) => t.name));
  const edges = [];
  const files = shown.map((t) => {
    const path = `${dbName}/${t.name}`;
    const all = cols.get(t.name) ?? [];
    const columns = all.slice(0, CAP.columns).map((c) => {
      const k = `${t.name}.${c.name}`;
      const ref = fk.get(k);
      const type = TYPE_SHORT[c.type] ?? c.type;
      const sensitive = SENSITIVE_RE.test(c.name);
      const s = sym(`${path}#${c.name}`, c.name, 'column', {
        sub: pk.has(k) ? 'pk' : ref ? `fk → ${ref.table}` : sensitive ? 'sensitive' : type,
        info: [['type', type], ['nullable', c.nullable ? 'yes' : 'no'],
          ...(c.def ? [['default', c.def.replace(/::\w+( \w+)*$/, '')]] : []),
          ...(pk.has(k) ? [['key', 'primary key']] : uniq.has(k) ? [['key', 'unique']] : []),
          ...(ref ? [['references', `${ref.table}.${ref.col}`]] : []),
          ...(sensitive ? [['data', 'sensitive, never read']] : [])],
      });
      if (sensitive) s.secret = true;
      if (ref && names.has(ref.table)) {
        s.calls = [`${dbName}/${ref.table}#${ref.col}`];
        if (ref.table !== t.name && !edges.some((e) => e.from === path && e.to === `${dbName}/${ref.table}`)) {
          edges.push({ from: path, to: `${dbName}/${ref.table}`, kind: 'fk' });
        }
      }
      return s;
    });
    if (all.length > CAP.columns) columns.push(more(`${path}/columns`, all.length - CAP.columns));
    const allIdx = idx.get(t.name) ?? [];
    const indexes = allIdx.slice(0, CAP.indexes).map((i) => {
      const unique = /^CREATE UNIQUE/i.test(i.def);
      const on = (i.def.match(/\(([^)]*)\)\s*$/) || [])[1] ?? '';
      return sym(`${path}#index:${i.name}`, i.name, 'index', {
        sub: unique ? 'unique' : 'index',
        info: [['columns', on], ['method', (i.def.match(/USING (\w+)/i) || [])[1] ?? 'btree'], ['unique', unique ? 'yes' : 'no']],
      });
    });
    if (allIdx.length > CAP.indexes) indexes.push(more(`${path}/indexes`, allIdx.length - CAP.indexes));
    const rows = t.rows >= 0 ? `~${fmtCount(t.rows)} rows` : null;
    return {
      path, label: t.name, kind: 'table', loc: t.bytes, weight: logWeight(t.bytes, 1e4, maxBytes),
      sub: rows ?? fmtBytes(t.bytes),
      info: [['rows', t.rows >= 0 ? `~${t.rows.toLocaleString('en-US')}` : 'not analyzed'], ['size', fmtBytes(t.bytes)],
        ['columns', String(all.length)], ['indexes', String(allIdx.length)]],
      symbols: [...columns, ...indexes],
    };
  });
  return { root: dbName, title: `PostgreSQL ${version.split(' ')[0]} · ${dbName} · ${fmtBytes(dbBytes)}`,
    noun: 'tables', hidden: Math.max(0, tables.length - shown.length), files, edges, ports: [] };
}

// --------------------------------------------------------------------- redis
const CACHE_SCRIPT = `
export REDISCLI_AUTH=$(cat /etc/ari-net/redis.pass 2>/dev/null)
r() { redis-cli --no-auth-warning "$@" </dev/null; }
echo "@INFO"
r info | tr -d '\\r' | grep -E '^(redis_version|used_memory|maxmemory|maxmemory_policy|connected_clients|keyspace_hits|keyspace_misses|instantaneous_ops_per_sec|uptime_in_seconds):'
echo "@DBSIZE $(r dbsize)"
r --scan | head -50 > /tmp/.ari-inv-keys
while IFS= read -r k; do
  t=$(r type "$k")
  case "$t" in
    hash) n=$(r hlen "$k");; list) n=$(r llen "$k");; set) n=$(r scard "$k");; zset) n=$(r zcard "$k");; string) n=$(r strlen "$k");; *) n=0;;
  esac
  echo "@KEY $t $(r ttl "$k") $(r memory usage "$k") $n $k"
  if [ "$t" = hash ] && [ "$n" -le 200 ]; then r hgetall "$k"; fi
done < /tmp/.ari-inv-keys
rm -f /tmp/.ari-inv-keys
echo "@END"
`;

export function parseCache(text) {
  if (!/^@END/m.test(text)) return null;
  const info = {};
  const keys = [];
  let section = null, cur = null, pendingField = null, dbsize = 0;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line === '@INFO') { section = 'info'; continue; }
    if (line.startsWith('@DBSIZE')) { dbsize = Number(line.split(' ')[1]) || 0; section = null; continue; }
    if (line.startsWith('@KEY ')) {
      const [, type, ttl, mem, n, ...rest] = line.split(' ');
      cur = { name: rest.join(' '), type, ttl: Number(ttl), mem: Number(mem) || 0, n: Number(n) || 0, fields: [] };
      keys.push(cur); section = 'key'; pendingField = null; continue;
    }
    if (line.startsWith('@END')) break;
    if (section === 'info') { const i = line.indexOf(':'); if (i > 0) info[line.slice(0, i)] = line.slice(i + 1); }
    else if (section === 'key' && cur) {
      if (pendingField == null) pendingField = line;
      else { cur.fields.push({ name: pendingField, value: /^-?\d+(\.\d+)?$/.test(line) ? Number(line) : null }); pendingField = null; }
    }
  }
  if (!info.redis_version) return null;
  const maxMem = Math.max(...keys.map((k) => k.mem), 4096);
  keys.sort((a, b) => b.mem - a.mem || a.name.localeCompare(b.name));
  const files = keys.slice(0, CAP.keys).map((k) => {
    const path = `redis/${k.name}`;
    const unit = k.type === 'hash' ? 'fields' : k.type === 'string' ? 'bytes' : 'items';
    const sorted = k.fields.slice().sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
    const top = sorted[0]?.value || 1;
    const symbols = sorted.slice(0, CAP.fields).map((f) => sym(`${path}#${f.name}`, f.name, 'field', {
      sub: f.value == null ? 'hidden' : fmtCount(f.value),
      weight: f.value == null ? 0.2 : Math.max(0.1, Math.sqrt(Math.max(0, f.value) / top)),
      info: [['value', f.value == null ? 'not read' : f.value.toLocaleString('en-US')], ['in', k.name]],
    }));
    if (sorted.length > CAP.fields) symbols.push(more(path, sorted.length - CAP.fields));
    return {
      path, label: k.name, kind: 'key', loc: k.mem, weight: logWeight(k.mem, 64, maxMem),
      sub: `${k.type} · ${fmtCount(k.n)}`,
      info: [['type', k.type], [unit, k.n.toLocaleString('en-US')], ['ttl', k.ttl < 0 ? 'no expiry' : `${k.ttl}s`], ['memory', fmtBytes(k.mem)]],
      symbols,
    };
  });
  const hits = Number(info.keyspace_hits) || 0, misses = Number(info.keyspace_misses) || 0;
  const settings = [
    ['maxmemory', fmtBytes(Number(info.maxmemory) || 0)],
    ['policy', info.maxmemory_policy ?? ''],
    ['memory used', fmtBytes(Number(info.used_memory) || 0)],
    ['hit rate', hits + misses ? `${Math.round((hits / (hits + misses)) * 100)}%` : '—'],
    ['clients', info.connected_clients ?? ''],
  ].filter(([, v]) => v !== '');
  files.push({
    path: 'redis/@config', label: 'redis.conf', kind: 'conf', loc: 0, weight: 0.3, sub: `v${info.redis_version}`,
    info: [['version', info.redis_version], ['keys', String(dbsize)], ...settings.slice(0, 2)],
    symbols: settings.map(([k, v]) => sym(`redis/@config#${k}`, k, 'directive', { sub: v, info: [['value', v]] })),
  });
  return { root: 'redis', title: `Redis ${info.redis_version} · ${dbsize} key${dbsize === 1 ? '' : 's'}`,
    noun: 'keys', hidden: Math.max(0, keys.length - CAP.keys), files, edges: [], ports: [] };
}

// --------------------------------------------------------------------- nginx
const LB_SCRIPT = `
echo "@VER $(nginx -v 2>&1 | sed 's/.*nginx\\///')"
for f in /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf /etc/nginx/ari-net-upstream.conf /etc/nginx/ari-net-blocklist.conf; do
  [ -f "$f" ] || continue
  echo "@FILE $f"
  cat "$f"
  echo
done
echo "@END"
`;

const PRIVATE_IP_RE = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
const maskIps = (s) => s.replace(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g, (m, a, b) => (PRIVATE_IP_RE.test(m) ? m : `${a}.${b}.x.x`));

// Statements of one nginx file: { name, args, line, endLine, comment, children? }.
function parseNginx(text) {
  const root = { children: [] };
  const stack = [root];
  let words = [], startLine = 0, quote = null, word = '', hasWord = false;
  const lines = text.split('\n');
  const pushWord = () => { if (hasWord) { words.push(word); word = ''; hasWord = false; } };
  lines.forEach((raw, li) => {
    let comment = null;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (quote) { if (ch === quote) quote = null; else word += ch; continue; }
      if (ch === '"' || ch === "'") { quote = ch; hasWord = true; if (!words.length && !word) startLine = li + 1; continue; }
      if (ch === '#') { comment = raw.slice(i + 1).trim(); break; }
      if (/\s/.test(ch)) { pushWord(); continue; }
      if (ch === ';' || ch === '{') {
        pushWord();
        if (words.length) {
          const st = { name: words[0], args: words.slice(1).join(' '), line: startLine, endLine: li + 1, comment: null };
          stack[stack.length - 1].children.push(st);
          if (ch === '{') { st.children = []; stack.push(st); }
          else st._semi = true;
        }
        words = [];
        continue;
      }
      if (ch === '}') { pushWord(); words = []; if (stack.length > 1) stack.pop().endLine = li + 1; continue; }
      if (!words.length && !hasWord) startLine = li + 1;
      word += ch; hasWord = true;
    }
    if (!quote) pushWord();
    // a trailing comment labels the statement that ended on this line (e.g. `server ...; # web-01`)
    if (comment) {
      const sib = stack[stack.length - 1].children;
      const last = sib[sib.length - 1];
      if (last && last._semi && last.endLine === li + 1) last.comment = comment;
    }
  });
  return root.children;
}

export function parseLb(text) {
  if (!/^@END/m.test(text)) return null;
  const version = (text.match(/^@VER (.+)$/m) || [])[1] ?? '';
  const raw = [];
  let cur = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('@FILE ')) { cur = { path: line.slice(6).trim(), lines: [] }; raw.push(cur); }
    else if (line.startsWith('@END')) break;
    else if (cur) cur.lines.push(line);
  }
  if (!raw.length) return null;
  const paths = new Set(raw.map((f) => f.path));
  const edges = [];
  const ports = [];
  const build = (fileId, prefix, st, depth) => {
    const args = maskIps(st.args);
    const id = `${prefix}/${st.name}${args ? ' ' + args : ''}@${st.line}`;
    const base = { line: st.line, endLine: st.endLine };
    if (st.children) {
      const kids = st.children.slice(0, CAP.directives).map((c) => build(fileId, id, c, depth + 1));
      if (st.children.length > CAP.directives) kids.push(more(id, st.children.length - CAP.directives));
      const listen = st.children.find((c) => c.name === 'listen');
      const kind = st.name === 'location' ? 'location' : st.name === 'upstream' ? 'upstream' : 'block';
      const label = st.name === 'server' && listen ? `server :${listen.args.split(' ')[0].replace(/^.*:/, '')}` : `${st.name}${args ? ' ' + args : ''}`;
      if (st.name === 'server' && listen) {
        const port = Number(listen.args.split(' ')[0].replace(/^.*:/, ''));
        if (port && !ports.some((p) => p.dir === 'in')) ports.push({ dir: 'in', port, file: fileId });
      }
      return sym(id, label, kind, { ...base, sub: `${st.children.length} inside`,
        info: [['block', st.name], ...(args ? [['match', args]] : []), ['lines', `${st.line}–${st.endLine}`]], children: kids });
    }
    // `server <addr>` inside an upstream (or its included file) is a backend member
    if (st.name === 'server' && /^[\w.[\]:-]+:\d+/.test(st.args)) {
      const addr = st.args.split(' ')[0];
      const port = Number(addr.split(':').pop());
      if (port && !ports.some((p) => p.dir === 'out')) ports.push({ dir: 'out', port, file: fileId });
      return sym(id, st.comment || addr, 'member', { ...base, sub: st.comment ? addr : 'backend',
        info: [['address', addr], ...(st.args.includes(' ') ? [['options', st.args.slice(addr.length + 1)]] : []), ['line', String(st.line)]] });
    }
    const s = sym(id, st.name, 'directive', { ...base, sub: args.length > 26 ? `${args.slice(0, 25)}…` : args,
      info: [['value', args || '(none)'], ['line', String(st.line)]] });
    if (st.name === 'include' && paths.has(st.args)) {
      s.calls = [st.args];
      if (st.args !== fileId && !edges.some((e) => e.from === fileId && e.to === st.args)) edges.push({ from: fileId, to: st.args, kind: 'include' });
    }
    return s;
  };
  const files = raw.map((f) => {
    while (f.lines.length && !f.lines[f.lines.length - 1].trim()) f.lines.pop();
    const stmts = parseNginx(f.lines.join('\n'));
    const symbols = stmts.slice(0, CAP.directives).map((st) => build(f.path, f.path, st, 2));
    if (stmts.length > CAP.directives) symbols.push(more(f.path, stmts.length - CAP.directives));
    const loc = f.lines.length;
    return { path: f.path, label: f.path.split('/').pop(), kind: 'conf', loc, weight: Math.max(0.15, Math.min(1, Math.sqrt(loc) / 6)),
      sub: stmts.length ? `${loc} lines` : 'empty',
      info: [['path', f.path], ['lines', String(loc)], ['statements', String(stmts.length)]], symbols };
  });
  return { root: '/etc/nginx', title: `nginx ${version}`, noun: 'config files', hidden: 0, files, edges, ports };
}

// ------------------------------------------------------------------ collect
const SPEC = {
  db: { script: DB_SCRIPT, parse: parseDb },
  cache: { script: CACHE_SCRIPT, parse: parseCache },
  lb: { script: LB_SCRIPT, parse: parseLb },
};

/** Introspect one node. Resolves a codemap-role-shaped object, or null on any failure. */
export async function collect(role, ip) {
  const spec = SPEC[role];
  if (!spec || !ip) return null;
  const r = await sshRun(ip, 'bash -s', { input: spec.script, timeoutMs: 20000 });
  if (r.code !== 0) return null;
  try {
    const out = spec.parse(r.stdout);
    return out ? { ...out, inventory: true, collectedAt: new Date().toISOString() } : null;
  } catch {
    return null;
  }
}

const latest = {};   // role -> last good result (a failed collect never blanks it)
let busy = false;

/** Refresh every inventory role from the fleet's first ready node of that role. */
export async function refreshInventory(fleet) {
  if (busy) return;
  busy = true;
  try {
    await Promise.all(INVENTORY_ROLES.map(async (role) => {
      const node = fleet.nodesOfRole(role).find((n) => {
        const st = fleet._state(n.id);
        return st.ready && !st.deleting && n.inst.status === 'running' && n.publicIp;
      });
      if (!node) return;
      const out = await collect(role, node.publicIp);
      if (out) latest[role] = out;
    }));
  } finally {
    busy = false;
  }
}

export function inventoryRoles() {
  return { ...latest };
}
