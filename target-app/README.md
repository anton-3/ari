# MyFiat

A small, production-looking **online-banking + payments REST API** for a
clearly-fictional demo bank. Node.js + Express + SQLite (`better-sqlite3`), with
optional PostgreSQL (`DATABASE_URL`) and Redis (`REDIS_URL`).

> 🏦 **Not a real bank.** MyFiat is a hackathon demo. All users, balances,
> cards, transactions and holdings are **synthetic**.

> ⚠️ **DEMO SECURITY TARGET — intentional vulnerabilities inside.**
> MyFiat is the sample application watched over by **Ari**, an autonomous AI
> security engineer, in a controlled hackathon demo. It **deliberately** contains
> security weaknesses for Ari to discover and fix. **Do not** run it with real
> data or expose it to the public internet. The full list of planted issues
> (the "answer key") is in [`SECURITY-NOTES.md`](./SECURITY-NOTES.md).

## Quick start

```bash
cd target-app
npm install          # compiles better-sqlite3 native addon
npm run seed         # create + populate data/myfiat.db
npm start            # listens on http://localhost:8070
```

No API keys are required. The markets feature makes an outbound call to the
free CoinGecko public API for live crypto prices; it falls back to an in-code
quote table if that call fails, so the app runs fully offline too.

### Configuration (env vars)

| Var                   | Default            | Purpose                                                      |
|-----------------------|--------------------|--------------------------------------------------------------|
| `PORT`                | `8070`             | HTTP port                                                    |
| `NODE_ENV`            | `production`       | Environment label                                            |
| `MYFIAT_DB`           | `data/myfiat.db`   | SQLite file path (legacy `ACMEPAY_DB` still honored)         |
| `MYFIAT_SAFE_SEARCH`  | *(unset)*          | `1` → use the **fixed** parameterized search (kills SQLi #1) |
| `DATABASE_URL`        | *(unset)*          | Use PostgreSQL instead of SQLite                             |
| `REDIS_URL`           | *(unset)*          | Enable the optional short-TTL cache / request counter        |

## Demo logins

| Email (original)     | Email (MyFiat alias) | Password   | User                 |
|----------------------|----------------------|------------|----------------------|
| `admin@acmepay.io`   | `dana@myfiat.com`    | `admin123` | Dana Admin (id 1)    |
| `demo@acmepay.io`    | `avery@myfiat.com`   | `demo1234` | Avery Demo (id 2)    |

Both the original and the aliased emails resolve to the same user id.

## Auth

`POST /api/login` returns a Bearer `token`. All `/api/*` banking endpoints below
(everything except the legacy `/api/users/:id`, `/api/transactions`,
`/api/payments`, `/api/merchants`) require `Authorization: Bearer <token>` and
derive the user id from it.

## Endpoints

| Method | Path                               | Auth | Description                                   |
|--------|------------------------------------|------|-----------------------------------------------|
| GET    | `/`                                | no   | HTML landing page                             |
| GET    | `/health`                          | no   | Health check JSON                             |
| POST   | `/api/login`                       | no   | Authenticate `{ email, password }`            |
| GET    | `/api/users/:id`                   | no   | Fetch a user profile *(intentional IDOR)*     |
| GET    | `/api/transactions?user=&status=`  | no   | Search the ledger *(intentional SQLi)*        |
| POST   | `/api/payments`                    | no   | Create a payment                              |
| GET    | `/api/merchants`                   | no   | List merchant accounts                        |
| GET    | `/api/me`                          | yes  | Current user, accounts, net-worth totals      |
| GET    | `/api/accounts`                    | yes  | Accounts for the user                         |
| GET    | `/api/cards`                       | yes  | Cards for the user                            |
| POST   | `/api/cards/:id/renew`             | yes  | Renew a card (+3 yrs, new last4, active)      |
| POST   | `/api/cards/:id/freeze`            | yes  | Freeze a card                                 |
| POST   | `/api/cards/:id/unfreeze`          | yes  | Unfreeze a card                               |
| GET    | `/api/subscriptions`               | yes  | Subscriptions + computed monthly total        |
| POST   | `/api/subscriptions/:id/cancel`    | yes  | Cancel a subscription                         |
| GET    | `/api/holdings`                    | yes  | Investment portfolio (live crypto prices)     |
| GET    | `/api/crypto/prices`               | yes  | Live (cached) crypto prices + `source` flag   |
| POST   | `/api/trade`                       | yes  | Mock buy/sell (updates holdings + cash)       |
| GET    | `/api/trades`                      | yes  | Recent trades for the user                    |
| GET    | `/api/alerts`                      | yes  | Open + recent alerts                          |
| POST   | `/api/alerts/:id/resolve`          | yes  | Resolve an alert `{ action }`                 |
| GET    | `/api/insights`                    | yes  | Spend-by-category, MoM, upcoming bills        |
| POST   | `/api/transactions/:id/dispute`    | yes  | File a dispute on a transaction               |

### Example requests

```bash
curl localhost:8070/health
TOKEN=$(curl -s -X POST localhost:8070/api/login -H 'Content-Type: application/json' \
  -d '{"email":"avery@myfiat.com","password":"demo1234"}' | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).token))')

curl localhost:8070/api/me        -H "Authorization: Bearer $TOKEN"
curl localhost:8070/api/holdings  -H "Authorization: Bearer $TOKEN"
curl localhost:8070/api/crypto/prices -H "Authorization: Bearer $TOKEN"
curl -X POST localhost:8070/api/trade -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"asset_class":"crypto","symbol":"SOL","side":"buy","quantity":5}'
```

## Data model

The **core tables owned by the bulk loader / security demo are never altered**:
`users`, `merchants`, `transactions`. The banking features add new tables only:
`accounts`, `cards`, `subscriptions`, `holdings`, `alerts`, `trades`. Every
`created_at` is ISO-8601 TEXT. Balances live in `accounts.balance_cents`;
`users.balance_cents` is left intact for the loader.

## Project layout

```
target-app/
├── package.json
├── seed.js              # seed script (node seed.js [--force])
├── src/
│   ├── config.js        # config + (intentionally) hard-coded secrets
│   ├── db.js            # schema + connection (SQLite / Postgres)
│   ├── cache.js         # optional Redis cache
│   └── server.js        # Express app + all endpoints
├── public/              # banking web UI (owned by the UI agent)
├── data/                # SQLite DB lives here (gitignored)
├── README.md
└── SECURITY-NOTES.md    # <-- planted-vulnerability answer key
```

## Security

This app is intentionally insecure for the demo. See
[`SECURITY-NOTES.md`](./SECURITY-NOTES.md) for each planted vulnerability with
`file:line`, impact, proof-of-concept, and fix.
