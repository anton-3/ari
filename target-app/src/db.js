/*
 * MyFiat - database access layer.
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

    -- Indexes to keep list/search bounded and fast on a very large ledger
    -- (tens of millions of rows on the Postgres fleet node). Shared by both
    -- backends. A composite (user_id, created_at DESC) serves the per-user
    -- "recent transactions" view; created_at serves the global recent feed.
    CREATE INDEX IF NOT EXISTS idx_txn_user_created ON transactions (user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_txn_created ON transactions (created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_txn_status ON transactions (status);
    CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);

    -- -------------------------------------------------------------------
    -- MyFiat online-banking feature tables (NEW; additive only). The three
    -- tables above (users / merchants / transactions) are owned by the bulk
    -- loader and the security demo and must NEVER be altered. Everything
    -- below is new surface for the banking UI + the "Ari" customer assistant.
    -- All ids are plain integers (rewritten to SERIAL for Postgres); every
    -- created_at is ISO-8601 TEXT, consistent with the rest of the schema.
    -- -------------------------------------------------------------------

    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      kind TEXT NOT NULL,                 -- 'checking' | 'savings' | 'credit'
      name TEXT NOT NULL,
      mask TEXT,
      balance_cents INTEGER NOT NULL DEFAULT 0,
      apy_bps INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cards (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      account_id INTEGER,
      brand TEXT NOT NULL,                -- 'visa' | 'mastercard'
      last4 TEXT NOT NULL,
      exp_month INTEGER NOT NULL,
      exp_year INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active', -- 'active' | 'frozen' | 'expired'
      kind TEXT NOT NULL,                 -- 'credit' | 'debit'
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      merchant_name TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      cadence TEXT NOT NULL,              -- 'monthly' | 'yearly' | 'weekly'
      next_charge_at TEXT,
      status TEXT NOT NULL DEFAULT 'active', -- 'active' | 'canceled'
      category TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS holdings (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      asset_class TEXT NOT NULL,          -- 'stock' | 'crypto'
      symbol TEXT NOT NULL,
      name TEXT NOT NULL,
      quantity NUMERIC NOT NULL DEFAULT 0,
      cost_basis_cents INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      kind TEXT NOT NULL,                 -- suspicious_charge | card_expiring | low_balance | large_charge | subscription_renewal
      severity TEXT NOT NULL,             -- 'high' | 'medium' | 'low'
      title TEXT NOT NULL,
      detail TEXT,
      txn_id INTEGER,
      card_id INTEGER,
      status TEXT NOT NULL DEFAULT 'open', -- 'open' | 'resolved'
      action_taken TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      asset_class TEXT NOT NULL,          -- 'crypto' | 'stock'
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,                 -- 'buy' | 'sell'
      quantity NUMERIC NOT NULL,
      price_cents INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts (user_id);
    CREATE INDEX IF NOT EXISTS idx_cards_user ON cards (user_id);
    CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions (user_id);
    CREATE INDEX IF NOT EXISTS idx_holdings_user ON holdings (user_id);
    CREATE INDEX IF NOT EXISTS idx_alerts_user ON alerts (user_id, status);
    CREATE INDEX IF NOT EXISTS idx_trades_user ON trades (user_id, created_at DESC);
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
  pool.on('error', (err) => console.error('[myfiat] pg pool error:', err.message));
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
