// Start an outbound call where the AI talks with whoever picks up.
// Usage: npm run call -- +15551234567 ["opening line"] ["instructions for the AI"]
const [to, greeting, prompt] = process.argv.slice(2);
const { TWILIO_SID, TWILIO_AUTH_TOKEN, PUBLIC_HOST, TWILIO_NUMBER = "+19137046751" } = process.env;

if (!to) {
  console.error('Usage: npm run call -- +15551234567 ["opening line"] ["instructions for the AI"]');
  process.exit(1);
}

const url = new URL(`https://${PUBLIC_HOST}/voice`);
if (greeting) url.searchParams.set("greeting", greeting);
if (prompt) url.searchParams.set("prompt", prompt);

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
console.log(`Calling ${to} (${call.sid}), status: ${call.status}`);
