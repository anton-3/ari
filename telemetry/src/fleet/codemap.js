// Code map for the fleet's file-level view: for each role that runs our own
// code, the files actually deployed to that node, the static imports between
// them (same parser as repograph.js), where network traffic enters/leaves the
// code (listen() / pg Pool / redis client / http.client / psycopg2), a symbol
// tree per file (routes, functions, methods, config keys, SQL queries) with
// static call edges resolved across the role's files, and per-route traffic
// stats from the lb's real nginx access log (last 60s, refreshed ~5s).
//
// Read-only. JS is parsed with acorn; the two Python scripts with a small
// indentation-based parser. Config symbols carry key NAMES and lines only,
// never values.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';
import { countLines, extractSpecifiers } from '../repograph.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// Files each role deploys (mirrors fleet-roles/<role>.sh + the app tarball).
// `dialect` = which db adapter the role runs with (app nodes set DATABASE_URL).
const ROLE_FILES = {
  app: { root: 'target-app', files: ['src/server.js', 'src/config.js', 'src/db.js', 'src/cache.js', 'seed.js'], dialect: 'postgres' },
  traffic: { root: 'telemetry/fleet-roles', files: ['traffic.py'] },
  worker: { root: 'telemetry/fleet-roles', files: ['worker.py'] },
};

const PORT_PATTERNS = [
  { dir: 'in', port: 3000, re: /\.listen\s*\(/ },                         // HTTP server (PORT=3000 on app nodes)
  { dir: 'out', port: 5432, re: /new\s+pg\.Pool\s*\(|psycopg2\.connect\s*\(/ },
  { dir: 'out', port: 6379, re: /createClient\s*\(/ },
  { dir: 'out', port: 80, re: /HTTPConnection\s*\(/ },                    // traffic -> lb:80
];

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all']);
const SQL_RE = /^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|WITH)\b/i;
const SECRET_RE = /secret|token|password|passwd|apikey|api_key|privatekey|private_key|signing|credential|(^|[a-z])key$/i;

// ---------------------------------------------------------------- JS parsing
function parseJs(text) {
  return acorn.parse(text, { ecmaVersion: 'latest', sourceType: 'module', locations: true,
    allowAwaitOutsideFunction: true, allowHashBang: true });
}

const isFn = (n) => n && (n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression' || n.type === 'FunctionDeclaration');

// Visit every AST node under `node`; `skip(n)` true = don't descend into n.
function walk(node, fn, skip = () => false) {
  if (!node || typeof node.type !== 'string') return;
  fn(node);
  for (const k of Object.keys(node)) {
    if (k === 'loc' || k === 'start' || k === 'end') continue;
    const v = node[k];
    if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string' && !skip(c)) walk(c, fn, skip); }
    else if (v && typeof v.type === 'string' && !skip(v)) walk(v, fn, skip);
  }
}

function sqlTextOf(n) {
  if (!n) return null;
  let t = null;
  if (n.type === 'Literal' && typeof n.value === 'string') t = n.value;
  else if (n.type === 'TemplateLiteral') t = n.quasis.map((q) => q.value.cooked ?? '').join('${}');
  return t && SQL_RE.test(t) ? t : null;
}
const isDynamic = (n) => n && ((n.type === 'TemplateLiteral' && n.expressions.length > 0) || n.type === 'BinaryExpression');

function queryName(sql) {
  const s = sql.replace(/\s+/g, ' ').trim();
  const verb = s.split(' ')[0].toUpperCase();
  const m = s.match(/\b(?:FROM|INTO|UPDATE|TABLE(?: IF NOT EXISTS)?)\s+([A-Za-z_][\w.]*)/i);
  return `${verb}${m ? ` ${m[1]}` : ''}`;
}

const L = (n) => n.loc.start.line;
const E = (n) => n.loc.end.line;

// Queries inside `body` (not descending into `skipNodes`): SQL literals,
// plus `let sql = '...'` built up by later `sql += ...` statements (one query
// spanning declaration..last append; `concatenated` if any piece interpolates).
function collectQueries(body, idPrefix, skipNodes) {
  const decls = [];
  const appends = [];
  const loose = [];
  const consumed = new Set();
  walk(body, (n) => {
    if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && sqlTextOf(n.init)) {
      decls.push({ name: n.id.name, node: n, sql: sqlTextOf(n.init), dyn: isDynamic(n.init) });
      consumed.add(n.init);
    } else if (n.type === 'AssignmentExpression' && n.operator === '+=' && n.left.type === 'Identifier') {
      appends.push(n);
    } else if (sqlTextOf(n) && !consumed.has(n)) {
      loose.push(n);
    }
  }, (c) => skipNodes.has(c));
  const out = [];
  for (const d of decls) {
    let end = E(d.node);
    let dyn = d.dyn;
    // appends to this variable that come after it and before the next declaration of the same name
    const next = decls.filter((x) => x.name === d.name && x.node.start > d.node.start).sort((a, b) => a.node.start - b.node.start)[0];
    for (const a of appends) {
      if (a.left.name !== d.name || a.start < d.node.start || (next && a.start > next.node.start)) continue;
      end = Math.max(end, E(a));
      if (isDynamic(a.right)) dyn = true;
    }
    out.push({ id: `${idPrefix}/query@${L(d.node)}`, name: `query: ${queryName(d.sql)}`, kind: 'query',
      line: L(d.node), endLine: end, calls: [], concatenated: dyn });
  }
  for (const n of loose) {
    if (out.some((q) => L(n) >= q.line && E(n) <= q.endLine)) continue;
    const sql = sqlTextOf(n);
    out.push({ id: `${idPrefix}/query@${L(n)}`, name: `query: ${queryName(sql)}`, kind: 'query',
      line: L(n), endLine: E(n), calls: [], concatenated: isDynamic(n) });
  }
  return out.sort((a, b) => a.line - b.line);
}

// Raw call references inside a node: { name } for foo(), { obj, prop } for a.b().
function collectCallRefs(node, skipNodes) {
  const refs = [];
  walk(node, (n) => {
    if (n.type !== 'CallExpression') return;
    const c = n.callee;
    if (c.type === 'Identifier') refs.push({ name: c.name });
    else if (c.type === 'MemberExpression' && !c.computed && c.object.type === 'Identifier') refs.push({ obj: c.object.name, prop: c.property.name });
  }, (c) => skipNodes.has(c));
  return refs;
}

// Build a function-like symbol (function / method / route) with nested named
// functions and returned-object methods as children, queries, and call refs.
function buildFnSymbol({ id, name, kind, rangeNode, fnNodes }) {
  const children = [];
  const childNodes = new Set();
  for (const fnNode of fnNodes) {
    const body = fnNode.body;
    // nested named functions (const x = () => {} / function x() {})
    walk(body, (n) => {
      if (n.type === 'FunctionDeclaration' && n.id) {
        children.push(buildFnSymbol({ id: `${id}/${n.id.name}`, name: n.id.name, kind: 'function', rangeNode: n, fnNodes: [n] }));
        childNodes.add(n);
      } else if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && isFn(n.init)) {
        children.push(buildFnSymbol({ id: `${id}/${n.id.name}`, name: n.id.name, kind: 'function', rangeNode: n, fnNodes: [n.init] }));
        childNodes.add(n.init);
      } else if (n.type === 'ReturnStatement' && n.argument && n.argument.type === 'ObjectExpression') {
        for (const p of n.argument.properties) {
          if (p.type === 'Property' && isFn(p.value) && p.key.type === 'Identifier') {
            children.push(buildFnSymbol({ id: `${id}/${p.key.name}`, name: p.key.name, kind: 'method', rangeNode: p, fnNodes: [p.value] }));
            childNodes.add(p.value);
          }
        }
      }
    }, (c) => c !== body && isFn(c) && childNodes.has(c));
  }
  const queries = [];
  const refs = [];
  for (const fnNode of fnNodes) {
    queries.push(...collectQueries(fnNode.body, id, childNodes));
    refs.push(...collectCallRefs(fnNode.body, childNodes));
  }
  const sym = { id, name, kind, line: L(rangeNode), endLine: E(rangeNode), calls: [], _refs: refs };
  const kids = [...children, ...queries].sort((a, b) => a.line - b.line);
  if (kids.length) sym.children = kids;
  return sym;
}

function jsSymbols(fileId, text) {
  const ast = parseJs(text);
  const symbols = [];
  const imports = new Map();   // local name -> { from: fileId-ish spec, name }
  const exportsMap = new Map(); // exported name -> symbol id
  const adapterVars = new Set(); // vars holding the db adapter (const db = await getDb())
  const P = (name) => `${fileId}#${name}`;

  const addVarDecl = (decl, exported) => {
    for (const d of decl.declarations) {
      if (d.id.type !== 'Identifier') continue;
      const name = d.id.name;
      const init = d.init;
      if (init && init.type === 'AwaitExpression' && init.argument.type === 'CallExpression'
          && init.argument.callee.type === 'Identifier' && init.argument.callee.name === 'getDb') {
        adapterVars.add(name);
      }
      if (isFn(init)) {
        symbols.push(buildFnSymbol({ id: P(name), name, kind: 'function', rangeNode: decl, fnNodes: [init] }));
      } else if (sqlTextOf(init)) {
        symbols.push({ id: P(name), name, kind: 'query', line: L(decl), endLine: E(decl), calls: [],
          concatenated: false, _refs: [] });
      } else if (init && init.type === 'CallExpression' && init.callee.type === 'MemberExpression'
          && init.callee.object.type === 'Identifier' && symbols.some((s) => s.kind === 'query' && s.name === init.callee.object.name)) {
        // derived query text, e.g. PG_SCHEMA = SQLITE_SCHEMA.replace(...)
        symbols.push({ id: P(name), name, kind: 'query', line: L(decl), endLine: E(decl), calls: [],
          concatenated: false, _refs: [{ name: init.callee.object.name }] });
      } else if (init && init.type === 'ObjectExpression' && exported) {
        // config object: key names + lines only, NEVER values
        const children = init.properties.filter((p) => p.type === 'Property' && (p.key.type === 'Identifier' || p.key.type === 'Literal'))
          .map((p) => {
            const key = p.key.type === 'Identifier' ? p.key.name : String(p.key.value);
            const s = { id: `${P(name)}/${key}`, name: key, kind: 'config', line: L(p), endLine: E(p), calls: [] };
            if (SECRET_RE.test(key)) s.secret = true;
            return s;
          });
        symbols.push({ id: P(name), name, kind: 'config', line: L(decl), endLine: E(decl), calls: [], children, _refs: [] });
      } else {
        continue;
      }
      if (exported) exportsMap.set(name, P(name));
    }
  };

  for (const st of ast.body) {
    if (st.type === 'ImportDeclaration') {
      for (const sp of st.specifiers) {
        imports.set(sp.local.name, { spec: st.source.value, name: sp.type === 'ImportSpecifier' ? sp.imported.name : 'default' });
      }
    } else if (st.type === 'ExportNamedDeclaration' && st.declaration) {
      const d = st.declaration;
      if (d.type === 'FunctionDeclaration') {
        symbols.push(buildFnSymbol({ id: P(d.id.name), name: d.id.name, kind: 'function', rangeNode: st, fnNodes: [d] }));
        exportsMap.set(d.id.name, P(d.id.name));
      } else if (d.type === 'VariableDeclaration') addVarDecl(d, true);
    } else if (st.type === 'FunctionDeclaration') {
      symbols.push(buildFnSymbol({ id: P(st.id.name), name: st.id.name, kind: 'function', rangeNode: st, fnNodes: [st] }));
    } else if (st.type === 'VariableDeclaration') {
      addVarDecl(st, false);
    } else if (st.type === 'ExpressionStatement' && st.expression.type === 'CallExpression') {
      const call = st.expression;
      const c = call.callee;
      if (c.type !== 'MemberExpression' || c.object.type !== 'Identifier' || c.object.name !== 'app') continue;
      const method = c.property.name;
      const fns = call.arguments.filter(isFn);
      if (!fns.length) continue;
      const first = call.arguments[0];
      if (HTTP_METHODS.has(method) && first && first.type === 'Literal' && typeof first.value === 'string') {
        const name = `${method.toUpperCase()} ${first.value}`;
        const sym = buildFnSymbol({ id: P(name), name, kind: 'route', rangeNode: st, fnNodes: fns });
        sym.route = { method: method.toUpperCase(), path: first.value };
        symbols.push(sym);
      } else if (method === 'use') {
        const errHandler = fns[0].params.length === 4;
        const name = errHandler ? `error handler@${L(st)}` : `middleware@${L(st)}`;
        symbols.push(buildFnSymbol({ id: P(name), name, kind: 'function', rangeNode: st, fnNodes: fns }));
      }
    }
  }
  return { symbols, imports, exportsMap, adapterVars };
}

// ------------------------------------------------------------ Python parsing
function pySymbols(fileId, text) {
  const lines = text.split('\n');
  const P = (name) => `${fileId}#${name}`;
  const top = []; // { name, kind, start, end }
  const isTopCode = (l) => l.trim() && !/^\s/.test(l) && !l.startsWith('#');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(?:async\s+)?def\s+(\w+)\s*\(/) || lines[i].match(/^class\s+(\w+)/);
    if (!m) continue;
    let end = i;
    for (let j = i + 1; j < lines.length; j++) {
      if (isTopCode(lines[j])) break;
      if (lines[j].trim()) end = j;
    }
    top.push({ name: m[1], kind: lines[i].startsWith('class') ? 'class' : 'function', start: i, end });
  }
  // module-level entry code after the last def/class (e.g. `if __name__ == "__main__":` / main loop)
  const lastEnd = top.length ? Math.max(...top.map((t) => t.end)) : -1;
  let mainStart = -1, mainEnd = -1;
  for (let j = lastEnd + 1; j < lines.length; j++) {
    if (!lines[j].trim() || lines[j].startsWith('#')) continue;
    if (mainStart < 0 && isTopCode(lines[j]) && /^(if|while|for|try)\b/.test(lines[j])) mainStart = j;
    if (mainStart >= 0) mainEnd = j;
  }
  const names = top.map((t) => t.name);
  const callsIn = (from, to, self) => {
    const body = lines.slice(from, to + 1).join('\n');
    return names.filter((n) => n !== self && new RegExp(`(^|[^\\w.])${n}\\s*\\(`, 'm').test(body)).map(P);
  };
  const queriesIn = (from, to, prefix) => {
    const out = [];
    for (let i = from; i <= to; i++) {
      const m = lines[i].match(/execute\(\s*(?:"""|'''|"|')\s*(.*)/);
      if (!m) continue;
      let sql = m[1];
      let end = i;
      if (/execute\(\s*("""|''')/.test(lines[i]) && !/("""|''')\s*\)?\s*$/.test(m[1].trim()) ) {
        for (let j = i + 1; j <= to; j++) { sql += ` ${lines[j].trim()}`; end = j; if (/"""|'''/.test(lines[j])) break; }
      }
      if (!SQL_RE.test(sql)) continue;
      out.push({ id: `${prefix}/query@${i + 1}`, name: `query: ${queryName(sql)}`, kind: 'query', line: i + 1, endLine: end + 1,
        calls: [], concatenated: /%\s*\(|\.format\(|\+\s*\w/.test(lines.slice(i, end + 1).join(' ')) });
    }
    return out;
  };
  const symbols = top.map((t) => {
    const s = { id: P(t.name), name: t.name, kind: t.kind, line: t.start + 1, endLine: t.end + 1, calls: callsIn(t.start + 1, t.end, t.name) };
    const q = queriesIn(t.start, t.end, s.id);
    if (q.length) s.children = q;
    return s;
  });
  if (mainStart >= 0) {
    const s = { id: P('<main>'), name: '<main>', kind: 'function', line: mainStart + 1, endLine: mainEnd + 1, calls: callsIn(mainStart, mainEnd, null) };
    symbols.push(s);
  }
  return symbols;
}

// ------------------------------------------------------------- resolution
function flatten(syms, out = []) {
  for (const s of syms) { out.push(s); if (s.children) flatten(s.children, out); }
  return out;
}

// Resolve call refs to symbol ids within the role. db adapter calls
// (`db.all(...)` where db = await getDb()) resolve to the adapter method of the
// dialect the role runs with (openPostgres on app nodes).
function resolveCalls(role, perFile) {
  const fileIds = new Set(perFile.keys());
  const resolveImport = (fromFile, spec) => {
    if (!spec.startsWith('.')) return null;
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
    for (const ext of ['', '.js']) if (fileIds.has(base + ext)) return base + ext;
    return null;
  };
  const dbFile = [...perFile.keys()].find((f) => perFile.get(f).symbols.some((s) => s.name === 'openPostgres'));
  const adapterOwner = dbFile ? `${dbFile}#${role.dialect === 'postgres' ? 'openPostgres' : 'openSqlite'}` : null;

  for (const [fileId, info] of perFile) {
    const all = flatten(info.symbols);
    const topByName = new Map(info.symbols.map((s) => [s.name, s.id]));
    const visit = (sym, scope) => {
      const local = new Map(scope);
      for (const c of sym.children || []) if (c.kind === 'function' || c.kind === 'method') local.set(c.name, c.id);
      const calls = new Set();
      for (const r of sym._refs || []) {
        let target = null;
        if (r.name) {
          target = local.get(r.name) || topByName.get(r.name) || null;
          if (!target && info.imports.has(r.name)) {
            const imp = info.imports.get(r.name);
            const f = resolveImport(fileId, imp.spec);
            if (f) target = perFile.get(f).exportsMap.get(imp.name) || null;
          }
        } else if (r.obj && info.adapterVars.has(r.obj) && adapterOwner) {
          target = `${adapterOwner}/${r.prop}`;
        }
        if (target && target !== sym.id) calls.add(target);
      }
      // `calls` also includes the queries this symbol directly contains? No: containment is via children.
      sym.calls = [...new Set([...(sym.calls || []), ...calls])];
      delete sym._refs;
      for (const c of sym.children || []) visit(c, local);
    };
    for (const s of info.symbols) visit(s, new Map());
    // drop call targets that don't exist (e.g. adapter method names not defined)
    const ids = new Set();
    for (const inf of perFile.values()) for (const s of flatten(inf.symbols)) ids.add(s.id);
    for (const s of all) s.calls = s.calls.filter((c) => ids.has(c));
  }
}

// ---------------------------------------------------------------- scanning
let cache = { roles: {} };
const routeStats = {};   // role -> { at, routes: Map(symbolId -> stats), unmatched }

function pyImports(text) {
  const out = [];
  const re = /^\s*(?:from\s+(\.?[\w.]+)\s+import|import\s+([\w.]+))/gm;
  let m;
  while ((m = re.exec(text))) out.push(m[1] || m[2]);
  return out;
}

export function scanCodemap() {
  const roles = {};
  for (const [role, def] of Object.entries(ROLE_FILES)) {
    const files = [], edges = [], ports = [];
    const ids = new Set(def.files.map((f) => `${def.root}/${f}`));
    const perFile = new Map();
    for (const rel of def.files) {
      const id = `${def.root}/${rel}`;
      const abs = path.join(REPO_ROOT, id);
      let text;
      try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
      const isPy = rel.endsWith('.py');
      let symbols = [];
      try {
        if (isPy) symbols = pySymbols(id, text);
        else {
          const r = jsSymbols(id, text);
          symbols = r.symbols;
          perFile.set(id, r);
        }
      } catch (e) {
        symbols = [];
      }
      files.push({ path: id, label: path.basename(rel), loc: countLines(abs), symbols });
      const specs = isPy ? pyImports(text) : extractSpecifiers(text);
      for (const spec of specs) {
        let target = null;
        if (isPy) {
          const cand = `${def.root}/${spec.replace(/^\./, '').replace(/\./g, '/')}.py`;
          if (ids.has(cand)) target = cand;
        } else if (spec.startsWith('.')) {
          const resolved = path.relative(REPO_ROOT, path.resolve(path.dirname(abs), spec)).split(path.sep).join('/');
          for (const ext of ['', '.js']) if (ids.has(resolved + ext)) { target = resolved + ext; break; }
        }
        if (target && target !== id && !edges.some((e) => e.from === id && e.to === target)) {
          edges.push({ from: id, to: target, kind: 'import' });
        }
      }
      for (const p of PORT_PATTERNS) {
        if (p.re.test(text) && !ports.some((x) => x.dir === p.dir && x.port === p.port)) {
          ports.push({ dir: p.dir, port: p.port, file: id });
        }
      }
    }
    if (perFile.size) resolveCalls(def, perFile);
    const routeSyms = files.flatMap((f) => flatten(f.symbols)).filter((s) => s.kind === 'route');
    roles[role] = { root: def.root, files, edges, ports, _routeSyms: routeSyms };
  }
  cache = { roles };
  return cache;
}

// ------------------------------------------------------- route traffic stats
function routeRegex(p) {
  return new RegExp(`^${p.split('/').map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/')}/?$`);
}

// Lines: "<status> <request_time|-> <METHOD> <path>" from the lb's nginx log, last `windowSec`.
export function ingestNginx(role, text, windowSec = 60) {
  const r = getCodemap().roles[role];
  if (!r) return;
  const matchers = r._routeSyms.map((s) => ({ s, re: routeRegex(s.route.path) }));
  const agg = new Map(r._routeSyms.map((s) => [s.id, { n: 0, e5: 0, e4: 0, times: [] }]));
  const un = { n: 0, e5: 0, e4: 0 };
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const status = Number(parts[0]);
    const rt = Number(parts[1]);
    const method = parts[2].replace(/^"/, '').toUpperCase();
    const p = parts[3].split('?')[0];
    const hit = matchers.find((m) => (m.s.route.method === method || m.s.route.method === 'ALL') && m.re.test(p));
    const a = hit ? agg.get(hit.s.id) : un;
    a.n++;
    if (status >= 500) a.e5++; else if (status >= 400) a.e4++;
    if (hit && Number.isFinite(rt) && /^\d+(\.\d+)?$/.test(parts[1])) a.times.push(rt * 1000);
  }
  const p95 = (arr) => { if (!arr.length) return null; const s = [...arr].sort((x, y) => x - y); return Number(s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)].toFixed(1)); };
  const routes = new Map();
  for (const s of r._routeSyms) {
    const a = agg.get(s.id);
    routes.set(s.id, { method: s.route.method, path: s.route.path, symbolId: s.id,
      rps: Number((a.n / windowSec).toFixed(3)), errorRate: a.n ? Number((a.e5 / a.n).toFixed(4)) : 0,
      p95ms: p95(a.times), clientErrorRate: a.n ? Number((a.e4 / a.n).toFixed(4)) : 0, requests: a.n });
  }
  routeStats[role] = { at: new Date().toISOString(), windowSec, routes,
    unmatched: { rps: Number((un.n / windowSec).toFixed(3)), requests: un.n, errorRate: un.n ? Number((un.e5 / un.n).toFixed(4)) : 0,
      clientErrorRate: un.n ? Number((un.e4 / un.n).toFixed(4)) : 0 } };
}

export function getCodemap() {
  if (!Object.keys(cache.roles).length) scanCodemap();
  return cache;
}

// Public view (adds live per-route stats; strips internals).
export function codemapView() {
  const roles = {};
  for (const [role, r] of Object.entries(getCodemap().roles)) {
    const st = routeStats[role];
    const routes = r._routeSyms.map((s) => (st && st.routes.get(s.id)) || {
      method: s.route.method, path: s.route.path, symbolId: s.id, rps: 0, errorRate: 0, p95ms: null, clientErrorRate: 0, requests: 0,
    });
    const { _routeSyms, ...rest } = r;
    roles[role] = { ...rest, routes, routesUpdatedAt: st ? st.at : null, routesWindowSec: 60,
      unmatchedRequests: st ? st.unmatched : null };
  }
  return { roles };
}

// Innermost symbol whose line range contains `line` in `file` (repo-relative).
export function symbolAt(file, line) {
  for (const r of Object.values(getCodemap().roles)) {
    const f = r.files.find((x) => x.path === file);
    if (!f) continue;
    let best = null;
    const visit = (syms) => {
      for (const s of syms) {
        if (line >= s.line && line <= s.endLine) {
          if (!best || (s.endLine - s.line) <= (best.endLine - best.line)) best = s;
          if (s.children) visit(s.children);
        }
      }
    };
    visit(f.symbols);
    if (best) return best.id;
  }
  return null;
}
