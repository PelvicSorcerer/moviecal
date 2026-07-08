import { defineConfig } from '@playwright/test';

import {
  BROWSER_TEST_TIMEOUT_MS,
  buildWebServerCommand,
  buildWebServerEnv,
  resolveAppUrl,
  resolveRetryPolicy,
  WEB_SERVER_STARTUP_TIMEOUT_MS,
} from './src/lib/test-stability';

const appUrl = resolveAppUrl();
const retryPolicy = resolveRetryPolicy();

export default defineConfig({
  testDir: 'e2e',
  testMatch: 'full-stack-runtime.spec.ts',
  timeout: BROWSER_TEST_TIMEOUT_MS,
  retries: retryPolicy.retries,
  workers: 1,
  reporter: [['list']],
  use: {
    headless: true,
    baseURL: appUrl,
    screenshot: 'off',
    trace: 'off',
    video: 'off',
  },
  webServer: {
    command: buildWebServerCommand(),
    env: buildWebServerEnv(process.env, {
      enableE2ETestMode: false,
    }),
    url: appUrl,
    reuseExistingServer: false,
    timeout: WEB_SERVER_STARTUP_TIMEOUT_MS,
  },
});
