import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 30000,
  use: {
    headless: true,
    baseURL: process.env.APP_URL || 'http://localhost:3000',
  },
});
