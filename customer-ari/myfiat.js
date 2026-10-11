// Thin client for the MyFiat app's API. Every call carries the signed-in user's
// Bearer token (handed to us by the chat/voice caller). The MyFiat API is
// implemented by a sibling service; we code against the documented contract and
// degrade gracefully when it's unreachable.
//
// Contract (base = MYFIAT_API_URL, default http://localhost:8071):
//   GET  /api/me /accounts /cards /subscriptions /holdings /alerts /insights /transactions
//   POST /api/cards/:id/renew | /freeze | /unfreeze
//   POST /api/subscriptions/:id/cancel
//   POST /api/alerts/:id/resolve  { action }
//   POST /api/transactions/:id/dispute

export const MYFIAT_API_URL = (process.env.MYFIAT_API_URL || "http://localhost:8071").replace(/\/$/, "");
const TIMEOUT_MS = Number(process.env.MYFIAT_TIMEOUT_MS || 5000);

// Thrown when the API is reachable but returns an error status.
export class ApiError extends Error {
  constructor(status, message) {
    super(message || `MyFiat API ${status}`);
    this.status = status;
  }
}
// Thrown when we can't reach the API at all (down, DNS, timeout).
export class ApiDownError extends Error {}

function authHeaders(token) {
  const h = { Accept: "application/json" };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function parse(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

export async function apiGet(path, token) {
  let res;
  try {
    res = await fetch(`${MYFIAT_API_URL}${path}`, {
      headers: authHeaders(token),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new ApiDownError(`can't reach MyFiat (${err.message})`);
  }
  const body = await parse(res);
  if (!res.ok) throw new ApiError(res.status, body?.error || body?.message || `HTTP ${res.status}`);
  return body;
}

export async function apiPost(path, body, token) {
  let res;
  try {
    res = await fetch(`${MYFIAT_API_URL}${path}`, {
      method: "POST",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new ApiDownError(`can't reach MyFiat (${err.message})`);
  }
  const data = await parse(res);
  if (!res.ok) throw new ApiError(res.status, data?.error || data?.message || `HTTP ${res.status}`);
  return data;
}

// --- shape helpers ---------------------------------------------------------
// The exact field names from the sibling service aren't pinned down, so we read
// defensively: a list may come back as a bare array or wrapped under a plural
// key, and money may be in cents (*_cents) or already in dollars.

export function asList(data, ...keys) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  for (const k of keys) if (Array.isArray(data[k])) return data[k];
  // Fall back to the first array-valued property.
  for (const v of Object.values(data)) if (Array.isArray(v)) return v;
  return [];
}

// Pull a dollar amount off a record, trying cents fields first.
export function money(obj, ...fields) {
  if (obj == null) return null;
  if (typeof obj === "number") return obj;
  const centsKeys = fields.flatMap((f) => [`${f}_cents`, `${f}Cents`]);
  for (const k of centsKeys) if (typeof obj[k] === "number") return obj[k] / 100;
  for (const f of fields) if (typeof obj[f] === "number") return obj[f];
  // Common generic fallbacks.
  for (const k of ["amount_cents", "balance_cents", "value_cents"]) if (typeof obj[k] === "number") return obj[k] / 100;
  for (const k of ["amount", "balance", "value", "price"]) if (typeof obj[k] === "number") return obj[k];
  return null;
}

export const usd = (n) =>
  n == null || Number.isNaN(n)
    ? "an unknown amount"
    : (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Best-effort label for a record across naming conventions.
export const label = (o, ...keys) => {
  for (const k of [...keys, "name", "merchant", "description", "title", "label", "nickname"])
    if (o && o[k]) return String(o[k]);
  return null;
};
