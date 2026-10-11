// Gentle email-event flapper: power-cycles ONE existing spare fleet node so Linode
// fires a power-state event email each step, at a sane cadence (no account-cap churn,
// no API hammering). Cycle: reboot ... then occasionally shutdown -> boot.
// Safety: only ever acts on the node whose exact label is CHAOS_NODE (must be tagged
// ari-net and not denylisted); never creates or deletes anything.
// Stop with Ctrl-C (or: pkill -f chaos-power.js).
const { LINODE_API_TOKEN } = process.env;
const NODE_LABEL = process.env.CHAOS_NODE || "worker-01";
const CYCLE_MS = Number(process.env.CHAOS_CYCLE_MS || 90_000); // one power event per ~90s
const DENYLIST = new Set(["107864618", "107860349"]);

if (!LINODE_API_TOKEN) {
  console.error("[chaos-power] LINODE_API_TOKEN not set");
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

async function resolveNode() {
  const r = await api("/linode/instances");
  const n = (r.data.data || []).find((i) => i.label === NODE_LABEL);
  if (!n) throw new Error(`no instance labelled ${NODE_LABEL}`);
  if (DENYLIST.has(String(n.id))) throw new Error(`${NODE_LABEL} is denylisted`);
  if (!(n.tags || []).includes("ari-net")) throw new Error(`${NODE_LABEL} is not an ari-net node`);
  return String(n.id);
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

async function act(id, action) {
  const r = await api(`/linode/instances/${id}/${action}`, "POST");
  console.log(`[chaos-power] ${action} ${NODE_LABEL} -> ${r.ok ? "ok" : `(${r.status} ${r.data?.errors?.[0]?.reason || ""})`}`);
  return r.ok;
}

let id;
let n = 0;

async function cycle() {
  if (!id) id = await resolveNode();
  // Every 3rd cycle do a full shutdown->boot (2 events); otherwise a reboot (1 event).
  if (n % 3 === 2) {
    if (await act(id, "shutdown")) await waitStatus(id, "offline");
    await sleep(5_000);
    if (await act(id, "boot")) await waitStatus(id, "running");
  } else {
    if (await act(id, "reboot")) await waitStatus(id, "running");
  }
  n++;
}

console.log(`[chaos-power] power-cycling ${NODE_LABEL} every ~${CYCLE_MS / 1000}s for event emails. Ctrl-C to stop.`);
(async function run() {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await cycle();
    } catch (e) {
      console.error(`[chaos-power] ${e.message}`);
    }
    await sleep(CYCLE_MS); // always back off a full cycle, even on error (no API hammering)
  }
})();
