// Repo scanner for Ari's agent-swarm visualization.
//
// Walks source files under target-app/, backend/, and telemetry/src, builds a
// node per file (id/path/dir/label/loc/kind) and edges from textually-parsed
// import/require relationships (relative paths only; externals ignored).
//
// Pure read-only: it only reads files with fs. It never runs code or touches
// the network. Rescans on a ~30s interval kicked off by server.js.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// telemetry/src -> repo root
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Which trees to scan, and the "kind" each file is tagged with.
const SCAN_ROOTS = [
  { dir: path.join(REPO_ROOT, 'target-app'), kind: 'app' },
  { dir: path.join(REPO_ROOT, 'backend'), kind: 'backend' },
  { dir: path.join(REPO_ROOT, 'telemetry', 'src'), kind: 'telemetry' },
];

// Directory names to skip entirely.
const SKIP_DIRS = new Set(['node_modules', 'data', 'dist', 'build', '.git', 'public', 'coverage', '.next']);
// Only treat these as parseable source files.
const SOURCE_EXT = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx']);
// Resolution order when an import omits its extension.
const RESOLVE_EXT = ['', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx'];

// Lockfiles / generated files to ignore even if they slip through.
const SKIP_FILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml']);

let cache = { nodes: [], edges: [], scannedAt: null };

function toId(absPath) {
  return path.relative(REPO_ROOT, absPath).split(path.sep).join('/');
}

function countLines(absPath) {
  try {
    const txt = fs.readFileSync(absPath, 'utf8');
    if (txt.length === 0) return 0;
    // number of lines = newline count + 1 (unless file ends with newline)
    let n = 1;
    for (let i = 0; i < txt.length; i++) if (txt.charCodeAt(i) === 10) n++;
    if (txt.charCodeAt(txt.length - 1) === 10) n--;
    return n;
  } catch {
    return 0;
  }
}

function walk(dir, kind, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (ent.name.startsWith('.') && ent.name !== '.') {
      // skip dotfiles/dotdirs (except we never start here)
      if (ent.isDirectory()) continue;
    }
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      walk(abs, kind, out);
    } else if (ent.isFile()) {
      if (SKIP_FILES.has(ent.name)) continue;
      const ext = path.extname(ent.name).toLowerCase();
      if (!SOURCE_EXT.has(ext)) continue;
      const id = toId(abs);
      if (out.byId.has(id)) continue;
      const node = {
        id,
        path: id,
        dir: path.dirname(id),
        label: ent.name,
        loc: countLines(abs),
        kind,
      };
      out.nodes.push(node);
      out.byId.set(id, abs);
    }
  }
}

// Extract relative import/require specifiers from source text.
function extractSpecifiers(text) {
  const specs = [];
  // import ... from 'x'  /  import 'x'  /  export ... from 'x'
  const importRe = /(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
  // import('x')
  const dynImportRe = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  // require('x')
  const requireRe = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = importRe.exec(text))) specs.push(m[1]);
  while ((m = dynImportRe.exec(text))) specs.push(m[1]);
  while ((m = requireRe.exec(text))) specs.push(m[1]);
  return specs;
}

// Resolve a relative specifier (from fromAbsFile) to a node id in byId, or null.
function resolveSpec(spec, fromAbsFile, byId) {
  if (!spec.startsWith('.')) return null; // external / bare module
  const baseDir = path.dirname(fromAbsFile);
  const target = path.resolve(baseDir, spec);
  // try file with/without extension, then index files
  for (const ext of RESOLVE_EXT) {
    const id = toId(target + ext);
    if (byId.has(id)) return id;
  }
  for (const ext of RESOLVE_EXT) {
    if (ext === '') continue;
    const id = toId(path.join(target, 'index' + ext));
    if (byId.has(id)) return id;
  }
  return null;
}

export function scanRepo() {
  const out = { nodes: [], byId: new Map() };
  for (const root of SCAN_ROOTS) walk(root.dir, root.kind, out);

  const edges = [];
  const seenEdge = new Set();
  for (const node of out.nodes) {
    const abs = out.byId.get(node.id);
    let text;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const specs = extractSpecifiers(text);
    for (const spec of specs) {
      const toNodeId = resolveSpec(spec, abs, out.byId);
      if (!toNodeId || toNodeId === node.id) continue;
      const key = node.id + '->' + toNodeId;
      if (seenEdge.has(key)) continue;
      seenEdge.add(key);
      edges.push({ from: node.id, to: toNodeId });
    }
  }

  cache = {
    nodes: out.nodes.sort((a, b) => a.id.localeCompare(b.id)),
    edges,
    scannedAt: new Date().toISOString(),
  };
  return cache;
}

export function getRepoGraph() {
  if (!cache.scannedAt) scanRepo();
  return cache;
}
