// Email-event flapper: spins a throwaway Linode node through its full lifecycle
// over and over, firing a Linode account event email at each step:
//   create -> reboot -> shutdown -> boot -> delete  (~5 event emails per node)
// This is purely to exercise Linode's OWN event-notification emails to the account
// owner. Safety: it only ever touches a node it CREATED this run (tracked by id),
// and it refuses the denylisted instances outright.
// Stop with Ctrl-C (or: pkill -f chaos.js) — it deletes its node on exit.
import crypto from "node:crypto";

const { LINODE_API_TOKEN } = process.env;
const STEP_MS = Number(process.env.CHAOS_STEP_MS || 15_000); // gap between lifecycle actions
const REGION = process.env.CHAOS_REGION || "us-ord";
const TYPE = process.env.CHAOS_TYPE || "g6-nanode-1";
const TAG = process.env.CHAOS_TAG || "ari-chaos";

const DENYLIST = new Set(["107864618", "107860349"]);
if (!LINODE_API_TOKEN) {
  console.error("[chaos] LINODE_API_TOKEN not set");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

let currentId = null; // the node this flapper owns right now

// Wait until our node reaches a status (or times out), so power actions don't 409.
async function waitStatus(id, want, timeoutMs = 90_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const r = await api(`/linode/instances/${id}`);
    if (r.ok && r.data.status === want) return true;
    await sleep(5_000);
  }
  return false;
}

async function act(id, action) {
  if (!id || DENYLIST.has(id)) return;
  const r = await api(`/linode/instances/${id}/${action}`, "POST");
  console.log(`[chaos] ${action} ${id} -> ${r.ok ? "ok" : `(${r.status})`}`);
}

async function lifecycle() {
  // CREATE (fires linode_create + the initial boot)
  const label = `ari-chaos-${Date.now().toString().slice(-7)}`;
  const r = await api("/linode/instances", "POST", {
    region: REGION,
    type: TYPE,
    image: "linode/ubuntu24.04",
    label,
    root_pass: `Ari!${crypto.randomBytes(16).toString("hex")}`,
    booted: true,
    tags: ["ari-net", TAG],
  });
  if (!r.ok) {
    console.log(`[chaos] create rejected (${r.status}: ${r.data?.errors?.[0]?.reason || "n/a"}) — likely at the cap`);
    return;
  }
  currentId = String(r.data.id);
  console.log(`[chaos] created ${label} (${currentId})`);

  if (await waitStatus(currentId, "running")) {
    await sleep(STEP_MS);
    await act(currentId, "reboot"); // fires linode_reboot
    await waitStatus(currentId, "running");
    await sleep(STEP_MS);
    await act(currentId, "shutdown"); // fires linode_shutdown
    await waitStatus(currentId, "offline");
    await sleep(STEP_MS);
    await act(currentId, "boot"); // fires linode_boot
    await waitStatus(currentId, "running");
    await sleep(STEP_MS);
  }

  // DELETE (fires linode_delete) — only our own node, re-checked.
  const inst = await api(`/linode/instances/${currentId}`);
  if (inst.ok && (inst.data.tags || []).includes(TAG) && !DENYLIST.has(currentId)) {
    await api(`/linode/instances/${currentId}`, "DELETE");
    console.log(`[chaos] deleted ${label} (${currentId})`);
  }
  currentId = null;
}

async function cleanup() {
  if (currentId && !DENYLIST.has(currentId)) {
    const inst = await api(`/linode/instances/${currentId}`);
    if (inst.ok && (inst.data.tags || []).includes(TAG)) {
      await api(`/linode/instances/${currentId}`, "DELETE").catch(() => {});
      console.log(`[chaos] cleaned up ${currentId} on exit`);
    }
  }
  process.exit(0);
}
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

console.log(`[chaos] cycling create→reboot→shutdown→boot→delete, ${STEP_MS / 1000}s between steps. Ctrl-C to stop.`);
(async function run() {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await lifecycle();
    } catch (e) {
      console.error(`[chaos] cycle failed: ${e.message}`);
    }
    // Always back off between cycles, including when create is rejected at the
    // account cap, so a failure can never turn into a tight retry loop.
    await sleep(STEP_MS * 4);
  }
})();
