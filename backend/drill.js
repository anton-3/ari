// DDoS drill: simulate a detected traffic surge, then have Ari call you about it.
// No real attack traffic is generated — only the incident signal that prompts the call.
// Usage: npm run drill -- +15551234567 [instance-label]
const [to, label = "payments-api"] = process.argv.slice(2);
const { TWILIO_SID, TWILIO_AUTH_TOKEN, PUBLIC_HOST, TWILIO_NUMBER = "+19137046751" } = process.env;

if (!to) {
  console.error("Usage: npm run drill -- +15551234567 [instance-label]");
  process.exit(1);
}

const greeting = "Hey, it's Ari, sorry to call out of the blue. We've got something on the payments service.";
const prompt =
  `You just detected a sharp, abnormal traffic surge on the ${label} instance, consistent with a ` +
  `denial-of-service attack rather than normal load. You are calling the on-call engineer to report it ` +
  `and decide what to do. Briefly explain what you're seeing, then ask whether you should shut ${label} ` +
  `down. If they say yes, use your shutdown tool on ${label}, confirm it's done, and offer to boot it ` +
  `back up once traffic settles.`;

const url = new URL(`https://${PUBLIC_HOST}/voice`);
url.searchParams.set("greeting", greeting);
url.searchParams.set("prompt", prompt);

console.log(`[drill] Simulated DoS surge on ${label}. Ari is calling ${to}...`);
const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Calls.json`, {
  method: "POST",
  headers: { Authorization: "Basic " + Buffer.from(`${TWILIO_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64") },
  body: new URLSearchParams({ To: to, From: TWILIO_NUMBER, Url: url.toString() }),
});
const call = await res.json();
if (!res.ok) {
  console.error(`Twilio error ${call.code}: ${call.message}`);
  process.exit(1);
}
console.log(`[drill] call placed (${call.sid}), status: ${call.status}`);
