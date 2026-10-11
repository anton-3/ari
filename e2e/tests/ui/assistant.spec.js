// @ts-check
const { test, expect } = require('@playwright/test');
const { signIn } = require('./ui-helpers');

test.describe('UI: assistant widget', () => {
  test('opens and accepts input (or shows an offline state, never crashes)', async ({ page }) => {
    await signIn(page);

    // Find a launcher for the "Ari" assistant/chat widget.
    const launcher = page.getByRole('button', { name: /assistant|ari|chat|ask|help/i })
      .or(page.locator('[data-testid*="assistant"], [data-testid*="chat"], .assistant, #assistant, #chat'))
      .first();

    const present = await launcher.isVisible().catch(() => false);
    test.fixme(!present, 'assistant widget not in the UI yet (waiting on frontend agent)');

    await launcher.click();

    const input = page.getByRole('textbox', { name: /message|ask|assistant|chat/i })
      .or(page.getByPlaceholder(/message|ask|type|chat/i))
      .or(page.locator('[data-testid*="assistant"] textarea, [data-testid*="chat"] input, .assistant textarea'))
      .first();

    const offline = page.getByText(/offline|unavailable|try again|can't connect|cannot connect|not available|empty/i).first();

    // Either the input is usable, or a graceful offline/empty state is shown.
    const inputReady = await input.isVisible().catch(() => false);
    if (inputReady) {
      await input.fill('What is my balance?');
      await input.press('Enter').catch(() => {});
      // The page should still be alive and responsive after sending.
      await expect(page.locator('body')).toBeVisible();
    } else {
      await expect(offline).toBeVisible({ timeout: 8_000 });
    }
  });
});
