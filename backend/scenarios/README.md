# Ari scenario library

A set of self-contained incident scenarios Ari can "detect" and then call you
about during a demo. Each one mirrors the existing DDoS drill (`../drill.js`):
it represents a fake incident signal (logs only — **no real attack traffic**)
and places an outbound call where Ari opens with context and proposes a fix.

These reuse the **existing call infrastructure** — the same Twilio Calls API
mechanism and the same `/voice?greeting=...&prompt=...` webhook that `drill.js`
and `call.js` use, served by `../server.js`. Nothing here modifies the server,
the drill, the Linode tools, or `package.json`.

## Files

- `registry.js` — exports `scenarios` (array), `scenariosByKey` (map),
  `getScenario(key)`, and `listKeys()`. Each scenario is
  `{ key, title, severity, greeting, prompt, suggestedActions, simulate }`.
- `run-scenario.js` — CLI that fires a scenario's `simulate()` and then places
  (or, in dry-run, prints) the outbound call. Based directly on `drill.js`.

## How to run

From the `backend/` directory:

```bash
# Preview without calling anyone (prints To/From/Url + decoded greeting+prompt):
DRY_RUN=1 node scenarios/run-scenario.js <key> +15555550123

# Actually place the call (needs TWILIO_SID, TWILIO_AUTH_TOKEN, PUBLIC_HOST):
node --env-file-if-exists=../.env --env-file-if-exists=.env scenarios/run-scenario.js <key> +15551234567
```

Env vars (same as `drill.js`): `TWILIO_SID`, `TWILIO_AUTH_TOKEN`, `PUBLIC_HOST`,
`TWILIO_NUMBER` (defaults to `+19137046751`). `DRY_RUN=1` skips Twilio entirely
and prints the request it would have sent, so no secrets are needed to preview.

## Scenarios

### `ddos` — DDoS traffic surge (severity: high)
- **Simulates:** a 127x volumetric L7 flood against `payments-api` (botnet-like,
  thousands of IPs, 5xx rate spiking).
- **Ari's pitch:** reports the abnormal surge and asks whether to shut
  `payments-api` down, offering to boot it back once traffic settles.
- **Action:** `shutdown_instance` / `boot_instance` — **existing** Linode tools.

### `sqli-commit` — SQL injection introduced in a commit (severity: critical)
- **Simulates:** commit `a3f91c2` on `main` concatenates a user-supplied order
  ID into a SQL query at `POST /api/checkout/transactions`; verified with a
  read-only staging PoC.
- **Ari's pitch:** explains the injection and asks permission to roll back the
  commit; falls back to opening a blocking/revert PR if declined.
- **Action:** `rollback_commit(sha)` — **NEW tool to add** (see below).

### `exposed-secret` — Hardcoded secret committed (severity: critical)
- **Simulates:** a live Stripe secret key committed to `config/payments.js` in
  commit `7d20e4b` and pushed org-wide; present in remote git history.
- **Ari's pitch:** reports the exposure and recommends rotating the key at the
  provider and purging it from git history; asks to kick off rotation now.
- **Action:** `rotate_secret(name)` — **NEW tool to add** (see below). Git
  history purge + force-push + secret-store update are manual follow-ups.

### `brute-force` — Credential brute-force on login (severity: high)
- **Simulates:** failed logins against `POST /api/login` on `auth-api` spiking
  from ~38/min to ~5,900/min, concentrated in three source IPs.
- **Ari's pitch:** proposes blocking the offending IPs at the firewall; offers
  to shut `auth-api` down as a harder stop if it escalates.
- **Action:** `block_ips([...])` — **NEW firewall tool to add**; plus existing
  `shutdown_instance` / `boot_instance`.

### `port-scan` — External port scan / recon (severity: medium)
- **Simulates:** host `198.51.100.77` SYN-scanning ~12,000 ports across 6
  instances, finding `22/tcp` and `5432/tcp` exposed to the public internet.
- **Ari's pitch:** frames it as reconnaissance (not an active breach) and
  proposes tightening the firewall: block the scanner and close the extra ports.
- **Action:** `block_ips([...])` and `close_ports([...])` — **NEW firewall
  tools to add**.

## Wiring notes (for the human — I did NOT touch server.js)

Everything is exported cleanly for import. To wire these in:

1. **Import the registry** in `server.js`:
   `import { getScenario, scenarios } from "./scenarios/registry.js";`
   You can drive a scenario the same way `drill.js` does today — pass the
   scenario's `greeting` and `prompt` as `/voice` query params — or add a small
   scenario-picker endpoint that looks them up by `key`.

2. **Add the new Ari tools** the scenarios reference (define them alongside the
   Linode tools in the same OpenAI tool-definition style as `../linode.js`, and
   add them to the `tools` array + `runTool` switch that `server.js` already
   loops over). For a demo these can be safe stubs that just return a confirming
   string:
   - `rollback_commit({ sha })` → e.g. revert/reset a commit (stub: return
     `"Done: reverted commit <sha>."`). Needed by `sqli-commit`.
   - `rotate_secret({ name })` → rotate/revoke a provider key (stub: return
     `"Done: rotated <name>; the exposed key is now revoked."`). Needed by
     `exposed-secret`.
   - `block_ips({ ips })` → add firewall deny rules (stub: return
     `"Done: blocked <ips> at the firewall."`). Needed by `brute-force` and
     `port-scan`.
   - `close_ports({ ports, label? })` → restrict exposed ports (stub: return
     `"Done: closed <ports>."`). Needed by `port-scan`.

   The prompts are written to call these tools by role ("your rollback tool",
   "your firewall-block tool") so the exact names are flexible — just make sure
   the tool you register does the thing the prompt describes.

3. Scenarios that only use `shutdown_instance` / `boot_instance` (`ddos`, and
   the fallback paths of `brute-force`) already work with the current tools.

`simulate()` is intentionally log-only; swap in real detectors later if desired.
