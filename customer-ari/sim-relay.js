// Simulate Twilio's ConversationRelay WebSocket locally so you can test the
// voice loop WITHOUT placing a real phone call. It connects to /relay, sends a
// setup frame (optionally with the suspicious-charge greeting/prompt/token), then
// sends each line you type as a "prompt" frame and prints the assistant's spoken
// replies.
//
//   node sim-relay.js                     # plain voice assistant
//   node sim-relay.js --suspicious        # replay the suspicious-charge call script
//   MYFIAT_TOKEN=... node sim-relay.js --suspicious
import readline from "node:readline";
import WebSocket from "ws";
import { SUSPICIOUS_GREETING, suspiciousChargePrompt } from "./persona.js";
import { findSuspiciousCharge } from "./tools.js";

const PORT = process.env.PORT || 8072;
const suspicious = process.argv.includes("--suspicious");
const token = process.env.MYFIAT_TOKEN || "";

let greeting = "Hey, it's your MyFiat assistant. How can I help with your money today?";
let prompt = "";
if (suspicious) {
  greeting = SUSPICIOUS_GREETING;
  let charge = null;
  if (token) charge = await findSuspiciousCharge(token).catch(() => null);
  prompt = suspiciousChargePrompt(charge || {});
  if (charge) console.log(`(referencing alert ${charge.alertId}: ${charge.merchant || "?"} ${charge.amount || ""})`);
}

const ws = new WebSocket(`ws://localhost:${PORT}/relay`);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

ws.on("open", () => {
  if (suspicious) {
    // Outbound suspicious-charge call: pass the custom greeting/prompt/token.
    ws.send(JSON.stringify({ type: "setup", callSid: "SIM-OUT", direction: "outbound", from: "sim", to: "sim", customParameters: { greeting, prompt, token } }));
    console.log(`\n[assistant greeting] ${greeting}\n`);
  } else {
    // Inbound call: NO custom params — the server supplies the general greeting
    // and acts as the demo user via its own MYFIAT_TOKEN env.
    ws.send(JSON.stringify({ type: "setup", callSid: "SIM-IN", direction: "inbound", from: "sim", to: "sim", customParameters: {} }));
    console.log(`\n[inbound call — the server greets generally and acts as its MYFIAT_TOKEN demo user]\n`);
  }
  rl.setPrompt("you> ");
  rl.prompt();
});

ws.on("message", (data) => {
  let msg;
  try {
    msg = JSON.parse(data.toString());
  } catch {
    return;
  }
  if (msg.type === "text") {
    console.log(`\n[assistant] ${msg.token}\n`);
    rl.prompt();
  } else if (msg.type === "play") {
    console.log(`\n[assistant plays sound] ${msg.source}\n`);
    rl.prompt();
  } else if (msg.type === "end") {
    console.log(`\n[call ended]`);
    process.exit(0);
  }
});

ws.on("error", (e) => {
  console.error(`WS error: ${e.message} (is the server running on :${PORT}?)`);
  process.exit(1);
});

rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return rl.prompt();
  if (text === "/quit") return process.exit(0);
  ws.send(JSON.stringify({ type: "prompt", voicePrompt: text }));
});
