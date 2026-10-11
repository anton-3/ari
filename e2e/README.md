# MyFiat e2e test suite (Playwright)

End-to-end tests for **MyFiat**, the fictional demo banking app in
[`../target-app`](../target-app). This directory is self-contained: it has its
own `package.json` and **boots its own instance of the app** so a run never
depends on (or disturbs) anything else.

> This suite only ever *runs* the target app read-only. It does **not** edit any
> file under `../target-app`, and it does **not** run git.

## What it does on every run

Playwright's `webServer` (see `playwright.config.js` → `scripts/run-target.mjs`)
does the following before tests start, and tears the server down afterwards:

1. `npm install` in `../target-app` — only if its deps are missing.
2. `npm run seed -- --force` — into an **isolated** SQLite db
   (`e2e/.tmp/e2e.db`), so the shared `target-app/data/myfiat.db` that the other
   agents may be using is left untouched.
3. `PORT=8099 node src/server.js` — starts the app and waits for
   `http://localhost:8099/health`.

Port **8099** is deliberately chosen to avoid the 8070/8071 instances the
sibling agents run.

## Running

```bash
cd e2e
npm install
npm run install:browser   # one-time: downloads the Chromium build Playwright uses
npm test                  # boots the app on :8099, runs API + UI tests, tears down
```

Useful variants:

```bash
npm run test:api          # API layer only (the reliable core)
npm run test:ui           # UI smoke tests only
npm run report            # open the HTML report from the last run
npx playwright test --headed tests/ui   # watch the UI tests run
```

### Configuration (env vars)

| Var        | Default           | Purpose                                  |
|------------|-------------------|------------------------------------------|
| `E2E_PORT` | `8099`            | Port the app-under-test listens on       |
| `E2E_HOST` | `localhost`       | Host the tests reach it on               |
| `E2E_DB`   | `e2e/.tmp/e2e.db` | Isolated SQLite file for the test run    |

```bash
E2E_PORT=9123 npm test    # run the whole thing on a different port
```

## Layout

```
e2e/
├── package.json              # @playwright/test pinned (1.49.1)
├── playwright.config.js       # chromium, retries:1, trace on-first-retry, webServer
├── scripts/
│   └── run-target.mjs         # install (if needed) -> seed --force -> start server
└── tests/
    ├── helpers.js             # login/token + 404-tolerant JSON helpers (API)
    ├── api/                   # request-fixture tests (no browser)
    │   ├── auth.spec.js         login / bad creds / alias
    │   ├── security.spec.js     IDOR + SQLi (known-intentional vulns, pinned)
    │   ├── transactions.spec.js envelope, pagination, search, dispute
    │   ├── merchants.spec.js
    │   ├── accounts.spec.js     /api/me, /api/accounts
    │   ├── cards.spec.js        shape + freeze/unfreeze/renew
    │   ├── subscriptions.spec.js shape + cancel drops from monthly total
    │   ├── holdings.spec.js     shape + live price movement
    │   ├── alerts.spec.js       shape + resolve
    │   └── insights.spec.js
    └── ui/                    # page-fixture smoke tests (Chromium)
        ├── ui-helpers.js
        ├── auth.spec.js         sign in -> dashboard + balance
        ├── dashboard.spec.js    recent activity, alerts strip
        ├── cards.spec.js        freeze / renew
        ├── subscriptions.spec.js list + total + cancel
        ├── investments.spec.js  stocks + crypto
        └── assistant.spec.js    widget opens / graceful offline state
```

## Expected results while the sibling agents are still building

Two sibling agents are renaming AcmePay→MyFiat and building the new banking API
endpoints and UI **right now**, so the suite is written to be resilient:

* **Green today** (don't depend on new work): all of `auth`, `security`
  (IDOR + SQLi), `transactions`, `merchants`, and the UI `auth` + dashboard
  "recent activity" tests.
* **Auto-skip until implemented**: the API tests for `/api/me`, `/api/accounts`,
  `/api/cards`, `/api/subscriptions`, `/api/holdings`, `/api/alerts`,
  `/api/insights` and their mutations detect a `404` and skip with the note
  *"endpoint not implemented yet"*. They turn into real assertions automatically
  once the endpoints land — no edits needed.
* **Marked `fixme` until built**: the UI tests for cards / subscriptions /
  investments / the assistant widget, plus the dashboard "alerts strip", detect
  that the page/widget isn't present yet and mark themselves `fixme` with a
  clear note instead of failing.

Selectors prefer `getByRole` / `getByText` (and `data-testid` when present) over
brittle CSS, so they survive the rename and the UI rebuild.

## Note on the planted vulnerabilities

`tests/api/security.spec.js` intentionally asserts that the demo's
*known-intentional* weaknesses still surface (IDOR on `/api/users/:id`, and the
SQL-injection error on `/api/transactions?user=x'`). These are pinned so an
*accidental* "fix" or regression by another agent is caught. They are single
probes, not exploits — the real fixes are catalogued in
`../target-app/SECURITY-NOTES.md`.
