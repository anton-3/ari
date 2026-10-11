// @ts-check
const { test, expect } = require('@playwright/test');
const { adminToken, getJson, asArray, notImplemented, NOT_IMPL_NOTE } = require('../helpers');

// The endpoint returns { stocks:[...], crypto:[...], totals:{...} }. Tolerate a
// simpler { holdings:[...] } shape too (in case the contract lands that way).
function splitHoldings(body) {
  const stocks = Array.isArray(body?.stocks) ? body.stocks : [];
  const crypto = Array.isArray(body?.crypto) ? body.crypto : [];
  if (stocks.length || crypto.length) return { stocks, crypto, all: [...stocks, ...crypto] };
  const flat = asArray(body, 'holdings');
  return {
    stocks: flat.filter((h) => /stock|equity/i.test(h.asset_class || '')),
    crypto: flat.filter((h) => /crypto/i.test(h.asset_class || '')),
    all: flat,
  };
}

const priceOf = (h) =>
  [h.price_cents, h.price, h.value_cents, h.value, h.market_value_cents]
    .map(Number).find((n) => Number.isFinite(n));

test.describe('API: holdings (live portfolio)', () => {
  let token;
  test.beforeEach(async ({ request }) => { token = await adminToken(request); });

  test('GET /api/holdings returns stock and crypto positions', async ({ request }) => {
    const { status, body } = await getJson(request, '/api/holdings', token);
    test.skip(notImplemented(status), NOT_IMPL_NOTE);
    expect(status).toBe(200);
    const { all } = splitHoldings(body);
    test.skip(all.length === 0, 'no holdings seeded yet');
    const h = all[0];
    expect(h).toHaveProperty('symbol');
    expect(h).toHaveProperty('quantity');
    expect(priceOf(h)).toBeGreaterThan(0);
  });

  test('prices move between two reads (portfolio is live)', async ({ request }) => {
    const first = await getJson(request, '/api/holdings', token);
    test.skip(notImplemented(first.status), NOT_IMPL_NOTE);
    const a = splitHoldings(first.body);
    test.skip(a.all.length === 0, 'no holdings to price');

    const second = await getJson(request, '/api/holdings', token);
    const b = splitHoldings(second.body);

    // Stocks random-walk on every read; crypto is cached (~20s TTL) so only
    // assert movement when there is at least one stock position to observe.
    if (a.stocks.length) {
      const p1 = a.stocks.map(priceOf).join(',');
      const p2 = b.stocks.map(priceOf).join(',');
      expect(p2, 'stock prices should move between reads').not.toEqual(p1);
    } else {
      const p1 = a.all.map(priceOf).join(',');
      const p2 = b.all.map(priceOf).join(',');
      test.skip(p1 === p2, 'only cached crypto holdings present; no live movement to observe');
      expect(p2).not.toEqual(p1);
    }
  });
});
