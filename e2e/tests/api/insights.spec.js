// @ts-check
const { test, expect } = require('@playwright/test');
const { adminToken, getJson, notImplemented, NOT_IMPL_NOTE } = require('../helpers');

test.describe('API: insights', () => {
  let token;
  test.beforeEach(async ({ request }) => { token = await adminToken(request); });

  test('GET /api/insights returns a non-empty analytics payload', async ({ request }) => {
    const { status, body } = await getJson(request, '/api/insights', token);
    test.skip(notImplemented(status), NOT_IMPL_NOTE);
    expect(status).toBe(200);
    expect(body).toBeTruthy();
    // Shape is open-ended in the contract; assert it carries SOME structured data.
    const isNonEmptyObject = body && typeof body === 'object' && Object.keys(body).length > 0;
    expect(isNonEmptyObject).toBeTruthy();
  });
});
