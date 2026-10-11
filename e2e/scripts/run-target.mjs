/*
 * Launcher used by Playwright's `webServer`.
 *
 * It performs, in order, exactly what the task asks for and keeps the final
 * server process in the foreground so Playwright can health-check and later
 * SIGTERM it:
 *   1. `npm install` in ../../target-app  (only if deps are missing)
 *   2. `npm run seed -- --force`          (into an ISOLATED e2e db, not the
 *                                           shared data/myfiat.db the sibling
 *                                           agents may be using)
 *   3. `node src/server.js`               (PORT + MYFIAT_DB from env)
 *
 * The target app's own files are never modified; we only execute it.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TARGET = path.resolve(__dirname, '../../target-app');
const PORT = process.env.E2E_PORT || process.env.PORT || '8099';
// Keep the test run from clobbering the shared target-app/data/myfiat.db.
const DB = process.env.E2E_DB || path.resolve(__dirname, '../.tmp/e2e.db');

mkdirSync(path.dirname(DB), { recursive: true });

const env = {
  ...process.env,
  PORT,
  MYFIAT_DB: DB,
  ACMEPAY_DB: DB, // legacy alias the app also honours
  NODE_ENV: process.env.NODE_ENV || 'production',
};

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: TARGET, env });
  if (r.status !== 0) {
    console.error(`[e2e] "${cmd} ${args.join(' ')}" exited with ${r.status}`);
    process.exit(r.status || 1);
  }
}

// 1. install target-app deps only when they are clearly missing.
const depsPresent =
  existsSync(path.join(TARGET, 'node_modules', 'express')) &&
  existsSync(path.join(TARGET, 'node_modules', 'better-sqlite3'));
if (!depsPresent) {
  console.log('[e2e] installing target-app dependencies (first run)...');
  run('npm', ['install']);
}

// 2. (re)seed the isolated db.
console.log(`[e2e] seeding target-app db (force) -> ${DB}`);
run('npm', ['run', 'seed', '--', '--force']);

// 3. start the server in the foreground.
console.log(`[e2e] starting MyFiat on port ${PORT}`);
const child = spawn('node', ['src/server.js'], { stdio: 'inherit', cwd: TARGET, env });

const forward = (sig) => () => { if (child && !child.killed) child.kill(sig); };
process.on('SIGTERM', forward('SIGTERM'));
process.on('SIGINT', forward('SIGINT'));
child.on('exit', (code) => process.exit(code ?? 0));
