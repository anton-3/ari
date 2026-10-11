// @ts-check
const { test, expect } = require('@playwright/test');

/*
 * These assertions pin KNOWN-INTENTIONAL demo vulnerabilities in place. They
 * are NOT exploits — each makes a single probe and asserts the planted weakness
 * still surfaces, so that an *accidental* fix (or regression) by a sibling agent
 * is caught loudly. The real fixes are tracked in target-app/SECURITY-NOTES.md.
 */
test.describe('API: planted vulnerabilities (known intentional)', () => {
  test('IDOR: GET /api/users/:id leaks PII with no auth', async ({ request }) => {
    // No Authorization header on purpose — this is the broken-access-control vuln.
    const res = await request.get('/api/users/1');
    expect(res.status(), 'user 1 should be fetchable unauthenticated').toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ id: 1 });
    // Sensitive fields that should never be exposed like this.
    expect(body).toHaveProperty('email');
    expect(body).toHaveProperty('ssn_last4');
    expect(body).toHaveProperty('card_last4');
    expect(body).toHaveProperty('balance_cents');
  });

  test('IDOR: any user id is enumerable (user 2 differs from user 1)', async ({ request }) => {
    const u1 = await (await request.get('/api/users/1')).json();
    const u2res = await request.get('/api/users/2');
    expect(u2res.status()).toBe(200);
    const u2 = await u2res.json();
    expect(u2.id).toBe(2);
    expect(u2.email).not.toBe(u1.email);
  });

  test('SQL injection: a quote in transaction search surfaces a 500 SQL error', async ({ request }) => {
    // `x'` leaves an unbalanced quote in the concatenated SQL -> parse error.
    const res = await request.get('/api/transactions', { params: { user: "x'" } });
    expect(res.status(), 'expected the planted SQLi error path to 500').toBe(500);
    const body = await res.json();
    expect(body).toHaveProperty('error');
    const blob = `${body.error || ''} ${body.sql_hint || ''} ${body.stack || ''}`.toLowerCase();
    // The verbose-error vuln (#4) means the raw SQL engine error leaks through.
    expect(blob).toMatch(/sql|syntax|token|incomplete|near /);
  });
});
