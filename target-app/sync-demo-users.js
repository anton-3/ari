// Copy the demo logins (Dana, Avery) from a seeded SQLite DB into the fleet's Postgres,
// replacing only those users' rows. Everyone else's data (the bulk-loaded ledger) is untouched.
//
//   node seed.js --force                          # fresh demo state in data/myfiat.db
//   DATABASE_URL=postgres://... node sync-demo-users.js [path/to/myfiat.db]
import Database from 'better-sqlite3';
import pg from 'pg';

const DEMO_EMAILS = ['admin@acmepay.io', 'demo@acmepay.io'];
const src = new Database(process.argv[2] || new URL('./data/myfiat.db', import.meta.url).pathname, { readonly: true });
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();

const cols = (table) => src.prepare(`SELECT name FROM pragma_table_info(?)`).all(table).map((c) => c.name).filter((c) => c !== 'id');
async function insert(table, row) {
  const keys = Object.keys(row);
  const r = await db.query(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`, keys.map((k) => row[k]));
  return r.rows[0].id;
}
const pick = (row, table) => Object.fromEntries(cols(table).map((c) => [c, row[c]]));

// Merchants by name (the demo transactions reference a few the bulk loader may not have).
const merchantId = {};
for (const m of src.prepare('SELECT * FROM merchants').all()) {
  const found = await db.query('SELECT id FROM merchants WHERE name = $1 ORDER BY id LIMIT 1', [m.name]);
  merchantId[m.id] = found.rows[0]?.id ?? await insert('merchants', pick(m, 'merchants'));
}

await db.query('BEGIN');
try {
  for (const email of DEMO_EMAILS) {
    const user = src.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) throw new Error(`${email} not in source DB (run node seed.js --force first)`);
    let uid = (await db.query('SELECT id FROM users WHERE email = $1', [email])).rows[0]?.id;
    if (uid) {
      await db.query(`UPDATE users SET full_name=$2, password_md5=$3, role=$4, ssn_last4=$5, card_last4=$6, balance_cents=$7 WHERE id=$1`,
        [uid, user.full_name, user.password_md5, user.role, user.ssn_last4, user.card_last4, user.balance_cents]);
      for (const t of ['trades', 'alerts', 'holdings', 'subscriptions', 'cards', 'accounts', 'transactions']) {
        await db.query(`DELETE FROM ${t} WHERE user_id = $1`, [uid]);
      }
    } else {
      uid = await insert('users', pick(user, 'users'));
    }
    const ids = { accounts: {}, cards: {}, transactions: {} };
    for (const table of ['accounts', 'cards', 'transactions', 'subscriptions', 'holdings', 'trades', 'alerts']) {
      for (const row of src.prepare(`SELECT * FROM ${table} WHERE user_id = ? ORDER BY id`).all(user.id)) {
        const out = { ...pick(row, table), user_id: uid };
        if ('account_id' in out) out.account_id = ids.accounts[row.account_id] ?? null;
        if ('merchant_id' in out) out.merchant_id = merchantId[row.merchant_id];
        if ('card_id' in out && row.card_id != null) out.card_id = ids.cards[row.card_id] ?? null;
        if ('txn_id' in out && row.txn_id != null) out.txn_id = ids.transactions[row.txn_id] ?? null;
        const id = await insert(table, out);
        if (ids[table]) ids[table][row.id] = id;
      }
    }
    console.log(`${email} -> user ${uid}: ${Object.values(ids.transactions).length} transactions, ${Object.values(ids.cards).length} cards`);
  }
  await db.query('COMMIT');
} catch (err) {
  await db.query('ROLLBACK');
  throw err;
} finally {
  await db.end();
}
