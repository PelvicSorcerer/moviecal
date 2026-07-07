import { describe, expect, it } from 'vitest';

import {
  FAILURE_SUMMARY_FILENAME,
  getFailureSummaryPath,
  getPlaywrightArtifactSettings,
  getPlaywrightOutputDir,
  PLAYWRIGHT_OUTPUT_DIR,
} from '../src/lib/test-stability/artifact-paths';
import {
  BROWSER_TEST_TIMEOUT_MS,
  E2E_APP_URL,
  resolveAppUrl,
  WEB_SERVER_STARTUP_TIMEOUT_MS,
} from '../src/lib/test-stability/startup-conventions';

describe('artifact paths and startup conventions', () => {
  it('uses stable output directories and summary filenames', () => {
    expect(PLAYWRIGHT_OUTPUT_DIR).toBe('test-results/playwright');
    expect(getPlaywrightOutputDir('/tmp/repo')).toBe('/tmp/repo/test-results/playwright');
    expect(getFailureSummaryPath('/tmp/repo')).toBe(
      `/tmp/repo/test-results/playwright/${FAILURE_SUMMARY_FILENAME}`,
    );
  });

  it('captures screenshots, video, and traces on failure-oriented settings', () => {
    expect(getPlaywrightArtifactSettings(true)).toMatchObject({
      screenshot: 'only-on-failure',
      video: 'retain-on-failure',
      trace: 'on-first-retry',
      outputDir: PLAYWRIGHT_OUTPUT_DIR,
    });
    expect(getPlaywrightArtifactSettings(false).trace).toBe('retain-on-failure');
  });

  it('defines shared startup defaults', () => {
    expect(resolveAppUrl()).toBe(E2E_APP_URL);
    expect(WEB_SERVER_STARTUP_TIMEOUT_MS).toBeGreaterThan(BROWSER_TEST_TIMEOUT_MS);
  });
});
