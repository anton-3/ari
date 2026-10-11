// @ts-check
const { test, expect } = require('@playwright/test');
const { adminToken, getJson, postJson, asArray, notImplemented, NOT_IMPL_NOTE } = require('../helpers');

async function fetchSubs(request, token) {
  const { status, body } = await getJson(request, '/api/subscriptions', token);
  return { status, subs: asArray(body, 'subscriptions') };
}

const subStatus = (s) => (s && s.status || '').toLowerCase();

// Monthly-equivalent total of the ACTIVE subscriptions, in cents.
function activeMonthly(subs) {
  return subs
    .filter((s) => subStatus(s) === 'active')
    .reduce((sum, s) => {
      const amt = Number(s.amount_cents) || 0;
      const cad = (s.cadence || 'monthly').toLowerCase();
      const factor = cad === 'yearly' ? 1 / 12 : cad === 'weekly' ? 52 / 12 : 1;
      return sum + amt * factor;
    }, 0);
}

test.describe('API: subscriptions', () => {
  let token;
  test.beforeEach(async ({ request }) => { token = await adminToken(request); });

  test('GET /api/subscriptions returns subscriptions with the expected shape', async ({ request }) => {
    const { status, subs } = await fetchSubs(request, token);
    test.skip(notImplemented(status), NOT_IMPL_NOTE);
    expect(status).toBe(200);
    test.skip(subs.length === 0, 'no subscriptions seeded yet');
    const s = subs[0];
    expect(s).toHaveProperty('amount_cents');
    expect(s).toHaveProperty('cadence');
    expect(s).toHaveProperty('status');
  });

  test('cancelling a subscription drops it from the active monthly total', async ({ request }) => {
    const { status, subs } = await fetchSubs(request, token);
    test.skip(notImplemented(status), NOT_IMPL_NOTE);
    const active = subs.find((s) => subStatus(s) === 'active');
    test.skip(!active, 'no active subscription to cancel');

    const before = activeMonthly(subs);
    const res = await postJson(request, `/api/subscriptions/${active.id}/cancel`, token);
    test.skip(notImplemented(res.status), NOT_IMPL_NOTE);
    expect(res.res.ok(), `cancel returned ${res.status}`).toBeTruthy();

    const after = await fetchSubs(request, token);
    const canceled = after.subs.find((s) => s.id === active.id);
    expect(subStatus(canceled)).toMatch(/cancel/); // 'canceled' / 'cancelled'
    expect(activeMonthly(after.subs)).toBeLessThan(before);
  });
});
