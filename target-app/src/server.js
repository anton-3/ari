/*
 * =============================================================================
 *  MyFiat - online banking + payments API server
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
  console.warn('[myfiat] database is empty - run "npm run seed" to populate sample data.');
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
  res.json({ status: 'ok', service: 'myfiat', version: '2.0.0', time: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
// Friendlier MyFiat-brand demo emails that resolve to the original fixed demo
// accounts (same user id, same password). The originals keep working too.
//   dana@myfiat.com  -> admin@acmepay.io  (id 1, password admin123)
//   avery@myfiat.com -> demo@acmepay.io   (id 2, password demo1234)
const LOGIN_ALIASES = {
  'dana@myfiat.com': 'admin@acmepay.io',
  'avery@myfiat.com': 'demo@acmepay.io',
  'demo@myfiat.com': 'demo@acmepay.io',
};

// POST /api/login  { email, password }
app.post('/api/login', async (req, res, next) => {
  const { email: rawEmail, password } = req.body || {};
  const email = LOGIN_ALIASES[String(rawEmail || '').toLowerCase()] || rawEmail;
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
  // Bounded pagination. page/pageSize are cast to clamped integers so a single
  // request can only ever return one page (<=100 rows), never millions from the
  // large Postgres ledger. NOTE: this bounding does NOT sanitize `user`/`status`
  // - the injectable string concatenation below is kept intentionally
  // (SECURITY-NOTES.md issue #1). Appending LIMIT/OFFSET is a perf guard only.
  const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 50, 1), 100);
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const offset = (page - 1) * pageSize;

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
      sql += ' ORDER BY t.created_at DESC LIMIT ? OFFSET ?';
      params.push(pageSize, offset);
      const rows = await db.all(sql, params);
      return res.json({ page, pageSize, count: rows.length, transactions: rows });
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
    sql += ` ORDER BY t.created_at DESC LIMIT ${pageSize} OFFSET ${offset}`;
    const rows = await db.all(sql);
    return res.json({ page, pageSize, count: rows.length, transactions: rows });
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
    const rows = await cached('myfiat:merchants', 5, () =>
      db.all('SELECT id, name, category, country, created_at FROM merchants ORDER BY name'));
    res.json({ count: rows.length, merchants: rows });
  } catch (err) { next(err); }
});

// ===========================================================================
// MyFiat online-banking API (NEW)
// ---------------------------------------------------------------------------
// Everything below is new feature surface for the banking UI and the "Ari"
// customer assistant. These routes REQUIRE the Bearer session token issued by
// POST /api/login and derive the user id from it. (The legacy IDOR on
// GET /api/users/:id above is intentionally left unauthenticated — see
// SECURITY-NOTES.md issue #3. These new routes do NOT reintroduce that bug.)
// ===========================================================================

// Decode the (deliberately weak) login token: base64("<id>:<jwtSecret>").
function userIdFromToken(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return null;
  let decoded;
  try { decoded = Buffer.from(m[1], 'base64').toString('utf8'); } catch { return null; }
  const idx = decoded.indexOf(':');
  if (idx < 0) return null;
  const id = Number(decoded.slice(0, idx));
  const secret = decoded.slice(idx + 1);
  if (secret !== config.jwtSecret) return null;
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

async function requireAuth(req, res, next) {
  const uid = userIdFromToken(req);
  if (!uid) return res.status(401).json({ error: 'missing or invalid session token' });
  const user = await db.get('SELECT id, email, full_name, role FROM users WHERE id = ?', [uid]);
  if (!user) return res.status(401).json({ error: 'session user not found' });
  req.user = { id: user.id, name: user.full_name, email: user.email, role: user.role };
  next();
}

const num = (v) => (v == null ? 0 : Number(v));

// ---- Live (fictional) market quote engine -------------------------------
// Plausible-but-fake prices in cents. Each read nudges the live price by a
// tiny random walk around a fixed "previous close" so the portfolio moves
// between requests. change_pct is measured against the previous close.
const QUOTES = {
  AAPL: { name: 'Apple Inc.',            close: 23150 },
  NVDA: { name: 'NVIDIA Corp.',          close: 14230 },
  VTI:  { name: 'Vanguard Total Market', close: 29580 },
  MSFT: { name: 'Microsoft Corp.',       close: 42710 },
  TSLA: { name: 'Tesla Inc.',            close: 24890 },
  AMZN: { name: 'Amazon.com Inc.',       close: 19860 },
  BTC:  { name: 'Bitcoin',               close: 6785000 },
  ETH:  { name: 'Ethereum',              close: 341800 },
  SOL:  { name: 'Solana',                close: 16740 },
  ADA:  { name: 'Cardano',               close: 38 },
  DOGE: { name: 'Dogecoin',              close: 12 },
  XRP:  { name: 'XRP',                   close: 240 },
  LTC:  { name: 'Litecoin',              close: 9500 },
  AVAX: { name: 'Avalanche',             close: 2800 },
  LINK: { name: 'Chainlink',             close: 1600 },
};
// The crypto universe (also the symbols we fetch live from CoinGecko).
const CRYPTO_SYMBOLS = new Set(['BTC', 'ETH', 'SOL', 'ADA', 'DOGE', 'XRP', 'LTC', 'AVAX', 'LINK']);
// Live price state, seeded at previous close, random-walked on each read.
const livePrice = {};
for (const [sym, q] of Object.entries(QUOTES)) livePrice[sym] = q.close;

function quote(symbol) {
  const q = QUOTES[symbol];
  if (!q) return { price_cents: 0, close_cents: 0, change_pct: 0, name: symbol };
  // Random walk: ±0.4% step, gently mean-reverting toward the close so it
  // wanders but never runs away during a long demo.
  const prev = livePrice[symbol];
  const drift = (Math.random() - 0.5) * 0.008;          // ±0.4%
  const revert = (q.close - prev) / q.close * 0.05;      // pull back to close
  let next = prev * (1 + drift + revert);
  next = Math.max(1, Math.round(next));
  livePrice[symbol] = next;
  return {
    name: q.name,
    price_cents: next,
    close_cents: q.close,
    change_pct: Math.round(((next - q.close) / q.close) * 10000) / 100,
  };
}

// ---- Live crypto prices (real outbound calls to a free public API) ------
// CoinGecko simple/price, no API key. The upstream response is cached
// server-side and refreshed at most once per CRYPTO_TTL_MS, so N concurrent
// users produce ~1 upstream call per interval (not one per request). On any
// failure/timeout we fall back to the in-code random-walk quote table so the
// page never breaks; the response carries source:'live'|'fallback'.
const CG_IDS = { bitcoin: 'BTC', ethereum: 'ETH', solana: 'SOL', cardano: 'ADA', dogecoin: 'DOGE', ripple: 'XRP', litecoin: 'LTC', 'avalanche-2': 'AVAX', chainlink: 'LINK' };
const CG_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,cardano,dogecoin,ripple,litecoin,avalanche-2,chainlink&vs_currencies=usd&include_24hr_change=true';
const CRYPTO_TTL_MS = 20000;
const CRYPTO_TIMEOUT_MS = 2500;
let cryptoCache = { at: 0, source: 'fallback', prices: null };

async function getCryptoPrices() {
  const now = Date.now();
  if (cryptoCache.prices && now - cryptoCache.at < CRYPTO_TTL_MS) return cryptoCache;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CRYPTO_TIMEOUT_MS);
    let json;
    try {
      const resp = await fetch(CG_URL, { signal: ctrl.signal, headers: { accept: 'application/json' } });
      if (!resp.ok) throw new Error(`coingecko ${resp.status}`);
      json = await resp.json();
    } finally { clearTimeout(timer); }
    const prices = {};
    for (const [id, sym] of Object.entries(CG_IDS)) {
      const row = json[id];
      if (!row || typeof row.usd !== 'number') continue;
      prices[sym] = {
        price_cents: Math.max(1, Math.round(row.usd * 100)),
        change_pct: Math.round((row.usd_24h_change || 0) * 100) / 100,
      };
      livePrice[sym] = prices[sym].price_cents; // keep the walk baseline near live
    }
    if (!Object.keys(prices).length) throw new Error('empty upstream payload');
    cryptoCache = { at: now, source: 'live', prices };
  } catch {
    const prices = {};
    for (const sym of CRYPTO_SYMBOLS) {
      const q = quote(sym);
      prices[sym] = { price_cents: q.price_cents, change_pct: q.change_pct };
    }
    cryptoCache = { at: now, source: 'fallback', prices };
  }
  return cryptoCache;
}

// Current price for one symbol: live cache for crypto, random-walk for stocks.
async function priceCentsFor(assetClass, symbol) {
  if (assetClass === 'crypto') {
    const c = await getCryptoPrices();
    if (c.prices && c.prices[symbol]) return c.prices[symbol].price_cents;
  }
  return quote(symbol).price_cents;
}

// Compute a user's portfolio with current prices (live for crypto).
async function portfolioFor(userId) {
  const rows = await db.all(
    'SELECT id, asset_class, symbol, name, quantity, cost_basis_cents FROM holdings WHERE user_id = ? ORDER BY id',
    [userId]
  );
  const live = await getCryptoPrices();
  const stocks = [];
  const crypto = [];
  let stocksCents = 0, cryptoCents = 0, stocksClose = 0, cryptoClose = 0;
  for (const r of rows) {
    const isCrypto = r.asset_class === 'crypto';
    const lp = isCrypto && live.prices ? live.prices[r.symbol] : null;
    const q = lp
      ? { name: (QUOTES[r.symbol] || {}).name || r.symbol, price_cents: lp.price_cents,
          close_cents: QUOTES[r.symbol] ? QUOTES[r.symbol].close : lp.price_cents, change_pct: lp.change_pct }
      : quote(r.symbol);
    const qty = num(r.quantity);
    const value = Math.round(q.price_cents * qty);
    // Derive the prior-close value from change_pct so the day-change total is
    // consistent whether the price came from the live feed or the walk table.
    const closeValue = Math.round(value / (1 + (num(q.change_pct) / 100)));
    const item = {
      symbol: r.symbol,
      name: r.name || q.name,
      quantity: qty,
      price_cents: q.price_cents,
      value_cents: value,
      change_pct: q.change_pct,
      cost_basis_cents: num(r.cost_basis_cents),
    };
    if (r.asset_class === 'crypto') { crypto.push(item); cryptoCents += value; cryptoClose += closeValue; }
    else { stocks.push(item); stocksCents += value; stocksClose += closeValue; }
  }
  const totalCents = stocksCents + cryptoCents;
  const totalClose = stocksClose + cryptoClose;
  const dayChangePct = totalClose > 0 ? Math.round(((totalCents - totalClose) / totalClose) * 10000) / 100 : 0;
  return {
    stocks, crypto,
    totals: {
      stocks_cents: stocksCents,
      crypto_cents: cryptoCents,
      total_cents: totalCents,
      day_change_pct: dayChangePct,
    },
  };
}

async function accountsFor(userId) {
  return db.all(
    `SELECT id, user_id, kind, name, mask, balance_cents, apy_bps, created_at
     FROM accounts WHERE user_id = ? ORDER BY
       CASE kind WHEN 'checking' THEN 0 WHEN 'savings' THEN 1 WHEN 'credit' THEN 2 ELSE 3 END, id`,
    [userId]
  );
}

// GET /api/me
app.get('/api/me', requireAuth, async (req, res, next) => {
  try {
    const accounts = await accountsFor(req.user.id);
    let cash = 0, credit = 0;
    for (const a of accounts) {
      if (a.kind === 'credit') credit += num(a.balance_cents);
      else cash += num(a.balance_cents);
    }
    const pf = await portfolioFor(req.user.id);
    const investments = pf.totals.total_cents;
    res.json({
      user: { id: req.user.id, name: req.user.name, email: req.user.email },
      accounts,
      totals: {
        cash_cents: cash,
        investments_cents: investments,
        net_worth_cents: cash + credit + investments,
      },
    });
  } catch (err) { next(err); }
});

// GET /api/accounts
app.get('/api/accounts', requireAuth, async (req, res, next) => {
  try { res.json({ accounts: await accountsFor(req.user.id) }); } catch (err) { next(err); }
});

// ---- Cards --------------------------------------------------------------
function cardRow(c) {
  return {
    id: c.id, user_id: c.user_id, account_id: c.account_id,
    brand: c.brand, last4: c.last4, exp_month: c.exp_month, exp_year: c.exp_year,
    status: c.status, kind: c.kind, created_at: c.created_at,
  };
}

async function getOwnedCard(userId, cardId) {
  return db.get('SELECT * FROM cards WHERE id = ? AND user_id = ?', [cardId, userId]);
}

// GET /api/cards
app.get('/api/cards', requireAuth, async (req, res, next) => {
  try {
    const rows = await db.all('SELECT * FROM cards WHERE user_id = ? ORDER BY id', [req.user.id]);
    res.json({ cards: rows.map(cardRow) });
  } catch (err) { next(err); }
});

// POST /api/cards/:id/renew -> bump exp +3 years, status active, new last4
app.post('/api/cards/:id/renew', requireAuth, async (req, res, next) => {
  try {
    const card = await getOwnedCard(req.user.id, req.params.id);
    if (!card) return res.status(404).json({ error: 'card not found' });
    const newLast4 = String(Math.floor(1000 + Math.random() * 9000));
    await db.run(
      'UPDATE cards SET exp_year = ?, status = ?, last4 = ? WHERE id = ?',
      [num(card.exp_year) + 3, 'active', newLast4, card.id]
    );
    const updated = await getOwnedCard(req.user.id, card.id);
    res.json({ ok: true, card: cardRow(updated) });
  } catch (err) { next(err); }
});

// POST /api/cards/:id/freeze and /unfreeze
function cardStatusToggle(target) {
  return async (req, res, next) => {
    try {
      const card = await getOwnedCard(req.user.id, req.params.id);
      if (!card) return res.status(404).json({ error: 'card not found' });
      await db.run('UPDATE cards SET status = ? WHERE id = ?', [target, card.id]);
      const updated = await getOwnedCard(req.user.id, card.id);
      res.json({ ok: true, card: cardRow(updated) });
    } catch (err) { next(err); }
  };
}
app.post('/api/cards/:id/freeze', requireAuth, cardStatusToggle('frozen'));
app.post('/api/cards/:id/unfreeze', requireAuth, cardStatusToggle('active'));

// ---- Subscriptions ------------------------------------------------------
function monthlyEquivalent(amount_cents, cadence) {
  if (cadence === 'yearly') return amount_cents / 12;
  if (cadence === 'weekly') return (amount_cents * 52) / 12;
  return amount_cents; // monthly
}

// GET /api/subscriptions
app.get('/api/subscriptions', requireAuth, async (req, res, next) => {
  try {
    const rows = await db.all(
      `SELECT id, user_id, merchant_name, amount_cents, cadence, next_charge_at, status, category, created_at
       FROM subscriptions WHERE user_id = ? ORDER BY status, next_charge_at`,
      [req.user.id]
    );
    const monthly_total_cents = Math.round(
      rows.filter((s) => s.status === 'active')
          .reduce((sum, s) => sum + monthlyEquivalent(num(s.amount_cents), s.cadence), 0)
    );
    res.json({ subscriptions: rows, monthly_total_cents });
  } catch (err) { next(err); }
});

// POST /api/subscriptions/:id/cancel
app.post('/api/subscriptions/:id/cancel', requireAuth, async (req, res, next) => {
  try {
    const sub = await db.get('SELECT * FROM subscriptions WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!sub) return res.status(404).json({ error: 'subscription not found' });
    await db.run('UPDATE subscriptions SET status = ? WHERE id = ?', ['canceled', sub.id]);
    const updated = await db.get('SELECT * FROM subscriptions WHERE id = ?', [sub.id]);
    res.json({ ok: true, subscription: updated });
  } catch (err) { next(err); }
});

// ---- Holdings / investments --------------------------------------------
// GET /api/holdings
app.get('/api/holdings', requireAuth, async (req, res, next) => {
  try { res.json(await portfolioFor(req.user.id)); } catch (err) { next(err); }
});

// ---- Markets / live crypto prices --------------------------------------
// GET /api/crypto/prices -> live (cached) crypto prices + source flag
app.get('/api/crypto/prices', requireAuth, async (req, res, next) => {
  try {
    const c = await getCryptoPrices();
    const prices = [...CRYPTO_SYMBOLS].map((sym) => ({
      symbol: sym,
      name: (QUOTES[sym] || {}).name || sym,
      price_cents: c.prices?.[sym]?.price_cents ?? 0,
      change_24h_pct: c.prices?.[sym]?.change_pct ?? 0,
    }));
    res.json({ source: c.source, as_of: new Date(c.at).toISOString(), prices });
  } catch (err) { next(err); }
});

// ---- Mock trading (updates real DB state) ------------------------------
async function cashAccountFor(userId) {
  return (
    (await db.get("SELECT * FROM accounts WHERE user_id = ? AND kind = 'checking' ORDER BY id LIMIT 1", [userId])) ||
    (await db.get("SELECT * FROM accounts WHERE user_id = ? AND kind = 'savings' ORDER BY id LIMIT 1", [userId]))
  );
}

// POST /api/trade { asset_class, symbol, side, quantity }
app.post('/api/trade', requireAuth, async (req, res, next) => {
  try {
    const body = req.body || {};
    const asset_class = body.asset_class;
    const symbol = String(body.symbol || '').toUpperCase();
    const side = body.side;
    const quantity = Number(body.quantity);

    if (!['crypto', 'stock'].includes(asset_class)) return res.status(400).json({ error: "asset_class must be 'crypto' or 'stock'" });
    if (!['buy', 'sell'].includes(side)) return res.status(400).json({ error: "side must be 'buy' or 'sell'" });
    if (!QUOTES[symbol]) return res.status(400).json({ error: `unknown symbol '${symbol}'` });
    const symbolIsCrypto = CRYPTO_SYMBOLS.has(symbol);
    if (symbolIsCrypto !== (asset_class === 'crypto')) return res.status(400).json({ error: `symbol ${symbol} does not match asset_class ${asset_class}` });
    if (!Number.isFinite(quantity) || quantity <= 0) return res.status(400).json({ error: 'quantity must be a positive number' });

    const account = await cashAccountFor(req.user.id);
    if (!account) return res.status(400).json({ error: 'no cash account available' });

    const price_cents = await priceCentsFor(asset_class, symbol);
    const notional = Math.round(price_cents * quantity);

    const holding = await db.get('SELECT * FROM holdings WHERE user_id = ? AND symbol = ?', [req.user.id, symbol]);

    if (side === 'buy') {
      if (num(account.balance_cents) < notional) {
        return res.status(400).json({ error: 'insufficient funds', needed_cents: notional, available_cents: num(account.balance_cents) });
      }
      if (holding) {
        await db.run('UPDATE holdings SET quantity = ?, cost_basis_cents = ? WHERE id = ?',
          [num(holding.quantity) + quantity, num(holding.cost_basis_cents) + notional, holding.id]);
      } else {
        await db.run(
          `INSERT INTO holdings (user_id, asset_class, symbol, name, quantity, cost_basis_cents, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [req.user.id, asset_class, symbol, QUOTES[symbol].name, quantity, notional, new Date().toISOString()]);
      }
      await db.run('UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ?', [notional, account.id]);
    } else { // sell
      if (!holding || num(holding.quantity) < quantity) {
        return res.status(400).json({ error: 'insufficient holdings', held: holding ? num(holding.quantity) : 0, requested: quantity });
      }
      const remaining = num(holding.quantity) - quantity;
      if (remaining <= 1e-9) {
        await db.run('DELETE FROM holdings WHERE id = ?', [holding.id]);
      } else {
        const newCost = Math.round(num(holding.cost_basis_cents) * (remaining / num(holding.quantity)));
        await db.run('UPDATE holdings SET quantity = ?, cost_basis_cents = ? WHERE id = ?', [remaining, newCost, holding.id]);
      }
      await db.run('UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ?', [notional, account.id]);
    }

    await db.run(
      `INSERT INTO trades (user_id, asset_class, symbol, side, quantity, price_cents, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [req.user.id, asset_class, symbol, side, quantity, price_cents, new Date().toISOString()]);

    const after = await db.get('SELECT balance_cents FROM accounts WHERE id = ?', [account.id]);
    res.status(201).json({
      ok: true,
      fill: { symbol, side, quantity, price_cents, cash_cents_after: num(after.balance_cents) },
    });
  } catch (err) { next(err); }
});

// POST /api/transfers { to, to_email?, amount_cents, note? } -> send money from checking (Ari + UI + sim users).
// If to_email (or to) is another MyFiat customer, it's a real P2P transfer: their checking is credited and
// they see it as incoming. Otherwise known merchants match by name, anyone else goes out via MyFiat Pay.
async function merchantNamed(name, category) {
  return (await db.get('SELECT id, name FROM merchants WHERE name = ? ORDER BY id LIMIT 1', [name])) ||
    { id: (await db.run('INSERT INTO merchants (name, category, country, created_at) VALUES (?, ?, ?, ?)',
      [name, category, 'US', new Date().toISOString()])).lastInsertRowid, name };
}
app.post('/api/transfers', requireAuth, async (req, res, next) => {
  try {
    const to = String(req.body?.to || req.body?.to_email || '').trim().slice(0, 80);
    const amount_cents = Math.round(Number(req.body?.amount_cents));
    if (!to) return res.status(400).json({ error: 'to is required' });
    if (!Number.isFinite(amount_cents) || amount_cents <= 0) return res.status(400).json({ error: 'amount_cents must be positive' });
    const account = await cashAccountFor(req.user.id);
    if (!account) return res.status(400).json({ error: 'no cash account available' });
    if (num(account.balance_cents) < amount_cents) {
      return res.status(400).json({ error: 'insufficient funds', available_cents: num(account.balance_cents) });
    }
    const email = String(req.body?.to_email || (to.includes('@') ? to : '')).toLowerCase();
    const recipient = email ? await db.get('SELECT id, full_name FROM users WHERE lower(email) = ?', [email]) : null;
    if (recipient && recipient.id === req.user.id) return res.status(400).json({ error: "can't send money to yourself" });
    const recipientAccount = recipient ? await cashAccountFor(recipient.id) : null;
    const payee = recipient ? recipient.full_name : to;
    const known = recipient ? null : await db.get('SELECT id, name FROM merchants WHERE lower(name) = lower(?) ORDER BY id LIMIT 1', [to]);
    const merchant = known || await merchantNamed('MyFiat Pay', 'transfers_out');
    const description = String(req.body?.note || '').trim().slice(0, 120) ||
      (known ? `Payment to ${known.name}` : `Transfer to ${payee}`);
    const now = new Date().toISOString();
    await db.run('UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ?', [amount_cents, account.id]);
    const info = await db.run(
      `INSERT INTO transactions (user_id, merchant_id, amount_cents, currency, status, description, created_at)
       VALUES (?, ?, ?, 'USD', 'succeeded', ?, ?)`,
      [req.user.id, merchant.id, amount_cents, description, now]);
    if (recipientAccount) {
      const incoming = await merchantNamed('MyFiat Transfer', 'transfer');
      const sender = await db.get('SELECT full_name FROM users WHERE id = ?', [req.user.id]);
      await db.run('UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ?', [amount_cents, recipientAccount.id]);
      await db.run(
        `INSERT INTO transactions (user_id, merchant_id, amount_cents, currency, status, description, created_at)
         VALUES (?, ?, ?, 'USD', 'succeeded', ?, ?)`,
        [recipient.id, incoming.id, amount_cents, `Transfer from ${sender?.full_name || 'a MyFiat customer'}`, now]);
    }
    const after = await db.get('SELECT balance_cents FROM accounts WHERE id = ?', [account.id]);
    res.status(201).json({ ok: true, transaction_id: info.lastInsertRowid, to: payee, amount_cents, description,
      p2p: Boolean(recipientAccount), from_account: account.name, balance_cents_after: num(after.balance_cents) });
  } catch (err) { next(err); }
});

// POST /api/transfers/internal { from, to, amount_cents? } -> move money between the user's own accounts.
// from/to are account kinds (checking | savings | credit) or account ids. Paying a credit card with no
// amount pays the full balance owed.
app.post('/api/transfers/internal', requireAuth, async (req, res, next) => {
  try {
    const accounts = await db.all('SELECT * FROM accounts WHERE user_id = ? ORDER BY id', [req.user.id]);
    const find = (v) => accounts.find((a) => String(a.id) === String(v)) || accounts.find((a) => a.kind === String(v || '').toLowerCase());
    const from = find(req.body?.from), to = find(req.body?.to);
    if (!from || !to || from.id === to.id) return res.status(400).json({ error: 'from and to must be two different accounts (checking, savings, credit)' });
    if (from.kind === 'credit') return res.status(400).json({ error: "can't move money out of a credit card" });
    let amount_cents = Math.round(Number(req.body?.amount_cents));
    if (!(amount_cents > 0) && to.kind === 'credit') amount_cents = Math.max(0, -num(to.balance_cents));
    if (!(amount_cents > 0)) return res.status(400).json({ error: 'amount_cents must be positive' });
    if (num(from.balance_cents) < amount_cents) return res.status(400).json({ error: 'insufficient funds', available_cents: num(from.balance_cents) });
    await db.run('UPDATE accounts SET balance_cents = balance_cents - ? WHERE id = ?', [amount_cents, from.id]);
    await db.run('UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ?', [amount_cents, to.id]);
    const after = await db.all('SELECT id, name, kind, balance_cents FROM accounts WHERE id IN (?, ?)', [from.id, to.id]);
    res.json({ ok: true, amount_cents, from: from.name, to: to.name,
      balances_after: after.map((a) => ({ ...a, balance_cents: num(a.balance_cents) })) });
  } catch (err) { next(err); }
});

// GET /api/trades -> recent trades for the user
app.get('/api/trades', requireAuth, async (req, res, next) => {
  try {
    const rows = await db.all(
      `SELECT id, user_id, asset_class, symbol, side, quantity, price_cents, created_at
       FROM trades WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 100`,
      [req.user.id]);
    res.json({ trades: rows.map((t) => ({ ...t, quantity: num(t.quantity) })) });
  } catch (err) { next(err); }
});

// ---- Alerts -------------------------------------------------------------
// GET /api/alerts -> open + recently resolved alerts
app.get('/api/alerts', requireAuth, async (req, res, next) => {
  try {
    const rows = await db.all(
      `SELECT id, user_id, kind, severity, title, detail, txn_id, card_id, status, action_taken, created_at
       FROM alerts WHERE user_id = ?
       ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END,
                CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
                created_at DESC`,
      [req.user.id]
    );
    res.json({
      alerts: rows,
      open_count: rows.filter((a) => a.status === 'open').length,
    });
  } catch (err) { next(err); }
});

// POST /api/alerts/:id/resolve  { action: 'confirm'|'dispute'|'dismiss'|'freeze_card' }
app.post('/api/alerts/:id/resolve', requireAuth, async (req, res, next) => {
  try {
    const action = (req.body && req.body.action) || 'dismiss';
    const valid = ['confirm', 'dispute', 'dismiss', 'freeze_card'];
    if (!valid.includes(action)) return res.status(400).json({ error: `action must be one of ${valid.join(', ')}` });
    const alert = await db.get('SELECT * FROM alerts WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
    if (!alert) return res.status(404).json({ error: 'alert not found' });

    let txn_flagged = false;
    let card_frozen = false;
    // A dispute flags the linked transaction (status -> 'disputed').
    if (action === 'dispute' && alert.txn_id) {
      try { await db.run("UPDATE transactions SET status = 'disputed' WHERE id = ?", [alert.txn_id]); txn_flagged = true; } catch { /* ledger may be read-only on the fleet */ }
    }
    // freeze_card freezes the linked card, if any.
    if (action === 'freeze_card' && alert.card_id) {
      await db.run("UPDATE cards SET status = 'frozen' WHERE id = ? AND user_id = ?", [alert.card_id, req.user.id]);
      card_frozen = true;
    }
    await db.run('UPDATE alerts SET status = ?, action_taken = ? WHERE id = ?', ['resolved', action, alert.id]);
    const updated = await db.get('SELECT * FROM alerts WHERE id = ?', [alert.id]);
    res.json({ ok: true, alert: updated, txn_flagged, card_frozen });
  } catch (err) { next(err); }
});

// ---- Insights -----------------------------------------------------------
// Categories treated as money IN (credits); everything else is money OUT.
const INCOME_CATEGORIES = new Set(['income', 'transfer']);

// GET /api/insights
app.get('/api/insights', requireAuth, async (req, res, next) => {
  try {
    const rows = await db.all(
      `SELECT t.amount_cents, t.status, t.created_at, m.name AS merchant, m.category AS category
       FROM transactions t JOIN merchants m ON m.id = t.merchant_id
       WHERE t.user_id = ? AND t.status IN ('succeeded','pending')
       ORDER BY t.created_at DESC
       LIMIT 500`,
      [req.user.id]
    );

    const byCat = new Map();
    const byMonth = new Map();
    let income = 0, spend = 0;
    for (const r of rows) {
      const amt = num(r.amount_cents);
      const month = String(r.created_at).slice(0, 7); // YYYY-MM
      if (INCOME_CATEGORIES.has(r.category)) {
        income += amt;
      } else {
        spend += amt;
        byCat.set(r.category, (byCat.get(r.category) || 0) + amt);
        byMonth.set(month, (byMonth.get(month) || 0) + amt);
      }
    }
    const spend_by_category = [...byCat.entries()]
      .map(([category, amount_cents]) => ({ category, amount_cents }))
      .sort((a, b) => b.amount_cents - a.amount_cents);
    const month_over_month = [...byMonth.entries()]
      .map(([month, amount_cents]) => ({ month, amount_cents }))
      .sort((a, b) => a.month.localeCompare(b.month));

    const subs = await db.all(
      `SELECT merchant_name, amount_cents, next_charge_at FROM subscriptions
       WHERE user_id = ? AND status = 'active' AND next_charge_at IS NOT NULL
       ORDER BY next_charge_at LIMIT 10`,
      [req.user.id]
    );
    const upcoming_bills = subs.map((s) => ({
      merchant: s.merchant_name, amount_cents: num(s.amount_cents), due_at: s.next_charge_at,
    }));

    res.json({ spend_by_category, month_over_month, upcoming_bills, income_cents: income, spend_cents: spend });
  } catch (err) { next(err); }
});

// POST /api/transactions/:id/dispute -> records a dispute on a txn
app.post('/api/transactions/:id/dispute', requireAuth, async (req, res, next) => {
  try {
    const txn = await db.get('SELECT * FROM transactions WHERE id = ?', [req.params.id]);
    if (!txn) return res.status(404).json({ error: 'transaction not found' });
    const reason = (req.body && req.body.reason) || 'customer dispute';
    let flagged = false;
    try { await db.run("UPDATE transactions SET status = 'disputed' WHERE id = ?", [txn.id]); flagged = true; } catch { /* ledger may be read-only */ }
    // Record it as a resolved/open alert so it surfaces in the activity feed.
    await db.run(
      `INSERT INTO alerts (user_id, kind, severity, title, detail, txn_id, card_id, status, action_taken, created_at)
       VALUES (?, 'suspicious_charge', 'medium', ?, ?, ?, NULL, 'resolved', 'dispute', ?)`,
      [req.user.id, 'Transaction disputed', `Dispute filed: ${reason}`, txn.id, new Date().toISOString()]
    );
    res.json({ ok: true, transaction_id: Number(txn.id), status: flagged ? 'disputed' : txn.status, reason });
  } catch (err) { next(err); }
});

// Serve the MyFiat online-banking web UI (static HTML/CSS/JS) from public/.
// Registered after the API routes so it only handles asset/page requests.
app.use(express.static(path.join(__dirname, '../public')));

// Global error handler - also verbose (VULN #4).
app.use((err, _req, res, _next) => {
  res.status(500).json({ error: err.message, stack: err.stack });
});

const server = app.listen(config.port, () => {
  console.log(`[myfiat] listening on http://0.0.0.0:${config.port} (env=${config.env}, safeSearch=${config.safeSearch})`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));

export { app, server };
