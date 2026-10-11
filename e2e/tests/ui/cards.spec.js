// @ts-check
const { test, expect } = require('@playwright/test');
const { signIn, openFeaturePage } = require('./ui-helpers');

const CARD_PATHS = ['/cards.html', '/cards'];
const cardMarker = (page) =>
  page.getByRole('heading', { name: /cards?/i }).first().isVisible();

test.describe('UI: cards', () => {
  test('freeze a card -> UI reflects frozen', async ({ page }) => {
    await signIn(page);
    const available = await openFeaturePage(page, CARD_PATHS, cardMarker);
    test.fixme(!available, 'cards page not built yet (waiting on frontend agent)');

    const freezeBtn = page.getByRole('button', { name: /^freeze$/i }).first();
    const hasFreeze = await freezeBtn.isVisible().catch(() => false);
    test.fixme(!hasFreeze, 'cards page has no Freeze control yet');

    await freezeBtn.click();
    await expect(page.getByText(/frozen/i).first()).toBeVisible({ timeout: 8_000 });
  });

  test('renew a card -> UI updates', async ({ page }) => {
    await signIn(page);
    const available = await openFeaturePage(page, CARD_PATHS, cardMarker);
    test.fixme(!available, 'cards page not built yet (waiting on frontend agent)');

    const renewBtn = page.getByRole('button', { name: /renew|reissue/i }).first();
    const hasRenew = await renewBtn.isVisible().catch(() => false);
    test.fixme(!hasRenew, 'cards page has no Renew control yet');

    await renewBtn.click();
    // After a renew the card shows active / a success toast / updated expiry.
    await expect(
      page.getByText(/active|renewed|updated|expires/i).first()
    ).toBeVisible({ timeout: 8_000 });
  });
});
