/*
 * =============================================================================
 *  AcmePay - payments / checkout API server
 * =============================================================================
 *  ⚠️  DEMO / CONTROLLED SECURITY TARGET  ⚠️
 *  This application DELIBERATELY contains security vulnerabilities so that the
 *  "Ari" autonomous security agent can discover and remediate them in a
 *  controlled hackathon demo. DO NOT deploy to a real production environment or
 *  expose to the public internet with real data. Every planted issue is
 *  catalogued in SECURITY-NOTES.md with file:line, impact, and fix.
 * =============================================================================
 */
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { getDb, initSchema, isSeeded } from './db.js';
import { countRequest, cached } from './cache.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

const db = await getDb();
await initSchema(db);
if (!(await isSeeded(db))) {
  console.warn('[acmepay] database is empty - run "npm run seed" to populate sample data.');
}

const app = express();
app.use(express.json());

// Lightweight request log so the app looks operational.
app.use((req, _res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl}`);
  countRequest(req.method, req.path.replace(/\/\d+$/, '/:id'));
  next();
});

// ---------------------------------------------------------------------------
// Landing page
// ---------------------------------------------------------------------------
app.get('/', (_req, res) => {
  res.type('html').send(fs.readFileSync(path.join(__dirname, '../public/index.html')));
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'acmepay', version: '1.2.0', time: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
// POST /api/login  { email, password }
app.post('/api/login', async (req, res, next) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }
  let user;
  try { user = await db.get('SELECT id, email, full_name, role, password_md5 FROM users WHERE email = ?', [email]); } catch (err) { return next(err); }
  if (!user || user.password_md5 !== md5(password)) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  // VULN #3 (adjacent): "token" is just a base64 of the user id + hard-coded
  // secret; trivially forgeable. Real code should sign a JWT with a strong,
  // env-provided secret and verify it on protected routes.
  const token = Buffer.from(`${user.id}:${config.jwtSecret}`).toString('base64');
  res.json({ token, user: { id: user.id, email: user.email, name: user.full_name, role: user.role } });
});

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------
// GET /api/users/:id
// VULN #3: BROKEN ACCESS CONTROL. This endpoint returns sensitive PII
// (email, ssn_last4, card_last4, balance) for ANY user id with NO
// authentication and NO authorization check. Any unauthenticated caller can
// enumerate every customer's data (IDOR). See SECURITY-NOTES.md issue #3.
app.get('/api/users/:id', async (req, res, next) => {
  let user;
  try {
    user = await db.get(`SELECT id, email, full_name, role, ssn_last4, card_last4, balance_cents, created_at
     FROM users WHERE id = ?`, [req.params.id]);
  } catch (err) { return next(err); }
  if (!user) return res.status(404).json({ error: 'user not found' });
  res.json(user);
});

// ---------------------------------------------------------------------------
// Transactions search
// ---------------------------------------------------------------------------
// GET /api/transactions?user=<name-or-email-fragment>&status=<status>
// VULN #1: SQL INJECTION. The `user` and `status` query params are
// concatenated directly into the SQL string. A payload like
//   ?user=' OR '1'='1
// returns every row, and UNION-based payloads can exfiltrate other tables
// (e.g. users.password_md5). See SECURITY-NOTES.md issue #1.
//
// A safe, parameterized implementation is provided below and is selected when
// ACMEPAY_SAFE_SEARCH=1 (config.safeSearch). That is the "fix".
app.get('/api/transactions', async (req, res) => {
  const userTerm = req.query.user ?? '';
  const statusTerm = req.query.status ?? '';

  try {
    if (config.safeSearch) {
      // ---- SAFE / FIXED version (parameterized) ----
      let sql = `SELECT t.id, t.amount_cents, t.currency, t.status, t.description, t.created_at,
                        u.full_name AS user_name, u.email AS user_email, m.name AS merchant
                 FROM transactions t
                 JOIN users u ON u.id = t.user_id
                 JOIN merchants m ON m.id = t.merchant_id
                 WHERE 1=1`;
      const params = [];
      if (userTerm) { sql += ' AND (u.full_name LIKE ? OR u.email LIKE ?)'; params.push(`%${userTerm}%`, `%${userTerm}%`); }
      if (statusTerm) { sql += ' AND t.status = ?'; params.push(statusTerm); }
      sql += ' ORDER BY t.created_at DESC LIMIT 200';
      const rows = await db.all(sql, params);
      return res.json({ count: rows.length, transactions: rows });
    }

    // ---- VULNERABLE version (string concatenation) ----
    let sql = `SELECT t.id, t.amount_cents, t.currency, t.status, t.description, t.created_at,
                      u.full_name AS user_name, u.email AS user_email, m.name AS merchant
               FROM transactions t
               JOIN users u ON u.id = t.user_id
               JOIN merchants m ON m.id = t.merchant_id
               WHERE 1=1`;
    if (userTerm) sql += ` AND (u.full_name LIKE '%${userTerm}%' OR u.email LIKE '%${userTerm}%')`;
    if (statusTerm) sql += ` AND t.status = '${statusTerm}'`;
    sql += ' ORDER BY t.created_at DESC LIMIT 200';
    const rows = await db.all(sql);
    return res.json({ count: rows.length, transactions: rows });
  } catch (err) {
    // VULN #4: VERBOSE ERROR DISCLOSURE. The raw error message (which includes
    // the offending SQL) and full stack trace are returned to the client.
    // See SECURITY-NOTES.md issue #4.
    return res.status(500).json({
      error: err.message,
      sql_hint: 'query failed',
      stack: err.stack,
    });
  }
});

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------
// POST /api/payments  { user_id, merchant_id, amount_cents, description }
app.post('/api/payments', async (req, res) => {
  const { user_id, merchant_id, amount_cents, currency = 'USD', description = '' } = req.body || {};
  if (!user_id || !merchant_id || !amount_cents) {
    return res.status(400).json({ error: 'user_id, merchant_id and amount_cents are required' });
  }
  try {
    const info = await db.run(
      `INSERT INTO transactions (user_id, merchant_id, amount_cents, currency, status, description, created_at)
       VALUES (?, ?, ?, ?, 'succeeded', ?, ?)`,
      [user_id, merchant_id, amount_cents, currency, description, new Date().toISOString()]
    );
    const tx = await db.get('SELECT * FROM transactions WHERE id = ?', [info.lastInsertRowid]);
    res.status(201).json({ ok: true, transaction: tx });
  } catch (err) {
    // VULN #4 (again): leaks stack trace.
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// ---------------------------------------------------------------------------
// Merchants
// ---------------------------------------------------------------------------
app.get('/api/merchants', async (_req, res, next) => {
  try {
    // Short-TTL Redis cache when REDIS_URL is set; straight to the db otherwise.
    const rows = await cached('acmepay:merchants', 5, () =>
      db.all('SELECT id, name, category, country, created_at FROM merchants ORDER BY name'));
    res.json({ count: rows.length, merchants: rows });
  } catch (err) { next(err); }
});

// Global error handler - also verbose (VULN #4).
app.use((err, _req, res, _next) => {
  res.status(500).json({ error: err.message, stack: err.stack });
});

const server = app.listen(config.port, () => {
  console.log(`[acmepay] listening on http://0.0.0.0:${config.port} (env=${config.env}, safeSearch=${config.safeSearch})`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));

export { app, server };
