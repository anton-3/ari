// @ts-check
const { test, expect } = require('@playwright/test');
const { adminToken, authHeaders, notImplemented, NOT_IMPL_NOTE } = require('../helpers');

test.describe('API: transactions', () => {
  test('search returns the documented envelope', async ({ request }) => {
    const res = await request.get('/api/transactions', { params: { pageSize: 5, page: 1 } });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body).toMatchObject({ page: 1, pageSize: 5 });
    expect(Array.isArray(body.transactions)).toBeTruthy();
    expect(body.count).toBe(body.transactions.length);
    if (body.transactions.length) {
      expect(body.transactions[0]).toHaveProperty('id');
      expect(body.transactions[0]).toHaveProperty('amount_cents');
      expect(body.transactions[0]).toHaveProperty('status');
    }
  });

  test('pagination: pageSize is respected', async ({ request }) => {
    const res = await request.get('/api/transactions', { params: { pageSize: 3, page: 1 } });
    const body = await res.json();
    expect(body.transactions.length).toBeLessThanOrEqual(3);
  });

  test('pagination: page 2 differs from page 1', async ({ request }) => {
    const p1 = await (await request.get('/api/transactions', { params: { pageSize: 5, page: 1 } })).json();
    const p2 = await (await request.get('/api/transactions', { params: { pageSize: 5, page: 2 } })).json();
    test.skip(p1.transactions.length < 5 || p2.transactions.length === 0,
      'not enough rows to compare two pages');
    const ids1 = p1.transactions.map((t) => t.id).sort();
    const ids2 = p2.transactions.map((t) => t.id).sort();
    expect(ids1).not.toEqual(ids2);
  });

  test('pageSize is clamped to a sane maximum', async ({ request }) => {
    const res = await request.get('/api/transactions', { params: { pageSize: 100000, page: 1 } });
    const body = await res.json();
    expect(body.transactions.length).toBeLessThanOrEqual(100);
  });

  test('benign search term filters results', async ({ request }) => {
    const res = await request.get('/api/transactions', { params: { user: 'Dana', pageSize: 50 } });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    // Dana Admin is the seeded admin; every returned row should match that user.
    for (const t of body.transactions) {
      if (t.user_name) expect(t.user_name).toMatch(/Dana/i);
    }
  });

  test('dispute a transaction changes its status', async ({ request }) => {
    const token = await adminToken(request);
    const list = await (await request.get('/api/transactions', { params: { pageSize: 5 } })).json();
    const txId = list.transactions?.[0]?.id;
    test.skip(!txId, 'no transactions available to dispute');

    const res = await request.post(`/api/transactions/${txId}/dispute`, { headers: authHeaders(token) });
    test.skip(notImplemented(res.status()), NOT_IMPL_NOTE);
    expect(res.ok(), `dispute returned ${res.status()}`).toBeTruthy();
    const body = await res.json();
    const status = (body.transaction?.status || body.status || '').toLowerCase();
    expect(status).toMatch(/dispute/);
  });
});
