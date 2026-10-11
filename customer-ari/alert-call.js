// Proactive "suspicious charge" outbound call. The MyFiat assistant CALLS the
// customer, references a real suspicious_charge alert from GET /api/alerts, asks
// if they recognize the charge, and — if not — offers to FREEZE the card and
// DISPUTE the charge, doing so via the tools over the voice relay.
//
// Trigger:  node alert-call.js [+number]     (or: npm run alert-call -- +1555...)
// Env:      DEMO_PHONE (default +19132658472), MYFIAT_TOKEN (the user's Bearer
//           token so the call can read the alert and take actions), TWILIO_*,
//           PUBLIC_HOST (this service's own tunnel).

import { findSuspiciousCharge } from "./tools.js";
import { SUSPICIOUS_GREETING, suspiciousChargePrompt } from "./persona.js";

const { TWILIO_SID, TWILIO_AUTH_TOKEN, PUBLIC_HOST, TWILIO_NUMBER = "+19137046751" } = process.env;
export const DEMO_PHONE = process.env.DEMO_PHONE || "+19132658472";

// Build the greeting + steering prompt from a live suspicious_charge alert,
// degrading to generic wording if the API is down or has no such alert.
async function buildCallScript(token) {
  let charge = null;
  if (token) {
    try {
      charge = await findSuspiciousCharge(token);
    } catch (err) {
      console.warn(`[alert-call] couldn't read alerts (${err.message}); using generic wording.`);
    }
  } else {
    console.warn("[alert-call] no MYFIAT_TOKEN set; the call can't read the alert or take actions for the user.");
  }

  const merchant = charge?.merchant;
  const amount = charge?.amount;
  const greeting = merchant
    ? `Hi, this is the MyFiat assistant calling about your account. Sorry to call out of the blue — I spotted a charge ${
        amount ? `for ${amount} ` : ""
      }at ${merchant} that looked unusual and wanted to check it with you real quick.`
    : SUSPICIOUS_GREETING;
  const prompt = suspiciousChargePrompt(charge || {});
  return { greeting, prompt, charge };
}

export async function placeSuspiciousChargeCall({ to = DEMO_PHONE, token = process.env.MYFIAT_TOKEN || "" } = {}) {
  if (!TWILIO_SID || !TWILIO_AUTH_TOKEN || !PUBLIC_HOST) {
    throw new Error("missing TWILIO_SID / TWILIO_AUTH_TOKEN / PUBLIC_HOST");
  }
  const { greeting, prompt, charge } = await buildCallScript(token);

  const url = new URL(`https://${PUBLIC_HOST}/voice`);
  url.searchParams.set("greeting", greeting);
  url.searchParams.set("prompt", prompt);
  if (token) url.searchParams.set("token", token); // so the relay can act as the user

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Calls.json`, {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from(`${TWILIO_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64") },
    body: new URLSearchParams({ To: to, From: TWILIO_NUMBER, Url: url.toString() }),
  });
  const call = await res.json();
  if (!res.ok) throw new Error(`Twilio ${call.code}: ${call.message}`);
  call._charge = charge;
  return call;
}

// CLI entrypoint: node alert-call.js [+number]
if (import.meta.url === `file://${process.argv[1]}`) {
  const to = process.argv[2] || DEMO_PHONE;
  const token = process.env.MYFIAT_TOKEN || "";
  console.log(`[alert-call] placing suspicious-charge call to ${to}...`);
  placeSuspiciousChargeCall({ to, token })
    .then((c) => {
      if (c._charge) {
        console.log(`[alert-call] referencing alert ${c._charge.alertId} (${c._charge.merchant || "unknown merchant"} ${c._charge.amount || ""}).`);
      } else {
        console.log("[alert-call] no live suspicious_charge alert found; used generic wording.");
      }
      console.log(`[alert-call] call placed (${c.sid}), status: ${c.status}`);
    })
    .catch((e) => {
      console.error(`[alert-call] failed: ${e.message}`);
      process.exit(1);
    });
}
