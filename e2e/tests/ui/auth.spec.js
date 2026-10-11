// @ts-check
const { test, expect } = require('@playwright/test');
const { signIn, moneyLocator } = require('./ui-helpers');

test.describe('UI: sign-in', () => {
  test('demo creds land on a dashboard with a visible balance', async ({ page }) => {
    await signIn(page);

    // Should no longer be on the bare login page.
    await expect(page).not.toHaveURL(/\/(index\.html)?$/);

    // Net worth / an account balance (some currency amount) is visible.
    await expect(moneyLocator(page)).toBeVisible({ timeout: 10_000 });
  });

  test('wrong password shows an error and stays on login', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel(/email/i).or(page.locator('#email')).first().fill('admin@acmepay.io');
    await page.getByLabel(/password/i).or(page.locator('#password')).first().fill('nope-wrong');
    await page.getByRole('button', { name: /sign in|log ?in/i })
      .or(page.locator('button[type="submit"]')).first().click();

    await expect(page.getByText(/fail|invalid|incorrect|wrong/i).first()).toBeVisible({ timeout: 8_000 });
  });
});
