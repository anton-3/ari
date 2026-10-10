/*
 * AcmePay - seed script. Populates the SQLite DB with realistic sample data:
 *   ~20 users, a handful of merchants, ~50 transactions.
 * Idempotent-ish: pass --force to wipe and reseed.
 * DEMO security target. See SECURITY-NOTES.md.
 */
import crypto from 'node:crypto';
import { getDb, initSchema, isSeeded } from './src/db.js';

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const iso = (d) => new Date(d).toISOString();

const MERCHANTS = [
  { name: 'Blue Bottle Coffee', category: 'food_and_drink', country: 'US' },
  { name: 'Northwind Electronics', category: 'retail', country: 'US' },
  { name: 'Contoso Cloud Hosting', category: 'software', country: 'IE' },
  { name: 'Fabrikam Logistics', category: 'shipping', country: 'DE' },
  { name: 'Globex Airlines', category: 'travel', country: 'US' },
  { name: 'Initech Payroll', category: 'business_services', country: 'US' },
  { name: 'Umbrella Pharmacy', category: 'healthcare', country: 'GB' },
];

const FIRST = ['James','Maria','Wei','Aisha','Carlos','Priya','Tom','Sofia','Liam','Noor',
  'Hiro','Elena','David','Fatima','Kenji','Grace','Omar','Lena','Victor','Chloe'];
const LAST = ['Walker','Santos','Chen','Khan','Reyes','Patel','Nguyen','Rossi','Murphy','Haddad',
  'Tanaka','Petrov','Cohen','Ali','Yamamoto','Okafor','Farah','Novak','Silva','Dubois'];

function reseed(force) {
  const db = getDb();
  initSchema(db);

  if (isSeeded(db) && !force) {
    console.log('DB already seeded. Use "node seed.js --force" to wipe and reseed.');
    return;
  }

  db.exec('DELETE FROM transactions; DELETE FROM users; DELETE FROM merchants;');

  const insMerchant = db.prepare(
    'INSERT INTO merchants (name, category, country, created_at) VALUES (?, ?, ?, ?)'
  );
  const merchantIds = [];
  const seedMerchants = db.transaction(() => {
    for (const m of MERCHANTS) {
      const info = insMerchant.run(m.name, m.category, m.country, iso('2023-01-15'));
      merchantIds.push(info.lastInsertRowid);
    }
  });
  seedMerchants();

  const insUser = db.prepare(`INSERT INTO users
    (email, full_name, password_md5, role, ssn_last4, card_last4, balance_cents, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const userIds = [];
  const seedUsers = db.transaction(() => {
    // Known admin account for the demo (weak, well-known password).
    const adminId = insUser.run(
      'admin@acmepay.io', 'Dana Admin', md5('admin123'), 'admin',
      '0007', '4242', 500000, iso('2023-02-01')
    ).lastInsertRowid;
    userIds.push(adminId);

    for (let i = 0; i < 19; i++) {
      const fn = FIRST[i % FIRST.length];
      const ln = LAST[(i * 3) % LAST.length];
      const email = `${fn.toLowerCase()}.${ln.toLowerCase()}${i}@example.com`;
      const pw = ['password1','qwerty','letmein','hunter2','sunshine'][i % 5];
      const id = insUser.run(
        email, `${fn} ${ln}`, md5(pw), 'customer',
        String(1000 + i).slice(-4), String(4000 + i).slice(-4),
        Math.floor(Math.random() * 400000), iso(`2023-${String((i % 12) + 1).padStart(2,'0')}-10`)
      ).lastInsertRowid;
      userIds.push(id);
    }
  });
  seedUsers();

  const insTx = db.prepare(`INSERT INTO transactions
    (user_id, merchant_id, amount_cents, currency, status, description, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const statuses = ['succeeded','succeeded','succeeded','pending','failed','refunded'];
  const descs = ['Order #', 'Invoice #', 'Subscription renewal #', 'Top-up #', 'Payout #'];
  const seedTx = db.transaction(() => {
    for (let i = 0; i < 52; i++) {
      const uid = userIds[i % userIds.length];
      const mid = merchantIds[(i * 2) % merchantIds.length];
      const amount = (Math.floor(Math.random() * 20000) + 100);
      const status = statuses[i % statuses.length];
      const desc = descs[i % descs.length] + (10000 + i);
      const day = String((i % 27) + 1).padStart(2, '0');
      insTx.run(uid, mid, amount, 'USD', status, desc, iso(`2024-0${(i % 9) + 1}-${day}`));
    }
  });
  seedTx();

  const counts = {
    merchants: db.prepare('SELECT COUNT(*) n FROM merchants').get().n,
    users: db.prepare('SELECT COUNT(*) n FROM users').get().n,
    transactions: db.prepare('SELECT COUNT(*) n FROM transactions').get().n,
  };
  console.log('Seed complete:', counts);
}

reseed(process.argv.includes('--force'));
