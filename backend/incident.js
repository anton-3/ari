// Incident response: when a DoS drill fires against our OWN fleet, Ari calls the
// on-call engineer. The drill script (telemetry) POSTs /incident on this server,
// which places the outbound call. Everything here concerns the team's own Linode
// fleet; no third party is involved.

const { TWILIO_SID, TWILIO_AUTH_TOKEN, PUBLIC_HOST, TWILIO_NUMBER = "+19137046751" } = process.env;
// Who Ari calls when an incident fires.
export const DEMO_PHONE = process.env.DEMO_PHONE || "+19132658472";

export const INCIDENT_GREETING =
  "Hey, it's Ari. Sorry to call out of the blue — we've got an incident on the production fleet I need you on.";

// The system-prompt addendum that steers the whole incident call.
export const incidentPrompt = ({ label = "ari-net-lb-1" } = {}) =>
  `This is a live incident call you are initiating. You have just detected a sharp, abnormal spike in traffic ` +
  `against our own load balancer (${label}) — a distributed denial-of-service pattern: a flood of requests from ` +
  `a small set of source IP addresses, well above baseline. The web app behind it is AcmePay, our banking app.\n` +
  `Run the incident like a calm senior on-call engineer. Steps:\n` +
  `1. Open by telling them what you're seeing: it looks like a distributed denial-of-service attack against our ` +
  `infrastructure. Keep it to a sentence or two. Then ASK for permission to ban the attacking IP addresses.\n` +
  `2. If they approve, call get_incident to read the current attacking IPs, then call block_ips to ban them at the ` +
  `edge, and confirm it's done. Don't invent IPs — use what get_incident returns.\n` +
  `3. They may ask you to spin up another node to serve the web app / add capacity. If so, call scale_web_app to ` +
  `add an app node to the fleet (our cloud is Akamai/Linode), and tell them it's booting and will join the load ` +
  `balancer automatically.\n` +
  `4. They may ask you to implement new rate limiting in the reverse proxy, code it in a new branch, and text them ` +
  `the pull request. If so, call open_rate_limit_pr once; it creates the branch, adds nginx rate limiting to the ` +
  `load balancer config, opens the PR, and texts them the link. Tell them you'll text the PR when it's up. Call it ` +
  `only once.\n` +
  `Be concise and natural — this is a phone call on speaker. Confirm each action after you take it. Don't read out ` +
  `raw IP lists unless they ask.`;

// Place an outbound call that drops into the normal /voice flow with a custom
// greeting + prompt (same mechanism call.js/drill.js use).
export async function placeIncidentCall({ to = DEMO_PHONE, label = "ari-net-lb-1" } = {}) {
  if (!TWILIO_SID || !TWILIO_AUTH_TOKEN || !PUBLIC_HOST) {
    throw new Error("missing TWILIO_SID / TWILIO_AUTH_TOKEN / PUBLIC_HOST");
  }
  const url = new URL(`https://${PUBLIC_HOST}/voice`);
  url.searchParams.set("greeting", INCIDENT_GREETING);
  url.searchParams.set("prompt", incidentPrompt({ label }));

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Calls.json`, {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from(`${TWILIO_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64") },
    body: new URLSearchParams({ To: to, From: TWILIO_NUMBER, Url: url.toString() }),
  });
  const call = await res.json();
  if (!res.ok) throw new Error(`Twilio ${call.code}: ${call.message}`);
  return call;
}

// Manual fallback for the demo: `npm run incident -- [+number] [lb-label]`
if (import.meta.url === `file://${process.argv[1]}`) {
  const [to = DEMO_PHONE, label = "ari-net-lb-1"] = process.argv.slice(2);
  console.log(`[incident] placing incident call to ${to} about ${label}...`);
  placeIncidentCall({ to, label })
    .then((c) => console.log(`[incident] call placed (${c.sid}), status: ${c.status}`))
    .catch((e) => {
      console.error(`[incident] failed: ${e.message}`);
      process.exit(1);
    });
}
