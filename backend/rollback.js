// rollback_commit: revert a commit on a fresh branch and open a real pull request (never pushes to main).
// Works anywhere: uses GITHUB_TOKEN if set (server), else the local `gh` login (laptop).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sendSms } from './rate-limit-pr.js';

const exec = promisify(execFile);
const REPO_SLUG = process.env.GITHUB_REPO || 'anton-3/hackmid2026';

async function githubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  const { stdout } = await exec('gh', ['auth', 'token'], { timeout: 5000 });
  return stdout.trim();
}

async function gh(token, method, route, body) {
  const res = await fetch(`https://api.github.com${route}`, {
    method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'ari' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${data.message || 'request failed'}`);
  return data;
}

export async function rollbackCommit({ sha, reason = '', to = process.env.DEMO_PHONE || '+19132658472' } = {}) {
  if (!/^[0-9a-f]{7,40}$/i.test(String(sha || ''))) return { ok: false, error: 'that is not a commit SHA' };
  let token, dir;
  const scrub = (s) => String(s).replaceAll(token || '\0', '***');
  try {
    token = await githubToken();
    const commit = await gh(token, 'GET', `/repos/${REPO_SLUG}/commits/${sha}`);
    const full = commit.sha, short = full.slice(0, 7);
    const subject = commit.commit.message.split('\n')[0];
    const branch = `ari/revert-${short}`;
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 'Ari', GIT_COMMITTER_NAME: 'Ari',
      GIT_AUTHOR_EMAIL: process.env.ARI_PR_EMAIL || 'ari@myfiat.dev', GIT_COMMITTER_EMAIL: process.env.ARI_PR_EMAIL || 'ari@myfiat.dev' };
    const git = (args) => exec('git', args, { cwd: dir, env, timeout: 60000, maxBuffer: 1 << 22 });

    dir = await mkdtemp(path.join(tmpdir(), 'ari-revert-'));
    await exec('git', ['clone', '--quiet', '--filter=blob:none', `https://x-access-token:${token}@github.com/${REPO_SLUG}.git`, dir], { env, timeout: 120000 });
    await git(['checkout', '--quiet', '-b', branch, 'origin/main']);
    const merge = (commit.parents || []).length > 1;
    try {
      await git(['revert', '--no-edit', ...(merge ? ['-m', '1'] : []), full]);
    } catch {
      return { ok: false, sha: short, error: `reverting ${short} conflicts with later changes on main; it needs a manual revert` };
    }
    await git(['push', '--quiet', 'origin', branch]);
    const pr = await gh(token, 'POST', `/repos/${REPO_SLUG}/pulls`, {
      title: `Ari: Revert "${subject}"`, head: branch, base: 'main',
      body: `Reverts ${full}.\n\n${reason ? `Reason: ${reason}\n\n` : ''}Opened by Ari during an incident call. Review and merge to roll back.`,
    });
    const sms = await sendSms(to, `Ari: rollback PR for ${short} is ready — ${pr.html_url}`).catch(() => ({ status: 'failed' }));
    return { ok: true, sha: short, subject, branch, url: pr.html_url, number: pr.number, smsStatus: sms.status };
  } catch (error) {
    return { ok: false, error: scrub(error.message) };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
