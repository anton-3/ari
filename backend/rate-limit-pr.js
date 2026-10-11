// Ari's "add rate limiting as a PR" action. Creates a clean branch off origin/main
// in a throwaway git worktree (so it never disturbs the live working tree), adds
// nginx rate limiting to the load balancer config, opens a GitHub PR with `gh`, and
// texts the caller the PR link. Everything is on the team's own repo/fleet.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, ".."); // backend/ -> repo root
const REPO_SLUG = process.env.GITHUB_REPO || "anton-3/hackmid2026";
const LB_FILE = "telemetry/fleet-roles/lb.sh"; // nginx config lives here
const { DEMO_PHONE = "+19132658472" } = process.env;
const { TWILIO_SID, TWILIO_AUTH_TOKEN, TWILIO_SMS_NUMBER = "+19135578312" } = process.env;

const ZONE = "limit_req_zone $binary_remote_addr zone=ari_rl:10m rate=10r/s;";
const APPLY = "limit_req zone=ari_rl burst=20 nodelay;";

const git = (args, cwd = REPO) => exec("git", args, { cwd, maxBuffer: 1 << 24 });

async function sendSms(to, body) {
  if (!TWILIO_SID || !TWILIO_AUTH_TOKEN) return false;
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from(`${TWILIO_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64") },
    body: new URLSearchParams({ To: to, From: TWILIO_SMS_NUMBER, Body: body }),
  });
  return res.ok;
}

// Insert the rate-limit directives at the marker comments the lb template carries.
// Falls back to adding them to the http/server blocks if the markers aren't present.
function patchNginx(src) {
  let out = src;
  let changed = false;
  if (out.includes("# ari:rate-limit-zone")) {
    out = out.replace(/([ \t]*)# ari:rate-limit-zone/, `$1# ari:rate-limit-zone\n$1${ZONE}`);
    changed = true;
  } else if (/\n(\s*)http\s*{/.test(out)) {
    out = out.replace(/(\n(\s*)http\s*{[^\n]*\n)/, `$1$2    ${ZONE}\n`);
    changed = true;
  }
  if (out.includes("# ari:rate-limit-apply")) {
    out = out.replace(/([ \t]*)# ari:rate-limit-apply/, `$1# ari:rate-limit-apply\n$1${APPLY}`);
    changed = true;
  } else if (/location\s+\/\s*{/.test(out)) {
    out = out.replace(/(location\s+\/\s*{[^\n]*\n)(\s*)/, `$1$2${APPLY}\n$2`);
    changed = true;
  }
  return { out, changed };
}

export async function openRateLimitPr({ note = "" } = {}) {
  const branch = `ari/rate-limit-${Date.now()}`;
  let wt;
  try {
    await git(["fetch", "origin", "main"]);
    wt = await mkdtemp(path.join(tmpdir(), "ari-pr-"));
    await git(["worktree", "add", "-b", branch, wt, "origin/main"]);

    const abs = path.join(wt, LB_FILE);
    const src = await readFile(abs, "utf8");
    const { out, changed } = patchNginx(src);
    if (!changed) throw new Error("couldn't find an nginx block to add rate limiting to");
    await writeFile(abs, out);

    const title = "Add rate limiting to the reverse proxy";
    const body =
      `Adds nginx request rate limiting at the load balancer to harden against request floods:\n\n` +
      `- \`${ZONE}\` in the http context\n- \`${APPLY}\` on the proxy location\n\n` +
      (note ? `${note}\n\n` : "") +
      `Opened automatically by Ari during an incident.\n\n` +
      `🤖 Generated with [Claude Code](https://claude.com/claude-code)`;

    await git(["-C", wt, "add", "-A"]);
    await git([
      "-C", wt, "commit", "-m",
      `Add rate limiting to the reverse proxy\n\nAdds nginx limit_req_zone + limit_req at the load balancer.\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`,
    ]);
    await git(["-C", wt, "push", "-u", "origin", branch]);

    // Open the PR with gh (user runs `gh auth login` beforehand).
    let url = "";
    try {
      const { stdout } = await exec(
        "gh",
        ["pr", "create", "--repo", REPO_SLUG, "--base", "main", "--head", branch, "--title", title, "--body", body],
        { cwd: wt },
      );
      url = (stdout.match(/https:\/\/github\.com\/\S+/) || [""])[0].trim();
    } catch (e) {
      // Push succeeded; fall back to the "open a PR" compare link.
      url = `https://github.com/${REPO_SLUG}/pull/new/${branch}`;
    }

    await sendSms(DEMO_PHONE, `Ari: rate-limiting PR is up — ${url}`);
    return { ok: true, branch, url };
  } catch (err) {
    return { ok: false, error: err.message, branch };
  } finally {
    if (wt) await git(["worktree", "remove", "--force", wt]).catch(() => {});
    await git(["branch", "-D", branch]).catch(() => {});
  }
}
