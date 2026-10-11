// @ts-check
const { defineConfig, devices } = require('@playwright/test');

/*
 * MyFiat e2e config.
 *
 * This suite boots its OWN instance of the target app (../target-app) via the
 * webServer block below and tears it down automatically when the run ends.
 * It does NOT touch the 8070/8071 instances the sibling agents run.
 *
 * Everything is configurable by env var:
 *   E2E_PORT   HTTP port for the app under test   (default 8099)
 *   E2E_HOST   host to reach it on                (default localhost)
 *   E2E_DB     SQLite file for the isolated DB    (default ./.tmp/e2e.db)
 */
const PORT = process.env.E2E_PORT || process.env.PORT || '8099';
const HOST = process.env.E2E_HOST || 'localhost';
const baseURL = `http://${HOST}:${PORT}`;

module.exports = defineConfig({
  testDir: './tests',
  // One server, mutation tests touch shared state -> run serially.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 1,
  reporter: [['list']],
  timeout: 30_000,
  expect: { timeout: 7_000 },

  use: {
    baseURL,
    trace: 'on-first-retry',
    extraHTTPHeaders: { 'Content-Type': 'application/json' },
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],

  webServer: {
    command: 'node ./scripts/run-target.mjs',
    url: `${baseURL}/health`,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      E2E_PORT: String(PORT),
    },
  },
});
