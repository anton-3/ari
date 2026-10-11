// Demo operations outlive phone transports and are deduplicated by incident.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export class DemoJobs {
  constructor(file = fileURLToPath(new URL('./.demo/jobs.json', import.meta.url)), emit = () => {}) {
    this.file = file;
    this.emit = emit;
    this.jobs = {};
    try { this.jobs = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    for (const job of Object.values(this.jobs)) {
      if (job.status === 'running') { job.status = 'uncertain'; job.error = 'Backend restarted; verify external outcome before retrying.'; }
    }
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.jobs), { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
  }
  start(key, run) {
    if (this.jobs[key]) return this.jobs[key];
    const job = { id: key, status: 'running', startedAt: Date.now() };
    this.jobs[key] = job;
    this.save();
    Promise.resolve().then(run).then(result => {
      Object.assign(job, { status: result?.ok === false ? 'failed' : 'done', result, completedAt: Date.now() });
      this.save();
      this.emit(job);
    }, error => {
      Object.assign(job, { status: 'failed', error: error.message, completedAt: Date.now() });
      this.save();
      this.emit(job);
    });
    return job;
  }
}

export async function narrate(text) {
  try {
    await fetch(`${process.env.TELEMETRY_URL || 'http://localhost:8090'}/api/reasoning`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(2000),
    });
  } catch { /* The job result remains available even if narration is offline. */ }
}

export const demoJobs = new DemoJobs(undefined, job => {
  const result = job.result;
  const message = job.status === 'done'
    ? result?.url ? `Rate-limiting PR created: ${result.url}. SMS ${result.smsStatus}.` : `${job.id.split(':')[0]} completed.`
    : `${job.id.split(':')[0]} failed: ${job.error || result?.error || 'unknown error'}`;
  void narrate(message);
});
