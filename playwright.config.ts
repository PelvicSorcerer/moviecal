import { defineConfig } from '@playwright/test';

const appUrl = process.env.APP_URL || 'http://localhost:3100';

export default defineConfig({
  testDir: 'e2e',
  timeout: 30000,
  use: {
    headless: true,
    baseURL: appUrl,
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'npm run dev -- --hostname 127.0.0.1 --port 3100',
    env: {
      ...process.env,
      MOVIECAL_E2E_TEST_MODE: '1',
    },
    url: appUrl,
    reuseExistingServer: false,
    timeout: 120000,
  },
});
