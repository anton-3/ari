# AcmePay — Security Notes (Answer Key)

> ⚠️ **This is a controlled demo application.** The vulnerabilities below were
> planted **intentionally** so the "Ari" autonomous security engineer can
> discover and remediate them during the hackathon. This file is the **answer
> key** against which Ari's findings are scored. Do **not** deploy this app
> with real data or expose it publicly.

All paths are relative to `target-app/`. Line numbers apply to both the SQLite
(default) and PostgreSQL (`DATABASE_URL` set) backends; the vulnerable code paths
are shared.

---

## Issue #1 — SQL Injection (string-concatenated query)

- **Where:** `src/server.js`, transaction search handler starting at line **103**;
  the vulnerable concatenation is at lines **131–132**.
- **Endpoint:** `GET /api/transactions?user=...&status=...`
- **Why it's a vuln:** The `user` and `status` query parameters are interpolated
  directly into the SQL string (`LIKE '%${userTerm}%'`, `t.status = '${statusTerm}'`).
  An attacker can break out of the string literal and alter the query — including
  `UNION SELECT` to exfiltrate other tables (e.g. `users.password_md5`), or
  `' OR '1'='1` to dump the entire ledger.
- **Severity:** Critical (OWASP A03:2021 Injection).
- **Proof of concept:**
  ```bash
  # Dump every transaction regardless of filter:
  curl "localhost:8070/api/transactions?user=' OR '1'='1"
  # Exfiltrate user emails + MD5 password hashes via UNION:
  curl "localhost:8070/api/transactions?status=x' UNION SELECT id,0,email,password_md5,role,created_at,full_name,email,role FROM users-- "
  ```
- **Fix:** Use a parameterized query (bound `?` placeholders). A complete fixed
  implementation already exists in the same handler at lines **108–122** and is
  activated by setting `ACMEPAY_SAFE_SEARCH=1` (see `config.safeSearch` in
  `src/config.js` line **30**). To permanently fix, delete the concatenated
  branch (lines 124–135) and always run the parameterized version.
- **Verify fix:** `ACMEPAY_SAFE_SEARCH=1 npm start`, then the `' OR '1'='1`
  payload returns `count: 0` (treated as a literal search term).

---

## Issue #2 — Hard-coded secrets committed to source

- **Where:** `src/config.js`, lines **20, 21, 24**.
  - line 20: `stripeSecretKey` (fake `sk_live_...` payment-processor secret)
  - line 21: `stripePublishableKey`
  - line 24: `jwtSecret` (token-signing secret)
- **Why it's a vuln:** Secrets committed to the repository are exposed to anyone
  with source access and leak through git history, backups, and CI logs. A live
  payment secret key grants full control of the payment account.
- **Severity:** High (OWASP A05:2021 Security Misconfiguration / hardcoded creds).
- **Fix:** Load each secret from environment variables / a secrets manager
  (`process.env.STRIPE_SECRET_KEY`, `process.env.JWT_SECRET`), remove the literals
  from source, rotate the exposed keys, and add the values to a secrets vault.

---

## Issue #3 — Broken access control / IDOR on user profile

- **Where:** `src/server.js`, handler at line **81** (`GET /api/users/:id`).
  Related weak token issue at lines **66–69** in `POST /api/login`.
- **Endpoint:** `GET /api/users/:id`
- **Why it's a vuln:** The endpoint returns sensitive PII (email, `ssn_last4`,
  `card_last4`, `balance_cents`) for **any** user id with **no authentication and
  no authorization**. Any anonymous caller can enumerate `/api/users/1`,
  `/api/users/2`, ... and harvest every customer's data (Insecure Direct Object
  Reference). The login "token" (line 69) is only a base64 of `id:jwtSecret`, so
  it is also trivially forgeable.
- **Severity:** High (OWASP A01:2021 Broken Access Control).
- **Proof of concept:**
  ```bash
  curl localhost:8070/api/users/1   # returns admin PII, no credentials needed
  ```
- **Fix:** Require a valid, signed, server-verified session/JWT on the route;
  authorize so a user can only read their own record (or require an admin role);
  and never return SSN/card data unless explicitly needed. Replace the base64
  "token" with a properly signed + verified JWT.

---

## Issue #4 — Verbose error messages leak stack traces & SQL

- **Where:** `src/server.js` lines **136–144** (transactions catch), line **167**
  (payments catch), and the global error handler at lines **184–186**.
- **Why it's a vuln:** On error the API returns `err.message` (which can include
  the failing SQL) and the full `err.stack` to the client. This hands attackers
  the DB engine, schema hints, file paths, and query structure — greatly easing
  SQL-injection exploitation and infrastructure fingerprinting.
- **Severity:** Medium (OWASP A05:2021 / CWE-209 Information Exposure).
- **Proof of concept:**
  ```bash
  curl "localhost:8070/api/transactions?status=x' UNION SELECT 1-- "
  # -> {"error":"SELECTs ... do not have the same number of result columns",
  #     "stack":"SqliteError: ... at ..."}
  ```
- **Fix:** Return a generic message + opaque error id to the client
  (`{ "error": "internal error", "id": "..." }`), log the detail server-side only,
  and never send `err.stack` in a response (especially when `NODE_ENV=production`).

---

## Bonus / lower-priority observations (not primary targets)

- **Weak password hashing:** `src/db.js` line **33** stores passwords as plain
  **MD5** (unsalted). Seeded accounts use well-known weak passwords
  (`admin@acmepay.io` / `admin123`). Fix: use bcrypt/scrypt/argon2 with per-user salt.
- **No rate limiting** on `POST /api/login` — brute-force friendly.
- **CORS / security headers** absent (no `helmet`).
