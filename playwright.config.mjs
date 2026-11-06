import { defineConfig, devices } from '@playwright/test';

/**
 * Celia Kids — E2E against the *demo build*: `scripts/preview.py` serves the
 * repository tree minus tooling, the app runs its Demo backend (localStorage),
 * and every phone number below is a made-up local-network number. No request
 * ever reaches a real clinic, calendar or human.
 *
 *   npx playwright install chromium   # one-time, browsers are not in the repo
 *   npx playwright test
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 7_500 },
  // The demo store lives in one browser's localStorage; serial keeps the log readable
  // and matches how the clinic actually uses the page (one device, one queue).
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://127.0.0.1:8080',
    locale: 'ar-EG',
    timezoneId: 'Africa/Cairo',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'python3 scripts/preview.py',
    url: 'http://127.0.0.1:8080/',
    reuseExistingServer: !process.env.CI,
    timeout: 20_000,
    env: { ...process.env, PORT: '8080' },
  },
});
