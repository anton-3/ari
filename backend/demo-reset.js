// One durable reset per backend. The browser only starts/polls this operation.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { api, remote, prepareNextTake, preflight, verifyStandby } from './demo.js';
const exec = promisify(execFile);
const repo = fileURLToPath(new URL('../', import.meta.url));
const slug = process.env.GITHUB_REPO || 'anton-3/hackmid2026';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Restrict destructive cleanup to the branch recorded by our own PR job. A
// lease prevents deletion if somebody has since pushed a different commit.
export async function cleanupDemoPr(job, { run = exec, repository = slug } = {}) {
  if (job?.cleanupCompletedAt) return 'Demo PR and branch were already cleaned up';
  if (!job?.result?.branch) return 'No demo PR to clean up';
  const { branch, url } = job.result;
  if (!/^ari\/rate-limit-\d+$/.test(branch)) throw new Error('Refusing cleanup of an unrecognized branch');
  const gh = async args => (await run('gh', args, { cwd: repo, timeout: 15000 })).stdout;
  const refsPromise = gh(['api', `repos/${repository}/git/matching-refs/heads/${branch}`]).then(JSON.parse);
  // Attach a rejection handler while the independent PR request completes.
  refsPromise.catch(() => {});
  let pr;
  if (url) {
    if (!url.startsWith(`https://github.com/${repository}/pull/`) || !/\/pull\/\d+$/.test(url)) throw new Error('Demo PR belongs to a different repository');
    pr = JSON.parse(await gh(['api', `repos/${repository}/pulls/${url.split('/').at(-1)}`]));
  } else {
    const prs = JSON.parse(await gh(['api', `repos/${repository}/pulls?state=all&head=${repository.split('/')[0]}:${branch}`]));
    if (prs.length > 1) throw new Error('Cannot safely identify the demo PR; inspect the recorded branch');
    pr = prs[0];
  }
  if (pr && (pr.head?.ref !== branch || pr.head?.repo?.full_name !== repository || pr.base?.ref !== 'main' || pr.merged_at)) throw new Error('PR was merged or no longer matches the demo branch; cleanup stopped');
  const refs = await refsPromise;
  const ref = refs.find(r => r.ref === `refs/heads/${branch}`);
  const expectedSha = ref && (job.result.commitSha || (await run('git', ['rev-parse', `refs/heads/${branch}`], { cwd:repo, timeout:5000 })).stdout.trim());
  if (ref && ((pr && ref.object.sha !== pr.head.sha) || ref.object.sha !== expectedSha)) throw new Error('Demo branch changed after creation; cleanup stopped');
  if (pr && pr.state !== 'closed') await gh(['pr', 'close', String(pr.number), '--repo', repository]);
  if (ref) await run('git', ['push', `--force-with-lease=refs/heads/${branch}:${ref.object.sha}`, 'origin', `:refs/heads/${branch}`], { cwd: repo, timeout: 15000 });
  const [closed, remaining] = await Promise.all([
    pr ? gh(['api', `repos/${repository}/pulls/${pr.number}`]).then(JSON.parse) : null,
    gh(['api', `repos/${repository}/git/matching-refs/heads/${branch}`]).then(JSON.parse),
  ]);
  if ((closed && closed.state !== 'closed') || remaining.some(r => r.ref === `refs/heads/${branch}`)) throw new Error('GitHub cleanup could not be verified');
  return pr ? `PR #${pr.number} closed; remote branch removed` : 'No PR was published; demo branch cleanup verified';
}

const STEPS = [
 ['stop', 'Stop attack traffic'], ['infra', 'Remove bans and hide web-03'],
 ['github', 'Close the demo PR and remove its branch'], ['prepare', 'Prepare the next PR and warm standby'],
 ['drain', 'Wait for the real request window to clear'], ['verify', 'Verify everything is ready'],
];
export class DemoReset {
 constructor({ file = fileURLToPath(new URL('./.demo/reset.json', import.meta.url)), jobs, checkBusy = () => false, dependencies = {} } = {}) {
  this.file = file; this.jobs = jobs; this.checkBusy = checkBusy;
  this.deps = { api, remote, prepareNextTake, preflight, cleanupDemoPr, sleep, ...dependencies };
  this.state = { status: 'idle', steps: [] };
  try { this.state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch(e) { if (e.code !== 'ENOENT') throw e; }
  if (this.state.status === 'running') {
   this.state.status = 'failed'; this.state.error = 'Backend restarted during reset. Confirm again to safely resume cleanup.';
   this.save();
  }
 }
 get locked() { return ['running', 'failed'].includes(this.state.status); }
 save() {
  fs.mkdirSync(path.dirname(this.file), { recursive:true });
  fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.state), { mode:0o600 }); fs.renameSync(this.file + '.tmp', this.file);
 }
 start() {
  if (this.state.status === 'running') return this.state;
  if (this.checkBusy() || Object.values(this.jobs.jobs).some(j => j.status === 'running' || (j.status === 'uncertain' && /^(pr|block):/.test(j.id)))) {
   throw Object.assign(new Error('Ari still has a call or remediation in progress. Finish it before resetting.'), { status:409 });
  }
  const pr = Object.values(this.jobs.jobs).filter(j=>j.id.startsWith('pr:')).sort((a,b)=>(b.startedAt||0)-(a.startedAt||0))[0];
  this.state = { status:'running', startedAt:Date.now(), steps:STEPS.map(([id,label])=>({id,label,status:'pending'})), prJobId:pr?.id };
  this.save();
  this.promise = this.run(pr).catch(error=>{
   this.state.status='failed'; this.state.error=error.message; this.state.completedAt=Date.now(); this.save();
  });
  return this.state;
 }
 async step(id, run) {
  const step=this.state.steps.find(s=>s.id===id);
  Object.assign(step,{status:'running',startedAt:Date.now()});this.save();
  try {
   let detail;
   for(let attempt=0;;attempt++) {
    try { detail=await run(); break; }
    catch(error) {
     if(id==='drain'||attempt>=2||!/timeout|timed out|ECONN|fetch failed|unavailable|Command failed|telemetry 5/i.test(error.message)) throw error;
     step.detail='Connection interrupted; retrying…';this.save();await this.deps.sleep(500*(attempt+1));
    }
   }
   Object.assign(step,{status:'done',completedAt:Date.now(),detail:typeof detail==='string'&&detail?detail:undefined});this.save();
  }
  catch(error) { Object.assign(step,{status:'failed',detail:error.message});this.save();throw error; }
 }
 async run(pr) {
  const d=this.deps;
  // Leave maintenance enabled on failure. A retry repeats idempotent cleanup.
  let nodes;
  await this.step('stop',async()=>{
   await d.api('/api/demo/maintenance',{resetting:true});
   ({nodes}=await d.api('/api/fleet'));
   await d.remote(nodes.find(n=>n.role==='traffic'), 'systemctl stop ari-demo-attack; ! systemctl is-active --quiet ari-demo-attack');
   return 'Attack generator stopped';
  });
  await this.step('infra',async()=>{
   const deadline=Date.now()+30000;
   for (;;) {
    try { await d.api('/api/demo/reset',{}); break; }
    catch(e) { if (!/activation is still running/.test(e.message)||Date.now()>deadline) throw e; await d.sleep(500); }
   }
   const s=await d.api('/api/demo/status');
   if (s.incident.active || s.incident.blockedIps.length) throw new Error('Infra reset did not clear the incident and bans');
   verifyStandby(s, (await d.api('/api/fleet')).nodes);
   return 'web-03 is hidden, warm, and outside the serving pool';
  });
  const results=await Promise.allSettled([
   this.step('github',async()=>{
    const detail=await d.cleanupDemoPr(pr);
    if(pr) { pr.cleanupCompletedAt=Date.now();this.jobs.save?.(); }
    return detail;
   }),
   this.step('prepare',()=>d.prepareNextTake(nodes)),
   this.step('drain',async()=>{
    const deadline=Date.now()+240000;let stable=0;
    while(Date.now()<deadline) {
     const s=await d.api('/api/demo/status');
     const ms=s.cooldownRemainingMs;
     const step=this.state.steps.find(s=>s.id==='drain');
     step.detail=ms>0?`${Math.ceil(ms/1000)} seconds of observed attack traffic remain`:'Checking the baseline';this.save();
     const clean=ms===0&&!s.metrics.stale&&s.metrics.requestsLast180s>=90&&s.metrics.requestsLast180s<=600;
     stable=clean?stable+1:0;if(stable>=2)return 'Real requests have returned to the baseline';
     await d.sleep(1000);
    }
    throw new Error('Traffic window did not normalize; check the request feed and baseline generator');
   }),
  ]);
  const failed=results.filter(r=>r.status==='rejected');
  if(failed.length)throw new Error(failed.map(r=>r.reason.message).join('; '));
  await this.step('verify',async()=>{
   const nodes = (await d.api('/api/fleet')).nodes;
   verifyStandby(await d.api('/api/demo/status'), nodes);
   await d.preflight(nodes);
   await d.api('/api/demo/maintenance',{resetting:false});
   return 'Ready for another take';
  });
  this.state.status='done';this.state.completedAt=Date.now();this.save();
 }
}
