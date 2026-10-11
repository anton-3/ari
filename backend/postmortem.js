// Auto-postmortem: after an incident call where Ari took action, write a real
// postmortem from what actually happened (transcript, every tool action with its
// timestamp and result, live incident data) and email it to the team.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nodemailer from "nodemailer";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "postmortems");
const TELEMETRY_URL = process.env.TELEMETRY_URL || "http://localhost:8090";
const { GMAIL_USER, GMAIL_APP_PASSWORD } = process.env;
export const POSTMORTEM_TO = (
  process.env.POSTMORTEM_TO || "tswaller04@gmail.com,angelettianton@gmail.com,nloc49139@gmail.com"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const SYSTEM = `You write incident postmortems for an engineering team. Be factual and specific: use ONLY the
facts provided (transcript, actions with timestamps and results, incident data). Never invent numbers, IPs,
names, or causes; if something is unknown, say "unknown" or list it as an open question. Blameless tone.
Output GitHub-flavored Markdown with exactly these sections:
# Postmortem: <short title>
**Date:** ... · **Duration:** ... · **Severity:** <SEV1-4 with one-line justification> · **Responder:** Ari + <on-call>
## Summary  (3-4 sentences)
## Impact  (who/what was affected, measured values)
## Timeline  (UTC, one bullet per event, taken from the action timestamps and transcript)
## Root cause  (what the evidence shows; mark inferences as such)
## What went well
## What went wrong
## Action items  (table: Action | Owner | Priority | Status) — include follow-ups implied by the call (e.g. an opened PR to review)`;

async function incidentSnapshot() {
  try {
    const r = await fetch(`${TELEMETRY_URL}/api/fleet/incident`, { signal: AbortSignal.timeout(4000) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

// A call deserves a postmortem when Ari actually changed something.
const ACTION_TOOLS = new Set([
  "block_ips", "scale_web_app", "open_rate_limit_pr", "provision_instances", "shutdown_instance",
  "boot_instance", "rollback_commit", "rotate_secret", "close_ports", "deploy_agents", "recall_agents",
]);
export const needsPostmortem = (actions) => actions.some((a) => ACTION_TOOLS.has(a.name));

function transcriptText(messages) {
  return messages
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map((m) => `${m.role === "user" ? "On-call" : "Ari"}: ${m.content.trim()}`)
    .join("\n");
}

// Tiny Markdown -> HTML for the email body (headings, bold, bullets, tables, paragraphs).
function mdToHtml(md) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`(.+?)`/g, "<code>$1</code>");
  const lines = md.split("\n");
  const out = [];
  let list = false;
  let table = [];
  const flushTable = () => {
    if (!table.length) return;
    const rows = table.filter((r) => !/^\|\s*-/.test(r)).map((r) => r.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
    out.push(
      `<table style="border-collapse:collapse;margin:8px 0">${rows
        .map((r, i) => `<tr>${r.map((c) => `<${i ? "td" : "th"} style="border:1px solid #ddd;padding:6px 10px;text-align:left">${inline(c)}</${i ? "td" : "th"}>`).join("")}</tr>`)
        .join("")}</table>`,
    );
    table = [];
  };
  for (const l of lines) {
    if (/^\|/.test(l)) { table.push(l); continue; }
    flushTable();
    if (/^[-*] /.test(l)) { if (!list) { out.push("<ul>"); list = true; } out.push(`<li>${inline(l.slice(2))}</li>`); continue; }
    if (list) { out.push("</ul>"); list = false; }
    const h = l.match(/^(#{1,3}) (.*)/);
    if (h) out.push(`<h${h[1].length} style="margin:18px 0 6px">${inline(h[2])}</h${h[1].length}>`);
    else if (l.trim()) out.push(`<p style="margin:6px 0">${inline(l)}</p>`);
  }
  flushTable();
  if (list) out.push("</ul>");
  return `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;color:#1a1d24;max-width:760px">${out.join("\n")}<hr style="margin-top:24px;border:none;border-top:1px solid #eee"><p style="color:#888;font-size:12px">Written automatically by Ari from the incident call.</p></div>`;
}

async function sendEmail(subject, markdown) {
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) throw new Error("GMAIL_USER / GMAIL_APP_PASSWORD not set in backend/.env");
  const transport = nodemailer.createTransport({ service: "gmail", auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD } });
  return transport.sendMail({
    from: `Ari <${GMAIL_USER}>`,
    to: POSTMORTEM_TO.join(", "),
    subject,
    text: markdown,
    html: mdToHtml(markdown),
  });
}

// Build + save + email. Returns { ok, file, subject, error? }.
export async function writeAndSendPostmortem({ client, model, callSid, messages, actions, startedAt, endedAt = new Date() }) {
  const incident = await incidentSnapshot();
  const facts = {
    call: { id: callSid, startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString() },
    actions: actions.map((a) => ({ at: a.at, tool: a.name, args: a.args, result: a.result })),
    incident,
  };
  const completion = await client.chat.completions.create({
    model,
    max_tokens: 1800,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: `FACTS (JSON):\n${JSON.stringify(facts, null, 2)}\n\nCALL TRANSCRIPT:\n${transcriptText(messages)}` },
    ],
  });
  const md = (completion.choices[0].message.content || "").trim();
  const title = (md.match(/^# (.*)$/m) || [, "Incident postmortem"])[1].replace(/^Postmortem:\s*/i, "");

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${startedAt.toISOString().replace(/[:.]/g, "-")}.md`);
  fs.writeFileSync(file, md + "\n");

  const subject = `[Postmortem] ${title}`;
  try {
    await sendEmail(subject, md);
    return { ok: true, file, subject };
  } catch (err) {
    return { ok: false, file, subject, error: err.message };
  }
}

// Manual trigger: re-send a saved postmortem.  node postmortem.js <file.md>
if (import.meta.url === `file://${process.argv[1]}` && process.argv[2]) {
  const md = fs.readFileSync(process.argv[2], "utf8");
  const title = (md.match(/^# (.*)$/m) || [, "Incident postmortem"])[1];
  sendEmail(`[Postmortem] ${title.replace(/^Postmortem:\s*/i, "")}`, md)
    .then(() => console.log(`sent to ${POSTMORTEM_TO.join(", ")}`))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
