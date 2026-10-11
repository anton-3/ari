// A validated detached worktree is prepared before the demo. A fresh branch,
// real PR and SMS are created only when the caller asks.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { providerFetch } from './voice-http.js';

const exec = promisify(execFile);
const REPO = fileURLToPath(new URL('../', import.meta.url));
const STATE = fileURLToPath(new URL('./.demo/pr-prepared.json', import.meta.url));
const REPO_SLUG = process.env.GITHUB_REPO || 'anton-3/hackmid2026';
const LB_FILE = 'telemetry/fleet-roles/lb.sh';
export const ZONE = 'limit_req_zone $binary_remote_addr zone=ari_rl:10m rate=10r/s;';
export const APPLY = 'limit_req zone=ari_rl burst=20 nodelay;';
const git = (args, cwd = REPO, options = {}) => exec('git', args, { cwd, timeout: 15000, maxBuffer: 1 << 20, ...options });

// Scope identity to this subprocess. Preserve the configured email unless an
// explicit agent email is supplied; never change repository/global git config.
export function ariCommitEnv(env = process.env) {
  return { ...env, GIT_AUTHOR_NAME: 'Ari', GIT_COMMITTER_NAME: 'Ari',
    ...(env.ARI_PR_EMAIL ? { GIT_AUTHOR_EMAIL: env.ARI_PR_EMAIL, GIT_COMMITTER_EMAIL: env.ARI_PR_EMAIL } : {}) };
}
export const PR_TITLE = 'Ari: Add rate limiting to the reverse proxy';

export function patchNginx(src) {
  if (src.includes(ZONE) && src.includes(APPLY) && src.includes('limit_req_status 429;')) return { out: src, changed: false };
  if (/^\s*limit_req(?:_zone)?\s/m.test(src)) throw new Error('Existing rate limiting requires review');
  for (const marker of ['# ari:rate-limit-zone', '# ari:rate-limit-apply']) {
    if (src.split(marker).length !== 2) throw new Error(`Expected exactly one ${marker} marker`);
  }
  const out = src.replace(/(^[ \t]*)# ari:rate-limit-zone/m, `$1# ari:rate-limit-zone\n$1${ZONE}`)
    .replace(/(^[ \t]*)# ari:rate-limit-apply/m, `$1# ari:rate-limit-apply\n$1${APPLY}\n$1limit_req_status 429;`);
  return { out, changed: true };
}

export function extractNginx(src) {
  const log = src.match(/cat > \/etc\/nginx\/conf\.d\/ari-net-log\.conf <<'NG'\n([\s\S]*?)\nNG/);
  const site = src.match(/cat > \/etc\/nginx\/sites-available\/myfiat <<'NG'\n([\s\S]*?)\nNG/);
  if (!log || !site) throw new Error('Expected nginx template blocks are missing');
  return `events {}\nhttp {\n${log[1]}\n${site[1].replace('include /etc/nginx/ari-net-upstream.conf;', 'server 127.0.0.1:3000;').replace('access_log /var/log/nginx/ari-access.log arinet;', 'access_log off;')}\n}\n`;
}

export async function prepareRateLimitPr({ validate } = {}) {
  await git(['fetch', 'origin', 'main']);
  const { stdout } = await git(['rev-parse', 'origin/main']);
  const base = stdout.trim();
  const wt = await mkdtemp(path.join(tmpdir(), 'ari-pr-'));
  await git(['worktree', 'add', '--detach', wt, base]);
  try {
    const src = await readFile(path.join(wt, LB_FILE), 'utf8');
    const patched = patchNginx(src);
    if (!patched.changed) throw new Error('Base already has this rate limit; choose a fresh demo base');
    if (!validate) throw new Error('Preparation requires nginx validation');
    await validate(extractNginx(patched.out));
    const state = { wt, base, preparedAt: Date.now(), validated: true };
    await mkdir(path.dirname(STATE), { recursive: true });
    await writeFile(STATE, JSON.stringify(state), { mode: 0o600 });
    return state;
  } catch (error) {
    await git(['worktree', 'remove', '--force', wt]).catch(() => {});
    throw error;
  }
}

export async function sendSms(to, body) {
  const { TWILIO_SID, TWILIO_AUTH_TOKEN } = process.env;
  const TWILIO_SMS_NUMBER = process.env.TWILIO_SMS_NUMBER || '+19135578312';
  if (!TWILIO_SID || !TWILIO_AUTH_TOKEN) throw new Error('SMS credentials unavailable');
  const res = await providerFetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
    method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`${TWILIO_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64') },
    body: new URLSearchParams({ To: to, From: TWILIO_SMS_NUMBER, Body: body }), signal: AbortSignal.timeout(5000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Twilio SMS ${data.code}: ${data.message}`);
  return { sid: data.sid, status: data.status };
}

export async function openRateLimitPr({ note = '', to = process.env.DEMO_PHONE || '+19132658472' } = {}) {
  const branch = `ari/rate-limit-${Date.now()}`;
  let state, url;
  try {
    state = JSON.parse(await readFile(STATE, 'utf8'));
    if (!state.validated || Date.now() - state.preparedAt > 24 * 3600000) throw new Error('Run demo prepare to validate a fresh PR base');
    const { stdout: head } = await git(['rev-parse', 'HEAD'], state.wt);
    if (head.trim() !== state.base) throw new Error('Prepared worktree was already used; prepare a fresh take');
    const patched = patchNginx(await readFile(path.join(state.wt, LB_FILE), 'utf8'));
    if (!patched.changed) throw new Error('Rate limiting is already present');
    await git(['switch', '-c', branch], state.wt);
    await writeFile(path.join(state.wt, LB_FILE), patched.out);
    const check = 'telemetry/check-rate-limit.sh';
    const configFile = 'telemetry/rate-limit-validation.conf';
    await writeFile(path.join(state.wt, configFile), extractNginx(patched.out));
    await writeFile(path.join(state.wt, check), `#!/usr/bin/env bash\nset -euo pipefail\ndir="$(cd "$(dirname "$0")" && pwd)"\nfile="$dir/fleet-roles/lb.sh"\ngrep -Fq '${ZONE}' "$file"\ngrep -Fq '${APPLY}' "$file"\ngrep -Fq 'limit_req_status 429;' "$file"\nbash -n "$file"\n# Run on a machine with nginx installed (for example the owned load balancer).\nnginx -t -c "$dir/rate-limit-validation.conf"\n`);
    await git(['add', LB_FILE, check, configFile], state.wt);
    await git(['commit', '-m', 'Add per-client request rate limiting to the reverse proxy'], state.wt, { env: ariCommitEnv() });
    await git(['push', '-u', 'origin', branch], state.wt);
    const bodyFile = path.join(state.wt, '.ari-pr-body.md');
    await writeFile(bodyFile, `Prepared by Ari in response to the incident.\n\nRequest floods can exhaust the MyFiat serving pool. This adds per-client nginx limiting at 10 requests/second with a burst of 20 and HTTP 429 responses.\n\nThe change is confined to a new branch and is not deployed by this action.\n\nValidation: generated nginx configuration passed nginx -t during demo preparation; bash telemetry/check-rate-limit.sh checks the committed template.\n${note ? '\n' + note + '\n' : ''}`);
    const { stdout } = await exec('gh', ['pr', 'create', '--repo', REPO_SLUG, '--base', 'main', '--head', branch,
      '--title', PR_TITLE, '--body-file', bodyFile], { cwd: state.wt, timeout: 15000 });
    url = stdout.trim();
    if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(url)) throw new Error('GitHub did not return a real PR URL');
    try {
      const sms = await sendSms(to, `Ari: rate-limiting PR is ready — ${url}`);
      return { ok: true, branch, url, smsStatus: sms.status, smsSid: sms.sid };
    } catch (error) { return { ok: false, branch, url, smsStatus: 'failed', error: error.message }; }
  } catch (error) { return { ok: false, branch, url, error: error.message }; }
}
