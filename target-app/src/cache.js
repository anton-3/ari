/*
 * AcmePay - optional Redis cache (enabled only when REDIS_URL is set).
 * Two small uses: a per-endpoint request counter, and a short-TTL cache for
 * GET /api/merchants. With no REDIS_URL, or while Redis is unreachable, every
 * helper is a no-op passthrough: the cache can never block or fail a request.
 */
import { createClient } from 'redis';

let client = null;
let lastErrLog = 0;

if (process.env.REDIS_URL) {
  client = createClient({
    url: process.env.REDIS_URL,
    disableOfflineQueue: true, // fail fast instead of queueing while disconnected
    socket: {
      connectTimeout: 2000,
      keepAlive: 5000,
      reconnectStrategy: (retries) => Math.min(500 * (retries + 1), 5000),
    },
  });
  client.on('error', (err) => {
    if (Date.now() - lastErrLog > 30000) { lastErrLog = Date.now(); console.error('[acmepay] redis error:', err.message); }
  });
  client.connect().catch(() => {});
}

const ready = () => client && client.isReady;

// Resolve `p`, or `fallback` after `ms` (a hung socket must not hang a request).
const within = (p, ms, fallback) => Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))]);

// Fire-and-forget request counter, e.g. acmepay:hits:GET /api/merchants
export function countRequest(method, route) {
  if (!ready()) return;
  client.hIncrBy('acmepay:hits', `${method} ${route}`, 1).catch(() => {});
}

// Return cached JSON for `key`, else compute via `fn`, store for `ttlSec`.
export async function cached(key, ttlSec, fn) {
  if (!ready()) return fn();
  try {
    const hit = await within(client.get(key), 250, null);
    if (hit) return JSON.parse(hit);
  } catch { /* fall through to the db */ }
  const value = await fn();
  if (ready()) client.set(key, JSON.stringify(value), { EX: ttlSec }).catch(() => {});
  return value;
}
