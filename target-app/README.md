# AcmePay

A small, production-looking **payments / checkout REST API** for a fictional
fintech. Node.js + Express + SQLite (`better-sqlite3`).

> ⚠️ **DEMO SECURITY TARGET — intentional vulnerabilities inside.**
> AcmePay is the sample application watched over by **Ari**, an autonomous AI
> security engineer, in a controlled hackathon demo. It **deliberately** contains
> security weaknesses for Ari to discover and fix. **Do not** run it with real
> data or expose it to the public internet. The full list of planted issues
> (the "answer key") is in [`SECURITY-NOTES.md`](./SECURITY-NOTES.md).

## Quick start

```bash
cd target-app
npm install          # compiles better-sqlite3 native addon
npm run seed         # create + populate data/acmepay.db (20 users, 7 merchants, ~52 txns)
npm start            # listens on http://localhost:8070
```

No API keys or external services are required to run it.

### Configuration (env vars)

| Var                   | Default        | Purpose                                             |
|-----------------------|----------------|-----------------------------------------------------|
| `PORT`                | `8070`         | HTTP port                                           |
| `NODE_ENV`            | `production`   | Environment label                                   |
| `ACMEPAY_DB`          | `data/acmepay.db` | SQLite file path                                 |
| `ACMEPAY_SAFE_SEARCH` | *(unset)*      | `1` → use the **fixed** parameterized search (kills SQLi #1) |

## Endpoints

| Method | Path                                   | Description                         |
|--------|----------------------------------------|-------------------------------------|
| GET    | `/`                                    | HTML landing page                   |
| GET    | `/health`                              | Health check JSON                   |
| POST   | `/api/login`                           | Authenticate `{ email, password }`  |
| GET    | `/api/users/:id`                       | Fetch a user profile                |
| GET    | `/api/transactions?user=&status=`      | Search the transaction ledger       |
| POST   | `/api/payments`                        | Create a payment                    |
| GET    | `/api/merchants`                       | List merchant accounts              |

### Example requests

```bash
curl localhost:8070/health
curl -X POST localhost:8070/api/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@acmepay.io","password":"admin123"}'
curl localhost:8070/api/users/1
curl 'localhost:8070/api/transactions?user=James&status=succeeded'
curl -X POST localhost:8070/api/payments -H 'Content-Type: application/json' \
  -d '{"user_id":2,"merchant_id":1,"amount_cents":4599,"description":"Order #90210"}'
curl localhost:8070/api/merchants
```

Seeded demo login: `admin@acmepay.io` / `admin123`.

## Project layout

```
target-app/
├── package.json
├── seed.js              # seed script (node seed.js [--force])
├── src/
│   ├── config.js        # config + (intentionally) hard-coded secrets
│   ├── db.js            # SQLite schema + connection
│   └── server.js        # Express app + all endpoints
├── public/
│   └── index.html       # landing page
├── data/                # SQLite DB lives here (gitignored)
├── Dockerfile
├── DEPLOY.md
├── README.md
└── SECURITY-NOTES.md    # <-- planted-vulnerability answer key
```

## Security

This app is intentionally insecure for the demo. See
[`SECURITY-NOTES.md`](./SECURITY-NOTES.md) for each planted vulnerability with
`file:line`, impact, proof-of-concept, and fix.
