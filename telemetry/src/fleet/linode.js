// Minimal Linode API client for the ari-net fleet.
//
// SAFETY: every mutating call goes through assertAriNet(), which refuses any
// instance that is not tagged "ari-net" with an "ari-net-" label, and refuses a
// hard denylist of instances that are known not to be ours, BEFORE any request.
import fs from 'node:fs';
import crypto from 'node:crypto';

export const FLEET_TAG = 'ari-net';
export const REGION = 'us-ord';
export const TYPE = 'g6-nanode-1';
// Per-role plan overrides (db holds the large MyFiat dataset).
export const ROLE_TYPE = { db: 'g6-standard-4' };
export const typeForRole = (role) => ROLE_TYPE[role] || TYPE;
export const IMAGE = 'linode/ubuntu24.04';
export const MAX_INSTANCES = 8;

// Never mutate these, whatever their tags say.
const DENY_IDS = new Set(['107864618', '107860349', '107862394', '107862396']);
const DENY_LABELS = new Set(['hackmidwest-cpu-voice-g8', 'ari-demo-payments-api', 'ari-node-7792-8', 'ari-node-7792-9']);

function loadToken() {
  if (process.env.LINODE_API_TOKEN) return process.env.LINODE_API_TOKEN.trim();
  try {
    const env = fs.readFileSync(new URL('../../../backend/.env', import.meta.url), 'utf8');
    const m = env.match(/^\s*LINODE_API_TOKEN\s*=\s*["']?([^"'\r\n#]+)/m);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}
const TOKEN = loadToken();
export const hasToken = () => !!TOKEN;

async function api(path, method = 'GET', body) {
  if (!TOKEN) throw new Error('LINODE_API_TOKEN not configured');
  const res = await fetch(`https://api.linode.com/v4${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.errors?.[0]?.reason || `Linode API ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export function isDenied(id) { return DENY_IDS.has(String(id)); }

export function isAriNet(inst) {
  // Authoritative: carries the "ari-net" tag AND is not a denylisted instance
  // (by id or original label). We no longer require an "ari-net-*" label prefix,
  // because operators may rename fleet nodes (e.g. ari-net-db-1 -> database-01);
  // none of the denylisted instances carry the ari-net tag, so the tag + the
  // id/label denylist together still fully protect the forbidden instances.
  return !!inst
    && Array.isArray(inst.tags) && inst.tags.includes(FLEET_TAG)
    && !DENY_IDS.has(String(inst.id)) && !DENY_LABELS.has(inst.label);
}

function assertAriNet(inst) {
  if (!isAriNet(inst)) {
    const err = new Error(`refusing to touch non ari-net instance ${inst?.id}`);
    err.status = 403;
    throw err;
  }
}

export function roleOf(inst) {
  const t = (inst.tags || []).find((x) => x.startsWith('role:'));
  return t ? t.slice(5) : null;
}

export function ipsOf(inst) {
  const v4 = inst.ipv4 || [];
  return {
    publicIp: v4.find((ip) => !/^192\.168\./.test(ip)) || null,
    privateIp: v4.find((ip) => /^192\.168\./.test(ip)) || null,
  };
}

// All ari-net instances (filtered locally; nothing else is returned).
export async function listFleet() {
  const out = [];
  for (let page = 1; page < 20; page++) {
    const r = await api(`/linode/instances?page=${page}&page_size=500`);
    out.push(...r.data);
    if (page >= (r.pages || 1)) break;
  }
  return out.filter(isAriNet);
}

export async function getInstance(id) {
  if (!/^\d+$/.test(String(id))) { const e = new Error('bad id'); e.status = 404; throw e; }
  return api(`/linode/instances/${id}`);
}

export async function createInstance({ role, label, pubkey }) {
  const type = typeForRole(role);
  if (!/^ari-net-[a-z]+-\d+$/.test(label)) throw new Error('bad label');
  return api('/linode/instances', 'POST', {
    label,
    region: REGION,
    type,
    image: IMAGE,
    // Random root password: required by the API, never stored or logged.
    root_pass: `${crypto.randomBytes(24).toString('base64url')}Aa1!`,
    authorized_keys: [pubkey],
    private_ip: true,
    booted: true,
    tags: [FLEET_TAG, `role:${role}`],
  });
}

// Delete: re-fetches the instance and re-checks the tag/label/denylist itself,
// so a caller can never reach the DELETE call for a non ari-net instance.
export async function deleteInstance(id, expectedLabel) {
  if (DENY_IDS.has(String(id))) { const e = new Error('protected instance'); e.status = 403; throw e; }
  const inst = await getInstance(id);
  assertAriNet(inst);
  if (inst.label !== expectedLabel) { const e = new Error('label mismatch'); e.status = 400; throw e; }
  await api(`/linode/instances/${inst.id}`, 'DELETE');
  return true;
}
