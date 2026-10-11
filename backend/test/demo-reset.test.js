import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DemoReset, cleanupDemoPr } from '../demo-reset.js';

function setup(overrides={}) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ari-reset-test-'));
 const events=[];
 let cool=2000;
 const jobs={jobs:{}};
 const deps={
  api:async(route,body)=>{
   events.push(route);
   if(route==='/api/fleet')return {nodes:[{role:'traffic'}]};
   if(route==='/api/demo/status')return {incident:{active:false,blockedIps:[]},standby:{id:'standby',status:'running',servingState:'standby',inUpstream:false},metrics:{stale:false,requestsLast180s:180},cooldownRemainingMs:cool};
   if(route==='/api/demo/maintenance')events.push(`maintenance:${body.resetting}`);
   return {ok:true};
  },
  remote:async()=>{events.push('stop');},
  prepareNextTake:async()=>{events.push('prepare');},
  cleanupDemoPr:async()=>{events.push('github');},
  preflight:async()=>{events.push('verify');},
  sleep:async()=>{cool=0;},...overrides,
 };
 const reset=new DemoReset({file:path.join(dir,'reset.json'),jobs,dependencies:deps});
 return {reset,events,jobs,dir};
}
test('reset is durable, deduplicated, pauses incidents, drains real traffic and verifies before unlocking',async()=>{
 const {reset,events,dir}=setup();
 const first=reset.start();assert.equal(reset.start(),first);await reset.promise;
 assert.equal(reset.state.status,'done');assert.ok(reset.state.steps.every(s=>s.status==='done'));
 assert.equal(events.filter(e=>e==='stop').length,1);
 assert.ok(events.indexOf('maintenance:true')<events.indexOf('stop'));
 assert.ok(events.indexOf('verify')<events.indexOf('maintenance:false'));
 assert.equal(JSON.parse(fs.readFileSync(reset.file)).status,'done');
 fs.rmSync(dir,{recursive:true});
});
test('parallel failure waits for all work, stays locked, then a retry recovers',async()=>{
 let fail=true;
 const {reset,events,dir}=setup({cleanupDemoPr:async()=>{if(fail)throw new Error('GitHub permission denied');}});
 reset.start();await reset.promise;
 assert.equal(reset.state.status,'failed');assert.equal(reset.locked,true);
 assert.ok(reset.state.steps.find(s=>s.id==='prepare').status==='done');
 assert.ok(!events.includes('maintenance:false'));
 fail=false;reset.start();await reset.promise;assert.equal(reset.state.status,'done');
 fs.rmSync(dir,{recursive:true});
});
test('active or uncertain remediation refuses reset; restart never claims readiness',()=>{
 const {reset,jobs,dir}=setup();jobs.jobs.x={id:'pr:x',status:'uncertain'};
 assert.throws(()=>reset.start(),/in progress/);
 fs.writeFileSync(reset.file,JSON.stringify({status:'running',steps:[]}));
 const restarted=new DemoReset({file:reset.file,jobs});
 assert.equal(restarted.state.status,'failed');assert.equal(restarted.locked,true);
 fs.rmSync(dir,{recursive:true});
});
test('PR cleanup validates ownership, closes only its PR, deletes with an exact SHA lease, and verifies',async()=>{
 const calls=[];let closed=false,deleted=false;
 const branch='ari/rate-limit-123';const sha='abc';const repository='owner/repo';
 const job={result:{branch,commitSha:sha,url:'https://github.com/owner/repo/pull/3'}};
 const run=async(bin,args)=>{
  calls.push([bin,args]);
  if(bin==='git'){assert.ok(args.includes(`--force-with-lease=refs/heads/${branch}:${sha}`));deleted=true;return {stdout:''};}
  if(args[0]==='pr'){closed=true;return {stdout:''};}
  if(args[1].includes('matching-refs'))return {stdout:JSON.stringify(deleted?[]:[{ref:`refs/heads/${branch}`,object:{sha}}])};
  return {stdout:JSON.stringify({number:3,state:closed?'closed':'open',head:{ref:branch,sha,repo:{full_name:repository}},base:{ref:'main'},merged_at:null})};
 };
 assert.match(await cleanupDemoPr(job,{run,repository}),/closed/);
 assert.equal(calls.filter(([bin])=>bin==='git').length,1);
 await cleanupDemoPr(job,{run,repository});
 assert.equal(calls.filter(([bin])=>bin==='git').length,1);
});
test('PR cleanup refuses unrelated, merged, or edited branches before mutating GitHub',async()=>{
 const repository='owner/repo';const branch='ari/rate-limit-123';
 const job={result:{branch,commitSha:'original',url:'https://github.com/owner/repo/pull/3'}};
 for(const mode of ['merged','edited','foreign']) {
  const run=async(bin,args)=>{
   assert.equal(bin,'gh');assert.equal(args[0],'api');
   if(args[1].includes('matching-refs'))return {stdout:JSON.stringify([{ref:`refs/heads/${branch}`,object:{sha:'changed'}}])};
   return {stdout:JSON.stringify({head:{ref:branch,sha:'changed',repo:{full_name:mode==='foreign'?'other/repo':repository}},base:{ref:'main'},merged_at:mode==='merged'?'yes':null})};
  };
  await assert.rejects(cleanupDemoPr(job,{run,repository}),/cleanup stopped/);
 }
});
test('an unpublished PR failure is safe to reset and an already cleaned job needs no network requests',async()=>{
 const job={result:{branch:'ari/rate-limit-123'}};
 const run=async(bin,args)=>{
  assert.equal(bin,'gh');assert.equal(args[0],'api');return {stdout:'[]'};
 };
 assert.match(await cleanupDemoPr(job,{run,repository:'owner/repo'}),/No PR was published/);
 job.cleanupCompletedAt=Date.now();
 assert.match(await cleanupDemoPr(job,{run:()=>{throw new Error('unexpected request');}}),/already cleaned/);
});
test('failed final readiness never releases maintenance or claims the next demo is ready',async()=>{
 const {reset,events,dir}=setup({preflight:async()=>{throw new Error('Voice tunnel is down');}});
 reset.start();await reset.promise;
 assert.equal(reset.state.status,'failed');assert.equal(reset.state.steps.find(s=>s.id==='verify').status,'failed');
 assert.ok(!events.includes('maintenance:false'));fs.rmSync(dir,{recursive:true});
});

test('reset refuses success when standby is still visible or still in the serving pool', async () => {
 for (const mode of ['visible', 'upstream']) {
  const { reset, events, dir } = setup({
   api: async (route) => {
    if (route === '/api/fleet') return {nodes: mode === 'visible' ? [{id:'standby',label:'web-03'}] : []};
    if (route === '/api/demo/status') return {
     incident:{active:false,blockedIps:[]},
     standby:{id:'standby',status:'running',servingState:'standby',inUpstream:mode==='upstream'},
    };
    return {ok:true};
   },
  });
  reset.start(); await reset.promise;
  assert.equal(reset.state.status, 'failed');
  assert.match(reset.state.error, /hidden.*serving pool/);
  assert.ok(!events.includes('verify'));
  fs.rmSync(dir,{recursive:true});
 }
});
