// Send an SMS from Ari. Replies come back to the /sms webhook.
// Usage: npm run text -- +15551234567 "message"
const [to, body] = process.argv.slice(2);
// Texts go out from the A2P-registered number; calls use TWILIO_NUMBER.
const { TWILIO_SID, TWILIO_AUTH_TOKEN, TWILIO_SMS_NUMBER = "+19135578312" } = process.env;

if (!to || !body) {
  console.error('Usage: npm run text -- +15551234567 "message"');
  process.exit(1);
}

const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
  method: "POST",
  headers: { Authorization: "Basic " + Buffer.from(`${TWILIO_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64") },
  body: new URLSearchParams({ To: to, From: TWILIO_SMS_NUMBER, Body: body }),
});
const msg = await res.json();
if (!res.ok) {
  console.error(`Twilio error ${msg.code}: ${msg.message}`);
  process.exit(1);
}
console.log(`Texting ${to} (${msg.sid}), status: ${msg.status}`);
