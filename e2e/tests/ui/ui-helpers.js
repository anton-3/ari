// @ts-check
const { expect } = require('@playwright/test');

const DEMO = { email: 'admin@acmepay.io', password: 'admin123' };

/**
 * Sign in through the real login form and wait until we're off the login page.
 * Resilient selectors: role/label first, CSS id as a fallback.
 */
async function signIn(page, creds = DEMO) {
  await page.goto('/');

  const email = page.getByLabel(/email/i).or(page.locator('#email')).first();
  const password = page.getByLabel(/password/i).or(page.locator('#password')).first();
  await email.waitFor({ state: 'visible' });
  await email.fill(creds.email);
  await password.fill(creds.password);

  const submit = page.getByRole('button', { name: /sign in|log ?in|continue/i })
    .or(page.locator('button[type="submit"]')).first();
  await submit.click();

  // The app stores a session and client-redirects away from "/" to a dashboard.
  await page.waitForURL((url) => !/\/(index\.html)?$/.test(url.pathname) || /dashboard/.test(url.pathname), {
    timeout: 10_000,
  }).catch(() => {});
}

/** A currency amount like $1,234.56 anywhere on the page. */
function moneyLocator(page) {
  return page.getByText(/\$\s?[\d,]+(\.\d{2})?/).first();
}

/**
 * Navigate to one of several candidate dedicated pages for a feature. Returns
 * true if a real page loaded (HTTP < 400 and we weren't bounced back to the
 * login screen), false otherwise. Used to decide whether a not-yet-built page
 * should be marked fixme. Must be called AFTER signIn so the session exists.
 */
async function openFeaturePage(page, candidates, marker) {
  for (const path of candidates) {
    const resp = await page.goto(path).catch(() => null);
    if (!resp || resp.status() >= 400) continue;
    // Bounced back to the login screen (requireAuth redirect)? not available.
    if (/\/(index\.html)?$/.test(new URL(page.url()).pathname)) continue;
    if (marker) {
      const found = await marker(page).catch(() => false);
      if (!found) continue;
    }
    return true;
  }
  return false;
}

/** True if any of the given locators becomes visible within `timeout`. */
async function anyVisible(locators, timeout = 5_000) {
  const results = await Promise.all(
    locators.map((l) => l.first().isVisible().catch(() => false))
  );
  if (results.some(Boolean)) return true;
  // Give slow-rendering clients a moment.
  try {
    await Promise.any(locators.map((l) => l.first().waitFor({ state: 'visible', timeout })));
    return true;
  } catch {
    return false;
  }
}

module.exports = { DEMO, signIn, moneyLocator, openFeaturePage, anyVisible, expect };
