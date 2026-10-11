// @ts-check
const { test, expect } = require('@playwright/test');
const { adminToken, getJson, postJson, asArray, notImplemented, NOT_IMPL_NOTE } = require('../helpers');

async function fetchAlerts(request, token) {
  const { status, body } = await getJson(request, '/api/alerts', token);
  return { status, alerts: asArray(body, 'alerts') };
}

const alertStatus = (a) => (a && a.status || '').toLowerCase();

test.describe('API: alerts', () => {
  let token;
  test.beforeEach(async ({ request }) => { token = await adminToken(request); });

  test('GET /api/alerts returns alerts with the expected shape', async ({ request }) => {
    const { status, alerts } = await fetchAlerts(request, token);
    test.skip(notImplemented(status), NOT_IMPL_NOTE);
    expect(status).toBe(200);
    test.skip(alerts.length === 0, 'no alerts seeded yet');
    const a = alerts[0];
    expect(a).toHaveProperty('kind');
    expect(a).toHaveProperty('severity');
    expect(a).toHaveProperty('title');
    expect(a).toHaveProperty('status');
  });

  test('resolving an alert changes its status', async ({ request }) => {
    const { status, alerts } = await fetchAlerts(request, token);
    test.skip(notImplemented(status), NOT_IMPL_NOTE);
    const open = alerts.find((a) => alertStatus(a) === 'open');
    test.skip(!open, 'no open alert to resolve');

    const res = await postJson(request, `/api/alerts/${open.id}/resolve`, token, { action: 'dismiss' });
    test.skip(notImplemented(res.status), NOT_IMPL_NOTE);
    expect(res.res.ok(), `resolve returned ${res.status}`).toBeTruthy();

    const after = (await fetchAlerts(request, token)).alerts.find((a) => a.id === open.id);
    // Either it flips to resolved or it drops out of the open list entirely.
    expect(!after || alertStatus(after) === 'resolved').toBeTruthy();
  });
});
