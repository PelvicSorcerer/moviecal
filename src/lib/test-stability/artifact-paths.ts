import path from 'node:path';

export const PLAYWRIGHT_OUTPUT_DIR = 'test-results/playwright';
export const PLAYWRIGHT_REPORT_DIR = 'playwright-report';
export const FAILURE_SUMMARY_FILENAME = 'failure-summary.json';

export function getPlaywrightOutputDir(
  cwd: string = process.cwd(),
): string {
  return path.join(cwd, PLAYWRIGHT_OUTPUT_DIR);
}

export function getFailureSummaryPath(
  cwd: string = process.cwd(),
): string {
  return path.join(getPlaywrightOutputDir(cwd), FAILURE_SUMMARY_FILENAME);
}

export function getPlaywrightArtifactSettings(isCi: boolean) {
  return {
    outputDir: PLAYWRIGHT_OUTPUT_DIR,
    screenshot: 'only-on-failure' as const,
    video: 'retain-on-failure' as const,
    trace: (isCi ? 'on-first-retry' : 'retain-on-failure') as
      | 'on-first-retry'
      | 'retain-on-failure',
  };
}
