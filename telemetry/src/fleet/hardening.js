// Hardening actions Ari can take on the fleet: close exposed ports, rotate a leaked secret.
// Both act over the controller's SSH, verify the result, and are safe to repeat.
import crypto from 'node:crypto';
import { checkExposure, probePort } from './issues.js';

const PRIVATE_NET = '192.168.0.0/16'; // Linode private network: app <-> db/cache traffic keeps flowing
const NEVER_CLOSE = new Set([22]);    // the controller's SSH; closing it would lock everyone out
const LB_PUBLIC = new Set([80, 443]); // closing these on the lb takes the bank offline

// close_ports: deny public TCP to each port while still allowing the private network, via ufw
// (persists across reboots). Returns per-node results, verified with an outside TCP probe.
export async function closePorts(fleet, { ports, label } = {}) {
  const wanted = [...new Set((ports || []).map(Number))].filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
  if (!wanted.length) throw Object.assign(new Error('ports must be a list of TCP port numbers'), { status: 400 });
  const all = [...fleet.instances.entries()].map(([id, n]) => ({ id, ...n }))
    .filter((n) => n.publicIp && n.inst?.status === 'running');
  const targets = label ? all.filter((n) => n.label === label || n.inst?.label === label) : all;
  if (!targets.length) throw Object.assign(new Error(label ? `no running node labelled ${label}` : 'no running nodes'), { status: 404 });

  const results = [];
  for (const node of targets) {
    const refused = wanted.filter((p) => NEVER_CLOSE.has(p) || (node.role === 'lb' && LB_PUBLIC.has(p)));
    const closing = wanted.filter((p) => !refused.includes(p));
    const entry = { label: node.label, closed: [], stillOpen: [], refused };
    if (closing.length) {
      // Prepend deny, then prepend the private allow above it, so the private allow wins for 192.168/16.
      const cmd = closing.map((p) => `ufw prepend deny proto tcp from any to any port ${p} comment ari-close-ports >/dev/null; `
        + `ufw prepend allow proto tcp from ${PRIVATE_NET} to any port ${p} comment ari-close-ports-private >/dev/null`).join('; ')
        + '; ufw status | grep -c ari-close-ports';
      const r = await fleet.ssh(node.publicIp, cmd, { timeoutMs: 30000 });
      if (r.code !== 0) { entry.error = (r.stderr || r.stdout || 'ufw failed').trim().slice(-200); results.push(entry); continue; }
      for (const p of closing) (await probePort(node.publicIp, p) ? entry.stillOpen : entry.closed).push(p);
      await checkExposure(fleet.issues, node).catch(() => {}); // clears "port reachable" findings on the map
    }
    results.push(entry);
  }
  fleet.publish?.();
  return { ok: results.every((r) => !r.error && !r.stillOpen.length), results };
}

// rotate_secret: generate a new value, write it to every app node's secrets.env (loaded by a systemd
// drop-in so controller rewires never wipe it), rolling-restart each node and wait for health.
const SECRETS = [
  { match: /stripe|payment|sk_live|processor/i, env: 'STRIPE_SECRET_KEY', label: 'Stripe secret key',
    make: () => 'sk_live_' + crypto.randomBytes(24).toString('base64url') },
  { match: /jwt|session|signing|token|auth/i, env: 'JWT_SECRET', label: 'session signing secret',
    make: () => crypto.randomBytes(32).toString('hex') },
];

export async function rotateSecret(fleet, { name } = {}) {
  const secret = SECRETS.find((s) => s.match.test(String(name || '')));
  if (!secret) throw Object.assign(new Error(`don't know how to rotate "${name}"; supported: Stripe secret key, session signing secret`), { status: 400 });
  const apps = fleet.nodesOfRole('app').filter((n) => n.publicIp && n.inst?.status === 'running');
  if (!apps.length) throw Object.assign(new Error('no running app nodes'), { status: 409 });
  const value = secret.make();
  const results = [];
  for (const node of apps) { // one at a time: the lb keeps serving from the others
    const cmd = `set -e; svc=; for s in myfiat acmepay; do systemctl cat $s >/dev/null 2>&1 && svc=$s; done; [ -n "$svc" ]; `
      + `f=/etc/ari-net/secrets.env; touch $f; chmod 600 $f; grep -v '^${secret.env}=' $f > $f.tmp || true; `
      + `cat >> $f.tmp; mv $f.tmp $f; chown $svc $f; `
      + `mkdir -p /etc/systemd/system/$svc.service.d; printf '[Service]\\nEnvironmentFile=-/etc/ari-net/secrets.env\\n' > /etc/systemd/system/$svc.service.d/ari-secrets.conf; `
      + `systemctl daemon-reload; systemctl restart $svc; for i in $(seq 1 40); do curl -fs localhost:3000/health >/dev/null && break; sleep 0.5; done; `
      + `curl -fs localhost:3000/health >/dev/null && grep -c '^${secret.env}=' $f`;
    const r = await fleet.ssh(node.publicIp, cmd, { input: `${secret.env}=${value}\n`, timeoutMs: 60000 });
    results.push({ label: node.label, ok: r.code === 0 && r.stdout.trim().endsWith('1') });
    if (r.code !== 0) break; // stop the roll on the first failure so the rest keep serving the old key
  }
  return { ok: results.length === apps.length && results.every((r) => r.ok), secret: secret.label, env: secret.env,
    fingerprint: `…${value.slice(-4)}`, results,
    note: secret.env === 'JWT_SECRET' ? 'All existing sessions are invalidated; users sign in again.' : 'The old key is no longer loaded anywhere in the fleet.' };
}
