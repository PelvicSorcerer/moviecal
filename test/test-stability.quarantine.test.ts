import { describe, expect, it } from 'vitest';

import {
  buildPlaywrightTestId,
  findQuarantineEntry,
  getQuarantineSkipReason,
  hasQuarantineTag,
  isQuarantinedTest,
  loadQuarantineRegistry,
  shouldRunTestInQuarantineMode,
} from '../src/lib/test-stability/quarantine';

describe('quarantine registry', () => {
  it('loads an empty registry when no entries are quarantined', () => {
    const registry = loadQuarantineRegistry('e2e/quarantine.json');

    expect(registry).toEqual({ version: 1, entries: [] });
  });

  it('builds stable Playwright test ids', () => {
    expect(buildPlaywrightTestId('e2e/search.spec.ts', 'finds movies')).toBe(
      'e2e/search.spec.ts > finds movies',
    );
  });

  it('detects quarantine tags and registry entries', () => {
    const registry = {
      version: 1 as const,
      entries: [
        {
          testId: 'e2e/search.spec.ts > flaky loading state',
          reason: 'timing flake under CI',
          owner: 'tests',
          trackingIssue: '#999',
          quarantinedAt: '2026-07-07',
        },
      ],
    };

    expect(hasQuarantineTag('loading state @quarantine')).toBe(true);
    expect(
      isQuarantinedTest({
        title: 'flaky loading state',
        specFile: 'e2e/search.spec.ts',
        registry,
      }),
    ).toBe(true);
    expect(findQuarantineEntry(registry, 'missing')).toBeUndefined();
    expect(getQuarantineSkipReason(registry, registry.entries[0].testId)).toContain(
      '#999',
    );
  });

  it('filters blocking versus quarantine-only lanes', () => {
    const registry = {
      version: 1 as const,
      entries: [
        {
          testId: 'e2e/search.spec.ts > flaky loading state',
          reason: 'timing flake under CI',
          owner: 'tests',
          trackingIssue: '#999',
          quarantinedAt: '2026-07-07',
        },
      ],
    };

    expect(
      shouldRunTestInQuarantineMode({
        mode: 'blocking',
        title: 'stable test',
        specFile: 'e2e/home.spec.ts',
        registry,
      }),
    ).toBe(true);
    expect(
      shouldRunTestInQuarantineMode({
        mode: 'blocking',
        title: 'flaky loading state',
        specFile: 'e2e/search.spec.ts',
        registry,
      }),
    ).toBe(false);
    expect(
      shouldRunTestInQuarantineMode({
        mode: 'quarantine-only',
        title: 'flaky loading state',
        specFile: 'e2e/search.spec.ts',
        registry,
      }),
    ).toBe(true);
    expect(
      shouldRunTestInQuarantineMode({
        mode: 'quarantine-only',
        title: 'stable test',
        specFile: 'e2e/home.spec.ts',
        registry,
      }),
    ).toBe(false);
  });
});
