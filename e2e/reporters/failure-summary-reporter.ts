import fs from 'node:fs';
import path from 'node:path';

import type {
  FullConfig,
  Reporter,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';

import {
  FAILURE_SUMMARY_FILENAME,
  getPlaywrightOutputDir,
} from '../../src/lib/test-stability/artifact-paths';
import { buildPlaywrightTestId } from '../../src/lib/test-stability/quarantine';

type FailureSummaryEntry = {
  testId: string;
  status: TestResult['status'];
  retry: number;
  errorMessage?: string;
  artifacts: {
    screenshot?: string;
    video?: string;
    trace?: string;
  };
};

type FailureSummary = {
  generatedAt: string;
  failures: FailureSummaryEntry[];
};

function relativeArtifactPath(outputDir: string, artifactPath?: string): string | undefined {
  if (!artifactPath) {
    return undefined;
  }

  return path.relative(outputDir, artifactPath).replaceAll(path.sep, '/');
}

export default class FailureSummaryReporter implements Reporter {
  private outputDir = getPlaywrightOutputDir();
  private failures: FailureSummaryEntry[] = [];

  onBegin(config: FullConfig): void {
    this.outputDir = path.resolve(config.rootDir, config.outputDir ?? getPlaywrightOutputDir());
    fs.mkdirSync(this.outputDir, { recursive: true });
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.status !== 'failed' && result.status !== 'timedOut') {
      return;
    }

    const specFile = path
      .relative(process.cwd(), test.location.file)
      .replaceAll(path.sep, '/');
    const screenshot = result.attachments.find((attachment) => attachment.name === 'screenshot');
    const video = result.attachments.find((attachment) => attachment.name === 'video');
    const trace = result.attachments.find((attachment) => attachment.name === 'trace');

    this.failures.push({
      testId: buildPlaywrightTestId(specFile, test.title),
      status: result.status,
      retry: result.retry,
      errorMessage: result.error?.message,
      artifacts: {
        screenshot: relativeArtifactPath(this.outputDir, screenshot?.path),
        video: relativeArtifactPath(this.outputDir, video?.path),
        trace: relativeArtifactPath(this.outputDir, trace?.path),
      },
    });
  }

  onEnd(): void {
    if (this.failures.length === 0) {
      return;
    }

    const summary: FailureSummary = {
      generatedAt: new Date().toISOString(),
      failures: this.failures,
    };

    fs.writeFileSync(
      path.join(this.outputDir, FAILURE_SUMMARY_FILENAME),
      `${JSON.stringify(summary, null, 2)}\n`,
      'utf8',
    );
  }
}
