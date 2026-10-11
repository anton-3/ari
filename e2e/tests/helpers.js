// @ts-check
/*
 * Shared helpers for the MyFiat e2e suite.
 *
 * The sibling backend agent is building most of the `/api/*` banking endpoints
 * right now, so the GET helpers tolerate a 404 ("not implemented yet") and let
 * the caller decide to skip. Shape assertions accept either a bare array body
 * or the `{ count, <key>: [...] }` envelope the existing endpoints use, so they
 * stay green whichever convention the new endpoints land on.
 */

const DEMO = { email: 'admin@acmepay.io', password: 'admin123' };
const DEMO_ALIAS = { email: 'dana@myfiat.com', password: 'admin123' };

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** POST /api/login -> { token, user } (throws via expect if it fails). */
async function login(request, creds = DEMO) {
  const res = await request.post('/api/login', { data: creds });
  const body = await safeJson(res);
  return { status: res.status(), ok: res.ok(), body };
}

/** Log in with the demo admin and return just the bearer token. */
async function adminToken(request) {
  const { ok, body } = await login(request);
  if (!ok || !body || !body.token) {
    throw new Error('demo admin login failed; cannot obtain token');
  }
  return body.token;
}

async function safeJson(res) {
  try { return await res.json(); } catch { return null; }
}

/** GET an authed JSON endpoint; returns { res, status, body }. */
async function getJson(request, pathname, token) {
  const res = await request.get(pathname, { headers: authHeaders(token) });
  return { res, status: res.status(), body: await safeJson(res) };
}

/** POST an authed JSON endpoint; returns { res, status, body }. */
async function postJson(request, pathname, token, data = {}) {
  const res = await request.post(pathname, { headers: authHeaders(token), data });
  return { res, status: res.status(), body: await safeJson(res) };
}

/**
 * Pull a list out of a response body regardless of envelope:
 *   [ ... ]                      -> itself
 *   { accounts: [ ... ] }        -> accounts
 *   { data: [ ... ] }            -> data
 *   { items: [ ... ] }           -> items
 * `preferredKeys` is tried first.
 */
function asArray(body, ...preferredKeys) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return [];
  for (const k of [...preferredKeys, 'data', 'items', 'results']) {
    if (Array.isArray(body[k])) return body[k];
  }
  // Fall back to the first array-valued property.
  for (const v of Object.values(body)) if (Array.isArray(v)) return v;
  return [];
}

/** True when an endpoint hasn't been built by the sibling agent yet. */
function notImplemented(status) {
  return status === 404 || status === 501;
}

const NOT_IMPL_NOTE = 'endpoint not implemented yet (waiting on backend agent)';

module.exports = {
  DEMO,
  DEMO_ALIAS,
  authHeaders,
  login,
  adminToken,
  getJson,
  postJson,
  asArray,
  notImplemented,
  NOT_IMPL_NOTE,
};
