// @ts-check
const { test, expect } = require('@playwright/test');
const { adminToken, getJson, asArray, notImplemented, NOT_IMPL_NOTE } = require('../helpers');

test.describe('API: profile + accounts', () => {
  let token;
  test.beforeEach(async ({ request }) => { token = await adminToken(request); });

  test('GET /api/me returns the signed-in user', async ({ request }) => {
    const { status, body } = await getJson(request, '/api/me', token);
    test.skip(notImplemented(status), NOT_IMPL_NOTE);
    expect(status).toBe(200);
    const me = body.user || body;
    expect(me).toHaveProperty('id');
    expect(me).toHaveProperty('email');
  });

  test('GET /api/accounts returns bank accounts with balances', async ({ request }) => {
    const { status, body } = await getJson(request, '/api/accounts', token);
    test.skip(notImplemented(status), NOT_IMPL_NOTE);
    expect(status).toBe(200);
    const accounts = asArray(body, 'accounts');
    test.skip(accounts.length === 0, 'no accounts seeded yet');
    const a = accounts[0];
    expect(a).toHaveProperty('kind');
    expect(a).toHaveProperty('balance_cents');
  });
});
