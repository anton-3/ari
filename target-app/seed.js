/*
 * MyFiat - seed script. Populates the DB (SQLite, or Postgres when DATABASE_URL
 * is set) with realistic FICTIONAL sample data for the demo bank:
 *   ~20 users, 16 merchants, ~90 transactions, plus the MyFiat online-banking
 *   feature data: accounts, cards, subscriptions, investment holdings, alerts.
 * Idempotent-ish: pass --force to wipe and reseed.
 * DEMO security target. See SECURITY-NOTES.md. MyFiat is NOT a real bank; all
 * data is synthetic.
 */
import crypto from 'node:crypto';
import { getDb, initSchema, isSeeded } from './src/db.js';

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const iso = (d) => new Date(d).toISOString();

// Anchor dates to a fixed recent window so the demo ledger always looks current.
const NOW = new Date('2026-10-09T17:30:00Z');
const daysAgo = (n, h = 12, m = 0) => {
  const d = new Date(NOW);
  d.setUTCDate(d.getUTCDate() - n);
  d.setUTCHours(h, m, 0, 0);
  return iso(d);
};
const daysFromNow = (n, h = 9, m = 0) => {
  const d = new Date(NOW);
  d.setUTCDate(d.getUTCDate() + n);
  d.setUTCHours(h, m, 0, 0);
  return iso(d);
};
// Next-month expiry for the "card expiring soon / renew card" demo.
const nextMonth = (() => {
  const d = new Date(NOW);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return { month: d.getUTCMonth() + 1, year: d.getUTCFullYear() };
})();

// Fictional merchants only. "income"/"transfer" categories are treated as
// credits (money in) by the web UI; everything else is a debit (money out).
const MERCHANTS = [
  { name: 'Blue Bottle Coffee',     category: 'food_and_drink',    country: 'US' },
  { name: 'Greenleaf Grocery',      category: 'groceries',         country: 'US' },
  { name: 'Northwind Electronics',  category: 'retail',            country: 'US' },
  { name: 'Streamly',               category: 'entertainment',     country: 'US' },
  { name: 'RideNow',                category: 'transport',         country: 'US' },
  { name: 'Lumen Energy',           category: 'utilities',         country: 'US' },
  { name: 'Stark Mobile',           category: 'telecom',           country: 'US' },
  { name: 'Wayne Property Mgmt',    category: 'housing',           country: 'US' },
  { name: 'Vantage Fitness',        category: 'fitness',           country: 'US' },
  { name: 'Umbrella Pharmacy',      category: 'healthcare',        country: 'GB' },
  { name: 'Globex Airlines',        category: 'travel',            country: 'US' },
  { name: 'Contoso Cloud',          category: 'software',          country: 'IE' },
  { name: 'Fabrikam Home',          category: 'retail',            country: 'DE' },
  { name: 'Soylent Diner',          category: 'food_and_drink',    country: 'US' },
  { name: 'Initech Payroll',        category: 'income',            country: 'US' },
  { name: 'MyFiat Transfer',        category: 'transfer',          country: 'US' },
];

const FIRST = ['James','Maria','Wei','Aisha','Carlos','Priya','Tom','Sofia','Liam','Noor',
  'Hiro','Elena','David','Fatima','Kenji','Grace','Omar','Lena','Victor','Chloe'];
const LAST = ['Walker','Santos','Chen','Khan','Reyes','Patel','Nguyen','Rossi','Murphy','Haddad',
  'Tanaka','Petrov','Cohen','Ali','Yamamoto','Okafor','Farah','Novak','Silva','Dubois'];

const STATUSES = ['succeeded','succeeded','succeeded','succeeded','pending','failed','refunded'];

async function reseed(force) {
  const db = await getDb();
  await initSchema(db);

  if ((await isSeeded(db)) && !force) {
    console.log('DB already seeded. Use "node seed.js --force" to wipe and reseed.');
    return;
  }

  // New feature tables first (FK-free, but tidy), then the core three.
  await db.exec('DELETE FROM trades; DELETE FROM alerts; DELETE FROM holdings; DELETE FROM subscriptions; DELETE FROM cards; DELETE FROM accounts;');
  await db.exec('DELETE FROM transactions; DELETE FROM users; DELETE FROM merchants;');

  // ---- merchants -------------------------------------------------------
  const mId = {};
  for (const m of MERCHANTS) {
    const info = await db.run(
      'INSERT INTO merchants (name, category, country, created_at) VALUES (?, ?, ?, ?)',
      [m.name, m.category, m.country, iso('2024-01-15')]
    );
    mId[m.name] = info.lastInsertRowid;
  }

  // ---- users -----------------------------------------------------------
  const insUser = (vals) => db.run(`INSERT INTO users
    (email, full_name, password_md5, role, ssn_last4, card_last4, balance_cents, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, vals);

  const userIds = [];
  const userBalances = [];
  // Fixed demo-login accounts (stable email + well-known password) so sign-in
  // is reliable on stage. The original acmepay.io emails keep working; nicer
  // MyFiat-brand aliases (dana@myfiat.com / avery@myfiat.com) are resolved in
  // the login handler. Weak MD5 hashing is intentional (SECURITY-NOTES.md).
  userIds.push((await insUser([
    'admin@acmepay.io', 'Dana Admin', md5('admin123'), 'admin',
    '0007', '4242', 845217, iso('2023-02-01'),
  ])).lastInsertRowid);
  userBalances.push(845217);
  userIds.push((await insUser([
    'demo@acmepay.io', 'Avery Demo', md5('demo1234'), 'customer',
    '3321', '1881', 1243908, iso('2023-03-12'),
  ])).lastInsertRowid);
  userBalances.push(1243908);

  for (let i = 0; i < 18; i++) {
    const fn = FIRST[i % FIRST.length];
    const ln = LAST[(i * 3) % LAST.length];
    const email = `${fn.toLowerCase()}.${ln.toLowerCase()}${i}@example.com`;
    const pw = ['password1','qwerty','letmein','hunter2','sunshine'][i % 5];
    const bal = Math.floor(Math.random() * 850000) + 15000;
    const info = await insUser([
      email, `${fn} ${ln}`, md5(pw), 'customer',
      String(1000 + i).slice(-4), String(4000 + i).slice(-4),
      bal,
      iso(`2023-${String((i % 12) + 1).padStart(2,'0')}-10`),
    ]);
    userIds.push(info.lastInsertRowid);
    userBalances.push(bal);
  }
  const adminId = userIds[0];
  const demoId = userIds[1];

  // ---- transactions ----------------------------------------------------
  const txns = [];
  const push = (userId, merchant, amount_cents, status, description, created_at) =>
    txns.push([userId, mId[merchant], amount_cents, 'USD', status, description, created_at]);

  // A curated, believable month of activity for the demo account (Dana).
  push(adminId, 'Initech Payroll',   312450, 'succeeded', 'Payroll deposit — Initech Inc', daysAgo(1, 6, 2));
  push(adminId, 'Blue Bottle Coffee',    675, 'succeeded', 'Blue Bottle Coffee — Hayes Valley', daysAgo(1, 8, 14));
  push(adminId, 'Greenleaf Grocery',    8432, 'succeeded', 'Greenleaf Grocery — weekly shop', daysAgo(2, 18, 41));
  push(adminId, 'RideNow',              1890, 'succeeded', 'RideNow trip — downtown', daysAgo(2, 9, 3));
  push(adminId, 'Streamly',             1599, 'succeeded', 'Streamly monthly subscription', daysAgo(3, 0, 5));
  push(adminId, 'Soylent Diner',        4225, 'succeeded', 'Soylent Diner — dinner', daysAgo(4, 20, 12));
  push(adminId, 'Blue Bottle Coffee',    550, 'succeeded', 'Blue Bottle Coffee — Ferry Building', daysAgo(5, 8, 22));
  push(adminId, 'MyFiat Transfer',     25000, 'succeeded', 'Transfer to savings', daysAgo(6, 10, 0));
  push(adminId, 'Stark Mobile',         7500, 'succeeded', 'Stark Mobile — monthly plan', daysAgo(7, 7, 30));
  push(adminId, 'Vantage Fitness',      4900, 'succeeded', 'Vantage Fitness membership', daysAgo(8, 6, 15));
  push(adminId, 'Northwind Electronics',34999,'pending',   'Northwind Electronics — order #NW-77421', daysAgo(2, 15, 48));
  push(adminId, 'Umbrella Pharmacy',    2310, 'succeeded', 'Umbrella Pharmacy — prescription', daysAgo(9, 11, 9));
  push(adminId, 'Lumen Energy',         9845, 'succeeded', 'Lumen Energy — electricity', daysAgo(11, 9, 0));
  push(adminId, 'Wayne Property Mgmt',185000, 'succeeded', 'Rent — Oct 2026', daysAgo(12, 7, 0));
  push(adminId, 'Globex Airlines',     48620, 'succeeded', 'Globex Airlines — SFO→JFK', daysAgo(14, 13, 27));
  push(adminId, 'Greenleaf Grocery',    6178, 'succeeded', 'Greenleaf Grocery — weekly shop', daysAgo(9, 17, 55));
  push(adminId, 'Northwind Electronics',12999,'refunded',  'Refund — returned headphones', daysAgo(10, 14, 2));
  push(adminId, 'Soylent Diner',        3180, 'failed',    'Soylent Diner — card declined', daysAgo(6, 21, 18));
  push(adminId, 'Blue Bottle Coffee',    675, 'succeeded', 'Blue Bottle Coffee — Hayes Valley', daysAgo(13, 8, 11));
  push(adminId, 'Initech Payroll',    312450, 'succeeded', 'Payroll deposit — Initech Inc', daysAgo(15, 6, 2));
  push(adminId, 'Contoso Cloud',        2400, 'succeeded', 'Contoso Cloud — hosting', daysAgo(16, 3, 0));

  // A curated month for the primary customer demo account (Avery / demo@).
  push(demoId, 'Initech Payroll',     268900, 'succeeded', 'Payroll deposit — Initech Inc', daysAgo(2, 6, 10));
  push(demoId, 'Blue Bottle Coffee',     640, 'succeeded', 'Blue Bottle Coffee — Mission', daysAgo(1, 9, 5));
  push(demoId, 'Greenleaf Grocery',     7120, 'succeeded', 'Greenleaf Grocery — weekly shop', daysAgo(3, 18, 20));
  push(demoId, 'Streamly',              1599, 'succeeded', 'Streamly monthly subscription', daysAgo(4, 0, 5));
  push(demoId, 'Vantage Fitness',       3900, 'succeeded', 'Vantage Fitness membership', daysAgo(5, 6, 15));
  push(demoId, 'Stark Mobile',          6500, 'succeeded', 'Stark Mobile — monthly plan', daysAgo(6, 7, 30));
  push(demoId, 'Lumen Energy',          8210, 'succeeded', 'Lumen Energy — electricity', daysAgo(8, 9, 0));
  push(demoId, 'Wayne Property Mgmt', 162000, 'succeeded', 'Rent — Oct 2026', daysAgo(12, 7, 0));
  push(demoId, 'RideNow',               2240, 'succeeded', 'RideNow trip — airport', daysAgo(7, 19, 40));
  push(demoId, 'Soylent Diner',         3560, 'succeeded', 'Soylent Diner — dinner', daysAgo(9, 20, 12));
  push(demoId, 'Contoso Cloud',          999, 'succeeded', 'Contoso Cloud — storage', daysAgo(10, 3, 0));
  push(demoId, 'Initech Payroll',     268900, 'succeeded', 'Payroll deposit — Initech Inc', daysAgo(16, 6, 10));

  // Procedural but realistic activity for the rest of the customers.
  const consumerMerchants = [
    'Blue Bottle Coffee','Greenleaf Grocery','Northwind Electronics','Streamly','RideNow',
    'Lumen Energy','Stark Mobile','Vantage Fitness','Umbrella Pharmacy','Globex Airlines',
    'Fabrikam Home','Soylent Diner',
  ];
  const descFor = {
    'Blue Bottle Coffee': 'Blue Bottle Coffee',
    'Greenleaf Grocery': 'Greenleaf Grocery — weekly shop',
    'Northwind Electronics': 'Northwind Electronics — online order',
    'Streamly': 'Streamly subscription',
    'RideNow': 'RideNow trip',
    'Lumen Energy': 'Lumen Energy — utilities',
    'Stark Mobile': 'Stark Mobile — monthly plan',
    'Vantage Fitness': 'Vantage Fitness membership',
    'Umbrella Pharmacy': 'Umbrella Pharmacy',
    'Globex Airlines': 'Globex Airlines — flight',
    'Fabrikam Home': 'Fabrikam Home — order',
    'Soylent Diner': 'Soylent Diner',
  };
  let seqDay = 0;
  for (let i = 2; i < userIds.length; i++) {
    const uid = userIds[i];
    // monthly paycheck
    push(uid, 'Initech Payroll', 180000 + Math.floor(Math.random() * 220000), 'succeeded',
      'Payroll deposit', daysAgo((i % 20) + 1, 6, 5));
    const n = 2 + (i % 3);
    for (let k = 0; k < n; k++) {
      const merchant = consumerMerchants[(i + k * 3) % consumerMerchants.length];
      const amount = 400 + Math.floor(Math.random() * 42000);
      const status = STATUSES[(i + k) % STATUSES.length];
      seqDay = (seqDay + 3) % 28;
      push(uid, merchant, amount, status, descFor[merchant], daysAgo(seqDay + 1, (7 + k) % 22, (i * 7) % 60));
    }
  }

  for (const t of txns) {
    await db.run(`INSERT INTO transactions
      (user_id, merchant_id, amount_cents, currency, status, description, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, t);
  }

  // Two dedicated "suspicious" charges (captured ids) so the fraud/alert flow
  // and the customer-Ari suspicious-charge call have real transactions to cite.
  const addTxn = async (userId, merchant, amount, status, desc, created) => {
    const info = await db.run(`INSERT INTO transactions
      (user_id, merchant_id, amount_cents, currency, status, description, created_at)
      VALUES (?, ?, ?, 'USD', ?, ?, ?)`, [userId, mId[merchant], amount, status, desc, created]);
    return info.lastInsertRowid;
  };
  const adminSuspiciousTxnId = await addTxn(
    adminId, 'Fabrikam Home', 94250, 'succeeded',
    'Fabrikam Home — card-not-present (Berlin, DE)', daysAgo(0, 3, 12));
  const demoSuspiciousTxnId = await addTxn(
    demoId, 'Northwind Electronics', 128400, 'succeeded',
    'Northwind Electronics — order #NW-99812 (new device)', daysAgo(0, 4, 48));

  // ---- accounts --------------------------------------------------------
  const insAccount = async (userId, kind, name, mask, balance, apy) => {
    const info = await db.run(
      `INSERT INTO accounts (user_id, kind, name, mask, balance_cents, apy_bps, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [userId, kind, name, mask, balance, apy, iso('2023-04-01')]
    );
    return info.lastInsertRowid;
  };

  // Rich demo accounts for Dana (id 1) and Avery (id 2). Checking balance
  // mirrors users.balance_cents (which the bulk loader owns & we leave intact).
  const adminChecking = await insAccount(adminId, 'checking', 'MyFiat Checking', '••4242', 845217, 10);
  await insAccount(adminId, 'savings', 'MyFiat Savings', '••8801', 3120500, 410);
  const adminCredit = await insAccount(adminId, 'credit', 'MyFiat Platinum Card', '••7781', -84230, 0);

  const demoChecking = await insAccount(demoId, 'checking', 'MyFiat Checking', '••1881', 1243908, 10);
  await insAccount(demoId, 'savings', 'MyFiat Savings', '••5520', 560000, 410);
  const demoCredit = await insAccount(demoId, 'credit', 'MyFiat Rewards Card', '••3390', -31990, 0);

  // Lighter accounts for every generated customer (checking + savings).
  for (let i = 2; i < userIds.length; i++) {
    const bal = userBalances[i];
    await insAccount(userIds[i], 'checking', 'MyFiat Checking', '••' + String(4000 + (i - 2)).slice(-4), bal, 10);
    await insAccount(userIds[i], 'savings', 'MyFiat Savings', '••' + String(7000 + (i - 2)).slice(-4), Math.floor(bal * 0.6), 410);
  }

  // ---- cards -----------------------------------------------------------
  const insCard = async (userId, accountId, brand, last4, expM, expY, status, kind) => {
    const info = await db.run(
      `INSERT INTO cards (user_id, account_id, brand, last4, exp_month, exp_year, status, kind, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, accountId, brand, last4, expM, expY, status, kind, iso('2023-04-01')]
    );
    return info.lastInsertRowid;
  };

  // Dana: a debit card + a credit card that EXPIRES NEXT MONTH (renew demo).
  await insCard(adminId, adminChecking, 'visa', '4242', 12, 2028, 'active', 'debit');
  const adminExpiringCardId = await insCard(adminId, adminCredit, 'mastercard', '7781', nextMonth.month, nextMonth.year, 'active', 'credit');

  // Avery: a debit card that EXPIRES NEXT MONTH + an active credit card.
  const demoExpiringCardId = await insCard(demoId, demoChecking, 'visa', '1881', nextMonth.month, nextMonth.year, 'active', 'debit');
  await insCard(demoId, demoCredit, 'mastercard', '3390', 9, 2027, 'active', 'credit');

  // ---- subscriptions (demo users) -------------------------------------
  const SUBS_DANA = [
    ['Streamly',          1599, 'monthly', 'entertainment', daysFromNow(5)],
    ['Vantage Fitness',   4900, 'monthly', 'fitness',       daysFromNow(9)],
    ['Contoso Cloud',      999, 'monthly', 'software',       daysFromNow(12)],
    ['Stark Mobile',      7500, 'monthly', 'telecom',        daysFromNow(3)],
    ['Daily Ledger News',  899, 'monthly', 'news',           daysFromNow(18)],
    ['Harmoniq Music',    1099, 'monthly', 'entertainment',  daysFromNow(7)],
    ['Globex Prime',      13900,'yearly',  'shopping',       daysFromNow(44)],
    ['CloudVault Backup',  599, 'monthly', 'software',       daysFromNow(21)],
  ];
  const SUBS_AVERY = [
    ['Streamly',          1599, 'monthly', 'entertainment', daysFromNow(6)],
    ['Harmoniq Music',    1099, 'monthly', 'entertainment', daysFromNow(10)],
    ['Vantage Fitness',   3900, 'monthly', 'fitness',       daysFromNow(14)],
    ['Daily Ledger News',  899, 'monthly', 'news',          daysFromNow(2)],
    ['CloudVault Backup',  599, 'monthly', 'software',      daysFromNow(16)],
    ['Lumen Energy',      8210, 'monthly', 'utilities',     daysFromNow(4)],
    ['BrightMind Learning',2400,'monthly', 'education',     daysFromNow(25)],
    ['Globex Prime',     13900, 'yearly',  'shopping',      daysFromNow(60)],
  ];
  const insSub = (userId, s) => db.run(
    `INSERT INTO subscriptions (user_id, merchant_name, amount_cents, cadence, next_charge_at, status, category, created_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`,
    [userId, s[0], s[1], s[2], s[4], s[3], iso('2024-06-01')]
  );
  for (const s of SUBS_DANA) await insSub(adminId, s);
  for (const s of SUBS_AVERY) await insSub(demoId, s);

  // ---- holdings (demo users) ------------------------------------------
  const HOLD_DANA = [
    ['stock',  'AAPL', 'Apple Inc.',            42,   798000],
    ['stock',  'NVDA', 'NVIDIA Corp.',          60,   612000],
    ['stock',  'VTI',  'Vanguard Total Market', 120,  3180000],
    ['stock',  'MSFT', 'Microsoft Corp.',       15,   540000],
    ['crypto', 'BTC',  'Bitcoin',               0.35, 2100000],
    ['crypto', 'ETH',  'Ethereum',              3.2,  960000],
    ['crypto', 'SOL',  'Solana',                45,   630000],
  ];
  const HOLD_AVERY = [
    ['stock',  'AAPL', 'Apple Inc.',            10,  195000],
    ['stock',  'VTI',  'Vanguard Total Market', 25,  690000],
    ['stock',  'TSLA', 'Tesla Inc.',            8,   180000],
    ['crypto', 'BTC',  'Bitcoin',               0.08, 480000],
    ['crypto', 'ETH',  'Ethereum',              1.5,  450000],
    ['crypto', 'SOL',  'Solana',                20,   280000],
    ['crypto', 'DOGE', 'Dogecoin',              5000, 50000],
  ];
  const insHold = (userId, h) => db.run(
    `INSERT INTO holdings (user_id, asset_class, symbol, name, quantity, cost_basis_cents, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [userId, h[0], h[1], h[2], h[3], h[4], iso('2023-08-01')]
  );
  for (const h of HOLD_DANA) await insHold(adminId, h);
  for (const h of HOLD_AVERY) await insHold(demoId, h);

  // ---- alerts (open items for the demo users) -------------------------
  const insAlert = (userId, kind, severity, title, detail, txnId, cardId) => db.run(
    `INSERT INTO alerts (user_id, kind, severity, title, detail, txn_id, card_id, status, action_taken, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?)`,
    [userId, kind, severity, title, detail, txnId ?? null, cardId ?? null, daysAgo(0, 5, 0)]
  );
  // Dana: a suspicious charge tied to a real txn + a card expiring next month.
  await insAlert(adminId, 'suspicious_charge', 'high',
    'Unusual charge flagged',
    'A $942.50 card-not-present charge at Fabrikam Home (Berlin, DE) looks unusual for your account.',
    adminSuspiciousTxnId, null);
  await insAlert(adminId, 'card_expiring', 'medium',
    'Card ending 7781 expires next month',
    `Your MyFiat Platinum mastercard expires ${String(nextMonth.month).padStart(2,'0')}/${nextMonth.year}. Renew it to avoid interruptions.`,
    null, adminExpiringCardId);
  // Avery: a suspicious charge tied to a real txn + a card expiring next month.
  await insAlert(demoId, 'suspicious_charge', 'high',
    'Possible fraudulent charge',
    'A $1,284.00 charge at Northwind Electronics (new device) was flagged as possibly fraudulent.',
    demoSuspiciousTxnId, null);
  await insAlert(demoId, 'card_expiring', 'medium',
    'Card ending 1881 expires next month',
    `Your MyFiat debit visa expires ${String(nextMonth.month).padStart(2,'0')}/${nextMonth.year}. Renew it to avoid interruptions.`,
    null, demoExpiringCardId);

  // ---- trades (a few past fills for the demo users) -------------------
  // price_cents are plausible historical fills; live prices come from the
  // markets endpoint / quote engine at runtime.
  const insTrade = (userId, assetClass, symbol, side, qty, priceCents, created) => db.run(
    `INSERT INTO trades (user_id, asset_class, symbol, side, quantity, price_cents, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [userId, assetClass, symbol, side, qty, priceCents, created]
  );
  await insTrade(adminId, 'crypto', 'BTC', 'buy',  0.15, 5800000, daysAgo(40, 14, 2));
  await insTrade(adminId, 'crypto', 'ETH', 'buy',  2.0,  300000,  daysAgo(33, 10, 20));
  await insTrade(adminId, 'stock',  'NVDA','buy',  30,   102000,  daysAgo(27, 15, 5));
  await insTrade(adminId, 'crypto', 'SOL', 'sell', 10,   18900,   daysAgo(12, 11, 44));
  await insTrade(demoId,  'crypto', 'BTC', 'buy',  0.05, 6100000, daysAgo(21, 9, 30));
  await insTrade(demoId,  'crypto', 'DOGE','buy',  5000, 10,      daysAgo(18, 16, 12));
  await insTrade(demoId,  'stock',  'AAPL','buy',  10,   19500,   daysAgo(9, 13, 0));

  const count = async (t) => Number((await db.get(`SELECT COUNT(*) AS n FROM ${t}`)).n);
  console.log('Seed complete:', {
    merchants: await count('merchants'),
    users: await count('users'),
    transactions: await count('transactions'),
    accounts: await count('accounts'),
    cards: await count('cards'),
    subscriptions: await count('subscriptions'),
    holdings: await count('holdings'),
    alerts: await count('alerts'),
    trades: await count('trades'),
  });
}

await reseed(process.argv.includes('--force'));
const db = await getDb();
if (db.end) await db.end();
