import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 30000,
  use: {
    headless: true,
    baseURL: process.env.APP_URL || 'http://127.0.0.1:3000',
  },
  webServer: {
    command: 'npm run dev',
    url: process.env.APP_URL || 'http://127.0.0.1:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
