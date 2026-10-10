// Run an Ari incident scenario: fire the simulated signal, then place an
// outbound call where Ari opens with context about what it "detected".
//
// Based directly on ../drill.js — same Twilio Calls API mechanism, same env,
// same /voice?greeting=...&prompt=... pattern. The only differences: the
// greeting/prompt come from the scenario registry, and a DRY_RUN guard prints
// the request it WOULD make instead of actually calling Twilio.
//
// Usage:
//   node scenarios/run-scenario.js <key> +15551234567
//   DRY_RUN=1 node scenarios/run-scenario.js sqli-commit +15555550123
//
// From backend/ you can also run it through node's env-file loader, e.g.:
//   DRY_RUN=1 node --env-file-if-exists=.env scenarios/run-scenario.js ddos +15555550123
import { getScenario, listKeys } from "./registry.js";

const [key, to] = process.argv.slice(2);
const {
  TWILIO_SID,
  TWILIO_AUTH_TOKEN,
  PUBLIC_HOST,
  TWILIO_NUMBER = "+19137046751",
  DRY_RUN,
} = process.env;

const dryRun = DRY_RUN === "1" || DRY_RUN === "true";

if (!key || !to) {
  console.error("Usage: node scenarios/run-scenario.js <key> +15551234567");
  console.error(`Available scenarios: ${listKeys().join(", ")}`);
  console.error("Tip: set DRY_RUN=1 to print the call without sending it.");
  process.exit(1);
}

const scenario = getScenario(key);
if (!scenario) {
  console.error(`Unknown scenario "${key}". Available: ${listKeys().join(", ")}`);
  process.exit(1);
}

// 1) Represent the incident signal (logs only — never real attack traffic).
console.log(`[scenario] ${scenario.key} — ${scenario.title} (severity: ${scenario.severity})`);
await scenario.simulate();

// 2) Build the same /voice URL drill.js builds, with this scenario's lines.
const url = new URL(`https://${PUBLIC_HOST || "PUBLIC_HOST_UNSET"}/voice`);
url.searchParams.set("greeting", scenario.greeting);
url.searchParams.set("prompt", scenario.prompt);

// 3) Place the call — or, in DRY_RUN, print exactly what would be sent.
if (dryRun) {
  console.log("\n[scenario] DRY_RUN — not contacting Twilio. The call would be:");
  console.log(`  To:   ${to}`);
  console.log(`  From: ${TWILIO_NUMBER}`);
  console.log(`  Url:  ${url.toString()}`);
  console.log("\n  Decoded greeting:");
  console.log(`    ${scenario.greeting}`);
  console.log("\n  Decoded prompt:");
  console.log(`    ${scenario.prompt}`);
  console.log("\n  Suggested actions:");
  for (const a of scenario.suggestedActions) console.log(`    - ${a}`);
  process.exit(0);
}

if (!TWILIO_SID || !TWILIO_AUTH_TOKEN || !PUBLIC_HOST) {
  console.error(
    "Missing TWILIO_SID / TWILIO_AUTH_TOKEN / PUBLIC_HOST. " +
      "Set them, or use DRY_RUN=1 to preview the call without sending.",
  );
  process.exit(1);
}

console.log(`[scenario] ${scenario.key}: Ari is calling ${to}...`);
const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Calls.json`, {
  method: "POST",
  headers: {
    Authorization: "Basic " + Buffer.from(`${TWILIO_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64"),
  },
  body: new URLSearchParams({ To: to, From: TWILIO_NUMBER, Url: url.toString() }),
});
const call = await res.json();
if (!res.ok) {
  console.error(`Twilio error ${call.code}: ${call.message}`);
  process.exit(1);
}
console.log(`[scenario] call placed (${call.sid}), status: ${call.status}`);
