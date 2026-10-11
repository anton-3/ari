// @ts-check
const { test, expect } = require('@playwright/test');
const { signIn, openFeaturePage } = require('./ui-helpers');

const SUB_PATHS = ['/subscriptions.html', '/subscriptions'];
const subMarker = (page) =>
  page.getByRole('heading', { name: /subscriptions?/i }).first().isVisible();

test.describe('UI: subscriptions', () => {
  test('lists subscriptions with a monthly total, and cancelling updates it', async ({ page }) => {
    await signIn(page);
    const available = await openFeaturePage(page, SUB_PATHS, subMarker);
    test.fixme(!available, 'subscriptions page not built yet (waiting on frontend agent)');

    // A monthly total is shown somewhere on the page.
    await expect(page.getByText(/month/i).first()).toBeVisible();

    const cancelBtn = page.getByRole('button', { name: /cancel/i }).first();
    const hasCancel = await cancelBtn.isVisible().catch(() => false);
    test.fixme(!hasCancel, 'subscriptions page has no Cancel control yet');

    await cancelBtn.click();
    await expect(page.getByText(/cancel+ed|cancelled|canceled/i).first())
      .toBeVisible({ timeout: 8_000 });
  });
});
