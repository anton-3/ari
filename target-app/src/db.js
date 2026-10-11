/*
 * AcmePay - database access layer.
 * SQLite via better-sqlite3 by default; PostgreSQL (node-postgres) when
 * DATABASE_URL is set (used by the multi-node Linode fleet).
 * DEMO security target. See SECURITY-NOTES.md.
 *
 * Both backends expose the same async helpers:
 *   all(sql, params)  -> rows
 *   get(sql, params)  -> first row | undefined
 *   run(sql, params)  -> { lastInsertRowid, changes }
 *   exec(sql)         -> runs a multi-statement script
 * SQL is written with `?` placeholders; the Postgres adapter rewrites them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const SQLITE_SCHEMA = `
    CREATE TABLE IF NOT EXISTS merchants (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      country TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      full_name TEXT NOT NULL,
      -- VULN-adjacent: passwords stored as plain MD5 (weak hashing). Documented
      -- in SECURITY-NOTES.md. Kept simple for the demo.
      password_md5 TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'customer',
      ssn_last4 TEXT,
      card_last4 TEXT,
      balance_cents INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      merchant_id INTEGER NOT NULL,
      amount_cents INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      status TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (merchant_id) REFERENCES merchants(id)
    );
  `;

// Postgres flavour of the same schema (SERIAL ids; same weak MD5 column).
const PG_SCHEMA = SQLITE_SCHEMA.replace(/id INTEGER PRIMARY KEY/g, 'id SERIAL PRIMARY KEY');

export const dialect = process.env.DATABASE_URL ? 'postgres' : 'sqlite';

let _db = null;

async function openSqlite() {
  const { default: Database } = await import('better-sqlite3');
  const dir = path.dirname(config.dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const raw = new Database(config.dbPath);
  raw.pragma('journal_mode = WAL');
  return {
    dialect,
    all: async (sql, params = []) => raw.prepare(sql).all(...params),
    get: async (sql, params = []) => raw.prepare(sql).get(...params),
    run: async (sql, params = []) => {
      const info = raw.prepare(sql).run(...params);
      return { lastInsertRowid: Number(info.lastInsertRowid), changes: info.changes };
    },
    exec: async (sql) => raw.exec(sql),
  };
}

// `?` -> `$1..$n` (skips `?` inside single-quoted literals). LIKE -> ILIKE so
// searches behave like SQLite's case-insensitive LIKE.
function toPg(sql) {
  let n = 0, out = '', inStr = false;
  for (const ch of sql) {
    if (ch === "'") inStr = !inStr;
    out += !inStr && ch === '?' ? `$${++n}` : ch;
  }
  return out.replace(/\bLIKE\b/g, 'ILIKE');
}

async function openPostgres() {
  const { default: pg } = await import('pg');
  // Long-lived pooled connections (keeps app->db traffic on steady sockets).
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4, idleTimeoutMillis: 0 });
  pool.on('error', (err) => console.error('[acmepay] pg pool error:', err.message));
  const q = (sql, params = []) => pool.query(toPg(sql), params);
  return {
    dialect,
    all: async (sql, params) => (await q(sql, params)).rows,
    get: async (sql, params) => (await q(sql, params)).rows[0],
    run: async (sql, params) => {
      const isInsert = /^\s*INSERT/i.test(sql);
      const r = await q(isInsert ? `${sql} RETURNING id` : sql, params);
      return { lastInsertRowid: isInsert ? r.rows[0]?.id : undefined, changes: r.rowCount };
    },
    exec: async (sql) => { await pool.query(sql); },
    end: () => pool.end(),
  };
}

export async function getDb() {
  if (!_db) _db = dialect === 'postgres' ? openPostgres() : openSqlite();
  return _db;
}

export async function initSchema(db) {
  db = db || (await getDb());
  await db.exec(dialect === 'postgres' ? PG_SCHEMA : SQLITE_SCHEMA);
  return db;
}

export async function isSeeded(db) {
  db = db || (await getDb());
  try {
    const row = await db.get('SELECT COUNT(*) AS n FROM users');
    return Number(row.n) > 0;
  } catch {
    return false;
  }
}
