// Request counts are observations at ingress, never unique-IP/user estimates.
export function parseRequest(entry) {
  const m = entry.line.match(/^(\d+(?:\.\d+)?) (\d{3}) (\S+) "(\S+) (.*?) HTTP\/[^\"]+" (\d+) (\S+)(?: (\S+))?$/);
  if (!m) return null;
  const latency = Number(m[8]);
  return { id: entry.id, ts: Number(m[1]) * 1000, status: Number(m[2]), ip: m[3],
    method: m[4], path: m[5], bytes: Number(m[6]), upstream: m[7],
    latencyMs: Number.isFinite(latency) ? latency * 1000 : null };
}

export class RequestTelemetry {
  constructor() { this.entries = new Map(); this.observedAt = null; this.gap = false; this.gapUntil = 0; }
  ingest(batch) {
    const fresh = [];
    if (batch.gap) {
      this.gap = true;
      this.gapUntil = (batch.now ? batch.now * 1000 : this.observedAt ?? Date.now()) + 180000;
      this.entries.clear();
      return fresh;
    }
    for (const entry of batch.entries) {
      const record = parseRequest(entry);
      if (!record || this.entries.has(record.id)) continue;
      this.entries.set(record.id, record);
      fresh.push(record);
    }
    this.observedAt = batch.now * 1000;
    this.gap = false;
    for (const [id, record] of this.entries) if (record.ts < this.observedAt - 185000) this.entries.delete(id);
    return fresh;
  }
  window(seconds, now = this.observedAt) {
    return [...this.entries.values()].filter(r => r.ts > now - seconds * 1000 && r.ts <= now);
  }
  snapshot(incident = {}, now = Date.now()) {
    const observedAt = this.observedAt;
    const stale = observedAt == null || now - observedAt > 5000 || this.gap || observedAt < this.gapUntil;
    if (observedAt == null) return { ts: now, observedAt: null, source: 'nginx', stale: true,
      mode: 'normal', rps: 0, requestsLast180s: null, requestsPerMinute: null,
      windowSeconds: 180, rateWindowSeconds: 5, errorRate: 0, latencyMs: 0, bandwidthMbps: 0, activeUsers: 0, series: [] };
    const records = this.window(180);
    const history = this.window(185);
    const aggregate = t => {
      const slice = history.filter(r => r.ts > t - 5000 && r.ts <= t);
      const timed = slice.filter(r => r.latencyMs != null);
      return { t, rps: slice.length / 5, requestsPerMinute: slice.length * 12,
        errorRate: slice.length ? slice.filter(r => r.status >= 500).length / slice.length : 0,
        latencyMs: timed.length ? timed.reduce((sum, r) => sum + r.latencyMs, 0) / timed.length : 0,
        activeUsers: 0 };
    };
    const series = [];
    for (let t = Math.floor((observedAt - 180000) / 1000) * 1000; t <= observedAt; t += 1000) series.push(aggregate(t));
    const current = aggregate(observedAt);
    return { ...current, ts: observedAt, observedAt, source: 'nginx', stale,
      mode: incident.active ? 'surge' : 'normal', incidentId: incident.id || null,
      requestsLast180s: records.length, windowSeconds: 180, rateWindowSeconds: 5,
      bandwidthMbps: this.window(5).reduce((sum, r) => sum + r.bytes, 0) * 8 / 5e6, series };
  }
  logs(limit = 200) {
    return [...this.entries.values()].slice(-limit).map(r => ({ ...r, source: 'nginx',
      level: r.status >= 500 ? 'error' : r.status === 403 ? 'warn' : 'info',
      msg: `${r.method} ${r.path} → ${r.status}` }));
  }
}
