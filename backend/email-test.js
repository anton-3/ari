// Email-event test harness: exercises each Linode account event that triggers an
// email (create, reboot, shutdown, boot, delete) REPEAT times on a short-lived
// throwaway node, then reads the account event log and tallies how many of each
// actually fired. Gentle pacing (waits on status between steps) so no API hammering.
// Safety: only ever acts on nodes IT created (label prefix ari-emailtest-); refuses
// the denylisted instances.
import crypto from "node:crypto";

const { LINODE_API_TOKEN } = process.env;
const REPEAT = Number(process.env.EMAIL_TEST_REPEAT || 3);
const REGION = process.env.CHAOS_REGION || "us-ord";
const TYPE = process.env.CHAOS_TYPE || "g6-nanode-1";
const PREFIX = "ari-emailtest-";
const DENYLIST = new Set(["107864618", "107860349"]);

if (!LINODE_API_TOKEN) {
  console.error("[email-test] LINODE_API_TOKEN not set");
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[email-test] ${m}`);

async function api(path, method = "GET", body) {
  const res = await fetch(`https://api.linode.com/v4${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${LINODE_API_TOKEN}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function waitStatus(id, want, timeoutMs = 120_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const r = await api(`/linode/instances/${id}`);
    if (r.ok && r.data.status === want) return true;
    await sleep(6_000);
  }
  return false;
}

async function run() {
  const started = new Date().toISOString();
  const labels = [];
  for (let r = 1; r <= REPEAT; r++) {
    log(`--- round ${r}/${REPEAT} ---`);
    const label = `${PREFIX}${Date.now().toString().slice(-7)}`;
    labels.push(label);

    // CREATE
    const c = await api("/linode/instances", "POST", {
      region: REGION, type: TYPE, image: "linode/ubuntu24.04", label,
      root_pass: `Ari!${crypto.randomBytes(16).toString("hex")}`, booted: true,
      tags: ["ari-emailtest"],
    });
    if (!c.ok) {
      log(`create failed (${c.status}: ${c.data?.errors?.[0]?.reason || "n/a"}) — skipping round`);
      await sleep(10_000);
      continue;
    }
    const id = String(c.data.id);
    if (DENYLIST.has(id)) return;
    log(`create ${label} (${id}) ok`);
    await waitStatus(id, "running");
    await sleep(8_000);

    // REBOOT
    log(`reboot -> ${(await api(`/linode/instances/${id}/reboot`, "POST")).ok ? "ok" : "fail"}`);
    await waitStatus(id, "running");
    await sleep(8_000);

    // SHUTDOWN
    log(`shutdown -> ${(await api(`/linode/instances/${id}/shutdown`, "POST")).ok ? "ok" : "fail"}`);
    await waitStatus(id, "offline");
    await sleep(8_000);

    // BOOT
    log(`boot -> ${(await api(`/linode/instances/${id}/boot`, "POST")).ok ? "ok" : "fail"}`);
    await waitStatus(id, "running");
    await sleep(8_000);

    // DELETE (only our own node)
    const inst = await api(`/linode/instances/${id}`);
    if (inst.ok && (inst.data.tags || []).includes("ari-emailtest") && !DENYLIST.has(id)) {
      log(`delete -> ${(await api(`/linode/instances/${id}`, "DELETE")).ok ? "ok" : "fail"}`);
    }
    await sleep(8_000);
  }

  // Tally from the event log.
  log("reading account event log to verify...");
  const ev = await api("/account/events?page_size=100");
  const rows = (ev.data.data || []).filter((e) => {
    const lbl = (e.entity || {}).label || "";
    return lbl.startsWith(PREFIX) && e.created >= started;
  });
  const tally = {};
  for (const e of rows) tally[e.action] = (tally[e.action] || 0) + 1;
  log(`events since ${started} for ${PREFIX}* :`);
  for (const [a, n] of Object.entries(tally).sort()) console.log(`    ${a}: ${n}`);
  log(`done. Each of these actions emails the account owner if event notifications are enabled.`);
}

run().catch((e) => console.error(`[email-test] ${e.message}`));
