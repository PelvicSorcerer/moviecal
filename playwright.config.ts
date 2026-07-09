import { defineConfig } from '@playwright/test';

import {
  getPlaywrightArtifactSettings,
  resolveAppUrl,
  resolveRetryPolicy,
  WEB_SERVER_STARTUP_TIMEOUT_MS,
  BROWSER_TEST_TIMEOUT_MS,
  buildWebServerCommand,
  buildWebServerEnv,
} from './src/lib/test-stability';

const appUrl = resolveAppUrl();
const isCi = Boolean(process.env.CI);
const retryPolicy = resolveRetryPolicy();
const artifactSettings = getPlaywrightArtifactSettings(isCi);

export default defineConfig({
  testDir: 'e2e',
  testIgnore: ['**/full-stack-runtime.spec.ts'],
  timeout: BROWSER_TEST_TIMEOUT_MS,
  retries: retryPolicy.retries,
  workers: 1,
  outputDir: artifactSettings.outputDir,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
    ['./e2e/reporters/failure-summary-reporter.ts'],
  ],
  use: {
    headless: true,
    baseURL: appUrl,
    screenshot: artifactSettings.screenshot,
    video: artifactSettings.video,
    trace: artifactSettings.trace,
  },
  webServer: {
    command: buildWebServerCommand(),
    env: buildWebServerEnv(),
    url: appUrl,
    reuseExistingServer: false,
    timeout: WEB_SERVER_STARTUP_TIMEOUT_MS,
  },
});
