// @ts-check
const { test, expect } = require('@playwright/test');
const { adminToken, getJson, postJson, authHeaders, asArray, notImplemented, NOT_IMPL_NOTE } = require('../helpers');

async function fetchCards(request, token) {
  const { status, body } = await getJson(request, '/api/cards', token);
  return { status, cards: asArray(body, 'cards') };
}

const cardStatus = (c) => (c && (c.status || c.state) || '').toLowerCase();

test.describe('API: cards', () => {
  let token;
  test.beforeEach(async ({ request }) => { token = await adminToken(request); });

  test('GET /api/cards returns cards with the expected shape', async ({ request }) => {
    const { status, cards } = await fetchCards(request, token);
    test.skip(notImplemented(status), NOT_IMPL_NOTE);
    expect(status).toBe(200);
    test.skip(cards.length === 0, 'no cards seeded yet');
    const c = cards[0];
    expect(c).toHaveProperty('last4');
    expect(c).toHaveProperty('exp_year');
    expect(c).toHaveProperty('status');
  });

  test('freeze then unfreeze a card toggles its status', async ({ request }) => {
    const { status, cards } = await fetchCards(request, token);
    test.skip(notImplemented(status), NOT_IMPL_NOTE);
    const card = cards.find((c) => cardStatus(c) !== 'frozen') || cards[0];
    test.skip(!card, 'no card available to freeze');

    const frozen = await postJson(request, `/api/cards/${card.id}/freeze`, token);
    test.skip(notImplemented(frozen.status), NOT_IMPL_NOTE);
    expect(frozen.res.ok(), `freeze returned ${frozen.status}`).toBeTruthy();

    const afterFreeze = (await fetchCards(request, token)).cards.find((c) => c.id === card.id);
    expect(cardStatus(afterFreeze)).toBe('frozen');

    const unfroze = await postJson(request, `/api/cards/${card.id}/unfreeze`, token);
    expect(unfroze.res.ok(), `unfreeze returned ${unfroze.status}`).toBeTruthy();
    const afterUnfreeze = (await fetchCards(request, token)).cards.find((c) => c.id === card.id);
    expect(cardStatus(afterUnfreeze)).toBe('active');
  });

  test('renew an expiring card bumps the expiry year and sets it active', async ({ request }) => {
    const { status, cards } = await fetchCards(request, token);
    test.skip(notImplemented(status), NOT_IMPL_NOTE);
    test.skip(cards.length === 0, 'no cards to renew');

    // Prefer a card flagged expiring/expired; otherwise just renew the first.
    const target = cards.find((c) => cardStatus(c) === 'expired') ||
      cards.slice().sort((a, b) => (a.exp_year - b.exp_year))[0];
    test.skip(!target, 'no card available to renew');
    const beforeYear = Number(target.exp_year);

    const renew = await request.post(`/api/cards/${target.id}/renew`, { headers: authHeaders(token) });
    test.skip(notImplemented(renew.status()), NOT_IMPL_NOTE);
    expect(renew.ok(), `renew returned ${renew.status()}`).toBeTruthy();

    const after = (await fetchCards(request, token)).cards.find((c) => c.id === target.id);
    expect(Number(after.exp_year)).toBeGreaterThan(beforeYear);
    expect(cardStatus(after)).toBe('active');
  });
});
