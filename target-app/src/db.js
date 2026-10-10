/*
 * AcmePay - database access layer (SQLite via better-sqlite3).
 * DEMO security target. See SECURITY-NOTES.md.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

let _db = null;

export function getDb() {
  if (_db) return _db;
  const dir = path.dirname(config.dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  _db = new Database(config.dbPath);
  _db.pragma('journal_mode = WAL');
  return _db;
}

export function initSchema(db = getDb()) {
  db.exec(`
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
  `);
  return db;
}

export function isSeeded(db = getDb()) {
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM users').get();
    return row.n > 0;
  } catch {
    return false;
  }
}
