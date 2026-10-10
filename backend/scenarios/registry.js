// Ari scenario library.
//
// Each scenario mirrors the pattern in ../drill.js: it represents a detected
// incident signal (via simulate(), which only LOGS a fake signal — no real
// attack traffic, no real calls) and supplies the `greeting` and `prompt` that
// customize an outbound call so Ari opens with context and knows what to
// propose. The live model-tool loop lives in ../server.js (do not edit it);
// these objects are consumed by run-scenario.js and are meant to be imported
// into server.js by a human to wire up a scenario picker and any new tools.
//
// Scenario shape:
//   { key, title, severity, greeting, prompt, suggestedActions: [...], simulate: async () => {...} }
//
// `greeting` — Ari's opening spoken line (passed to /voice as ?greeting=).
// `prompt`   — per-call system-prompt addendum describing what Ari just
//              detected and what to propose (passed to /voice as ?prompt=).
//              server.js appends this under "Instructions for this call:".
// `suggestedActions` — the remediation Ari is expected to pitch. Some map to
//              tools that already exist (shutdown_instance / boot_instance in
//              ../linode.js); others reference tools a human still needs to add
//              (e.g. a code-rollback tool, a secret-rotation tool, a firewall
//              block tool). These are documented in README.md.

// A small helper so simulate() output reads consistently across scenarios.
function signal(key, lines) {
  console.log(`[scenario:${key}] --- simulated incident signal (no real traffic) ---`);
  for (const line of lines) console.log(`[scenario:${key}] ${line}`);
  console.log(`[scenario:${key}] --- end signal ---`);
}

export const scenarios = [
  {
    key: "ddos",
    title: "DDoS traffic surge",
    severity: "high",
    greeting:
      "Hey, it's Ari, sorry to call out of the blue. We've got something on the payments service.",
    prompt:
      `You just detected a sharp, abnormal traffic surge on the payments-api instance, consistent with a ` +
      `denial-of-service attack rather than normal load. You are calling the on-call engineer to report it ` +
      `and decide what to do. Briefly explain what you're seeing, then ask whether you should shut payments-api ` +
      `down. If they say yes, use your shutdown tool on payments-api, confirm it's done, and offer to boot it ` +
      `back up once traffic settles.`,
    suggestedActions: [
      "shutdown_instance('payments-api') — existing Linode tool",
      "boot_instance('payments-api') once traffic settles — existing Linode tool",
    ],
    simulate: async () =>
      signal("ddos", [
        "instance: payments-api",
        "requests/sec: 480 baseline -> 61,200 (127x)",
        "top source ASNs: scattered across 2,300+ IPs, botnet-like distribution",
        "upstream 5xx rate: 0.2% -> 44%",
        "classification: volumetric L7 flood, not organic load",
      ]),
  },

  {
    key: "sqli-commit",
    title: "SQL injection introduced in a commit",
    severity: "critical",
    greeting:
      "Hey, it's Ari. Bad news on the checkout service — a commit that just landed opened up a SQL injection.",
    prompt:
      `A developer just pushed commit a3f91c2 to the main branch that introduced a SQL injection vulnerability ` +
      `in the checkout transactions endpoint, slash api slash checkout slash transactions. The change concatenates ` +
      `the user-supplied order ID straight into a SQL query instead of using a parameterized statement, so an ` +
      `attacker can read or dump the transactions table. You verified it with a harmless proof-of-concept against ` +
      `staging. You are calling the on-call engineer to report it. Briefly explain the finding and why it's serious ` +
      `in plain spoken terms, then ask for permission to roll back commit a3f91c2. If they say yes, use your ` +
      `rollback tool on that commit, confirm it's reverted, and tell them to use a parameterized query before ` +
      `re-landing the change. If they'd rather not roll back, offer to open a blocking pull request instead.`,
    suggestedActions: [
      "rollback_commit('a3f91c2') — NEW tool a human needs to add (see README)",
      "fallback: open a blocking PR / revert PR",
    ],
    simulate: async () =>
      signal("sqli-commit", [
        "repo: checkout-service   branch: main",
        "commit: a3f91c2  author: dev@team   message: 'speed up order lookup'",
        "endpoint: POST /api/checkout/transactions",
        "finding: user-supplied orderId concatenated into SQL (no parameterization)",
        "PoC (staging, read-only): orderId=1 OR 1=1 -- returned 4,812 rows",
        "classification: CWE-89 SQL Injection, exploitable, unauthenticated-adjacent",
      ]),
  },

  {
    key: "exposed-secret",
    title: "Hardcoded secret committed to the repo",
    severity: "critical",
    greeting:
      "Hey, it's Ari. Quick one that can't wait — a live API key just got committed into the repo.",
    prompt:
      `A hardcoded secret was just committed to the repository: a live Stripe secret key was pasted directly into ` +
      `a config file, config slash payments dot js, in commit 7d20e4b, and pushed to a branch that's visible to the ` +
      `whole org. Because it's now in git history, deleting the line is not enough — the key is compromised the ` +
      `moment it hit the remote. You are calling the on-call engineer to report it. Explain the finding plainly, ` +
      `then recommend two things: first, rotate the key at the provider so the exposed one stops working, and ` +
      `second, purge it from git history so it isn't recoverable from old commits. Ask whether you should kick off ` +
      `the rotation now. If they say yes, use your secret-rotation tool, confirm the old key is revoked, and remind ` +
      `them to force-push the cleaned history and update the deployment secret store.`,
    suggestedActions: [
      "rotate_secret('stripe_secret_key') — NEW tool a human needs to add (see README)",
      "purge git history (BFG / git filter-repo) + force-push — manual follow-up",
      "update deployment secret store with the new key",
    ],
    simulate: async () =>
      signal("exposed-secret", [
        "repo: checkout-service   file: config/payments.js",
        "commit: 7d20e4b   pushed: just now   visibility: org-wide",
        "secret type: Stripe secret key (sk_live_...)  [redacted]",
        "detection: high-entropy string + known key prefix match",
        "status: LIVE — key currently valid against the provider",
        "exposure: present in remote git history, not just the working tree",
      ]),
  },

  {
    key: "brute-force",
    title: "Credential brute-force against the login endpoint",
    severity: "high",
    greeting:
      "Hey, it's Ari. Someone's hammering the login endpoint — looks like a credential brute-force in progress.",
    prompt:
      `You just detected a spike of failed logins against the login endpoint, slash api slash login, on the ` +
      `auth-api instance. It's a concentrated burst from a small number of source IPs — three addresses accounting ` +
      `for the vast majority of attempts — consistent with an automated credential-stuffing or brute-force attack, ` +
      `not users mistyping passwords. No account has been confirmed compromised yet. You are calling the on-call ` +
      `engineer to report it. Explain what you're seeing plainly, then propose blocking those source IPs at the ` +
      `firewall; if the attack keeps climbing or the node is directly exposed, offer to shut the auth-api instance ` +
      `down as a harder stop. If they approve blocking the IPs, use your firewall-block tool on them and confirm. ` +
      `If they'd rather take the node offline, use your shutdown tool on auth-api and offer to boot it back once ` +
      `rate-limiting is in place.`,
    suggestedActions: [
      "block_ips(['203.0.113.7','203.0.113.42','198.51.100.9']) — NEW firewall tool a human needs to add (see README)",
      "shutdown_instance('auth-api') as a hard stop — existing Linode tool",
      "boot_instance('auth-api') once rate-limiting is in place — existing Linode tool",
    ],
    simulate: async () =>
      signal("brute-force", [
        "instance: auth-api   endpoint: POST /api/login",
        "failed logins: 38 baseline/min -> 5,900/min",
        "top source IPs: 203.0.113.7 (61%), 203.0.113.42 (24%), 198.51.100.9 (11%)",
        "pattern: rotating usernames, common-password dictionary, no CAPTCHA solves",
        "accounts confirmed compromised: 0 (so far)",
        "classification: credential brute-force / stuffing",
      ]),
  },

  {
    key: "port-scan",
    title: "External port scan / reconnaissance",
    severity: "medium",
    greeting:
      "Hey, it's Ari. Not an emergency, but an outside host is scanning our fleet — looks like someone's casing the place.",
    prompt:
      `You just detected an external host, 198.51.100.77, performing a systematic port scan across the fleet — ` +
      `sequential connection attempts to thousands of ports on multiple instances over a few minutes. This is ` +
      `reconnaissance: someone mapping which services are exposed before a possible attack, not an active breach. ` +
      `It did find a couple of ports open that probably shouldn't be reachable from the public internet, including ` +
      `an SSH port and a database port. You are calling the on-call engineer to report it. Explain plainly that ` +
      `this is recon rather than an active intrusion so you don't over-alarm them, then propose tightening the ` +
      `firewall: block the scanning host and close the unnecessary exposed ports so only the intended services are ` +
      `reachable. If they approve, use your firewall tool to block the host and restrict the ports, and confirm ` +
      `what you changed.`,
    suggestedActions: [
      "block_ips(['198.51.100.77']) — NEW firewall tool a human needs to add (see README)",
      "close_ports(['22','5432'] on exposed nodes) — NEW firewall tool a human needs to add (see README)",
    ],
    simulate: async () =>
      signal("port-scan", [
        "source host: 198.51.100.77 (not on allowlist)",
        "targets: 6 instances across the fleet",
        "ports probed: ~12,000 in 4 minutes, sequential (SYN scan signature)",
        "open ports discovered: 22/tcp (ssh), 5432/tcp (postgres) reachable from public internet",
        "data exfiltration: none observed",
        "classification: external reconnaissance / pre-attack mapping",
      ]),
  },
];

// Map form for convenient lookup by key.
export const scenariosByKey = Object.fromEntries(scenarios.map((s) => [s.key, s]));

export function getScenario(key) {
  return scenariosByKey[key] || null;
}

export function listKeys() {
  return scenarios.map((s) => s.key);
}
