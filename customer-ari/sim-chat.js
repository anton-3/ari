// Quick REPL against POST /assistant/chat so you can test the text assistant
// from the terminal. Keeps history across turns.
//   node sim-chat.js                 # one-off: type messages
//   MYFIAT_TOKEN=... node sim-chat.js
import readline from "node:readline";

const PORT = process.env.PORT || 8072;
const token = process.env.MYFIAT_TOKEN || "demo-token";
const history = [];
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

async function turn(message) {
  const res = await fetch(`http://localhost:${PORT}/assistant/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, token, history }),
  });
  const data = await res.json();
  console.log(`\n[assistant] ${data.reply}`);
  if (data.actions?.length) console.log(`[actions] ${data.actions.map((a) => a.tool).join(", ")}`);
  console.log();
  history.push({ role: "user", content: message }, { role: "assistant", content: data.reply });
}

console.log(`MyFiat chat REPL -> http://localhost:${PORT}/assistant/chat  (type /quit to exit)\n`);
rl.setPrompt("you> ");
rl.prompt();
rl.on("line", async (line) => {
  const text = line.trim();
  if (!text) return rl.prompt();
  if (text === "/quit") return process.exit(0);
  try {
    await turn(text);
  } catch (e) {
    console.error(`error: ${e.message} (is the server running on :${PORT}?)`);
  }
  rl.prompt();
});
