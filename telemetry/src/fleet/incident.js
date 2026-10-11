// L7 incident (DDoS) detection + mitigation for the ari-net load balancer.
//
// Detection is REAL: it reads a short window of the lb's nginx access log over
// SSH and aggregates requests per source IP ($remote_addr, which is the real
// client IP once conf.d/ari-net-incident.conf sets real_ip from the controller).
// It flags a spike when non-fleet source IPs drive the rate well above baseline.
// Mitigation is REAL: it writes `deny <ip>;` lines into an nginx include on the
// lb and reloads, so the offending IPs get 403'd.
//
// SAFETY: only ever the ari-net lb node is touched; IPs are validated; fleet
// node private IPs, the controller and loopback are never treated as attackers.

const WINDOW_SEC = 10;          // analysis window
const PER_IP_FLOOR = 3;         // req/s for a source IP to count as an attacker
const TRIP_ABS = 20;            // attacker req/s to trip (also baseline-relative)
const TRIP_MULT = 3;            // ... or baseline * this, whichever is higher
const CLEAR_ABS = 8;            // attacker req/s below which it clears
const TRIP_DEBOUNCE = 2;        // consecutive tripping samples to go active
const CLEAR_DEBOUNCE = 3;       // consecutive calm samples to clear

// Well-formed, routable-ish source IP (IPv4). Refuses loopback/multicast/0.0.0.0
// and anything that isn't four octets. (Good enough for blocklist validation.)
export function isPlausibleSourceIp(ip) {
  if (typeof ip !== 'string') return false;
  const m = ip.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const o = m.slice(1).map(Number);
  if (o.some((x) => x > 255)) return false;
  if (o[0] === 0 || o[0] === 127 || o[0] >= 224) return false;      // 0/8, loopback, multicast/reserved
  if (o[0] === 255 && o[1] === 255 && o[2] === 255 && o[3] === 255) return false;
  return true;
}

const isPrivate = (ip) => /^10\./.test(ip) || /^192\.168\./.test(ip)
  || /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || /^169\.254\./.test(ip);

// Parse the window dump (one line per request: "<msec> <status> <remote_addr> ...")
// into per-IP counts, excluding fleet-internal / control / loopback sources.
export function analyzeWindow(text, { windowSec = WINDOW_SEC, fleetPrivateIps = new Set(), controllerIp = null } = {}) {
  const perIp = new Map();
  let total = 0;
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 3) continue;
    const ip = f[2];
    total++;
    perIp.set(ip, (perIp.get(ip) || 0) + 1);
  }
  const attackers = [];
  for (const [ip, requests] of perIp) {
    if (isPrivate(ip) || ip === controllerIp || ip === '127.0.0.1' || ip === '::1') continue;
    if (fleetPrivateIps.has(ip)) continue;
    const reqPerSec = Number((requests / windowSec).toFixed(2));
    if (reqPerSec >= PER_IP_FLOOR) attackers.push({ ip, requests, reqPerSec });
  }
  attackers.sort((a, b) => b.reqPerSec - a.reqPerSec);
  return { reqPerSec: Number((total / windowSec).toFixed(2)), attackers };
}

// Build the nginx deny-list file content from the authoritative blocked set.
export function blocklistContent(ips) {
  const lines = ['# ari-net incident blocklist — managed by the fleet controller (block-ips / unblock-ips).'];
  for (const ip of ips) lines.push(`deny ${ip};`);
  return lines.join('\n') + '\n';
}

export const INCIDENT_CONF = '/etc/nginx/conf.d/ari-net-incident.conf';
export const BLOCKLIST_FILE = '/etc/nginx/ari-net-blocklist.conf';

// conf.d file: real client IP (trust the controller's egress for the DDoS drill
// AND the traffic node's private IP for the many-users generator) + blocklist
// include. Valid in the http context, so it needs no change to the site config.
// `trusted` is a list of source IPs whose X-Forwarded-For we honor.
export function incidentConfContent(trusted = []) {
  const lines = [
    '# ari-net incident response + real client IP — managed by the fleet controller. Do not edit by hand.',
    'real_ip_header X-Forwarded-For;',
    'real_ip_recursive on;',
  ];
  const srcs = [...new Set(trusted.filter(Boolean))];
  if (srcs.length) for (const s of srcs) lines.push(`set_real_ip_from ${s};`);
  else lines.push('# set_real_ip_from <trusted sources> (pending first sample)');
  lines.push(`include ${BLOCKLIST_FILE};`, '');
  return lines.join('\n');
}
