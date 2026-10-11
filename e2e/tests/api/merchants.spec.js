// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('API: merchants', () => {
  test('GET /api/merchants returns a list with the expected shape', async ({ request }) => {
    const res = await request.get('/api/merchants');
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body.merchants)).toBeTruthy();
    expect(body.count).toBe(body.merchants.length);
    expect(body.merchants.length).toBeGreaterThan(0);
    const m = body.merchants[0];
    expect(m).toHaveProperty('id');
    expect(m).toHaveProperty('name');
    expect(m).toHaveProperty('category');
    expect(m).toHaveProperty('country');
  });
});
