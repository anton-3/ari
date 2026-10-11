// Regression check against a running local dashboard; all reset calls are mocked.
import { chromium, expect } from '@playwright/test';

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  let posts = 0;
  let accepted = false;
  let progressPolls = 0;
  const old = { status: 'done', completedAt: 1000, steps: [{ id: 'infra', label: 'Remove bans and hide web-03', status: 'done', detail: 'Old reset result' }] };
  const fresh = { status: 'running', startedAt: Date.now(), steps: [{ id: 'infra', label: 'Remove bans and hide web-03', status: 'running' }] };
  await page.route('**/api/demo/reset-run', async route => {
    if (route.request().method() === 'POST') {
      posts++;
      await new Promise(resolve => setTimeout(resolve, 1200));
      if (posts === 1) return route.fulfill({ status: 409, json: { error: 'Ari still has a call in progress.' } });
      accepted = true;
      return route.fulfill({ status: 202, json: fresh });
    }
    if (!accepted) return route.fulfill({ json: old });
    progressPolls++;
    return route.fulfill({ json: progressPolls < 3 ? fresh : { ...fresh, status: 'done', completedAt: Date.now(), steps: fresh.steps.map(step => ({ ...step, status: 'done' })) } });
  });
  await page.goto('http://127.0.0.1:5173/dashboard.html');
  await page.waitForTimeout(1500);
  await page.locator('.reset-trigger').click();
  await expect(page.getByText('Old reset result')).toBeHidden();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByText('Old reset result')).toBeHidden();
  await expect(page.locator('.reset-success')).toBeHidden();
  await expect(page.getByRole('alert')).toHaveText('Ari still has a call in progress.');
  await page.waitForTimeout(2200);
  await expect(page.getByRole('alert')).toHaveText('Ari still has a call in progress.');
  await expect(page.getByText('Old reset result')).toBeHidden();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByText('Old reset result')).toBeHidden();
  await expect(page.locator('.reset-success')).toHaveText(/Pre-demo state verified/, { timeout: 10000 });
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('.reset-trigger').click();
  await expect(page.locator('.reset-success')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Confirm', exact: true })).toBeVisible();
  console.log('PASS: old completion stays hidden, start rejection survives polling, fresh progress completes, reopening requires a new reset.');
} finally {
  await browser.close();
}
