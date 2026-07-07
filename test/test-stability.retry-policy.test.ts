import { afterEach, describe, expect, it } from 'vitest';

import { resolveRetryPolicy } from '../src/lib/test-stability/retry-policy';

const originalCi = process.env.CI;
const originalRetries = process.env.PLAYWRIGHT_RETRIES;

afterEach(() => {
  if (originalCi === undefined) {
    delete process.env.CI;
  } else {
    process.env.CI = originalCi;
  }

  if (originalRetries === undefined) {
    delete process.env.PLAYWRIGHT_RETRIES;
  } else {
    process.env.PLAYWRIGHT_RETRIES = originalRetries;
  }
});

describe('retry policy', () => {
  it('defaults to zero retries locally', () => {
    delete process.env.CI;
    delete process.env.PLAYWRIGHT_RETRIES;

    expect(resolveRetryPolicy()).toEqual({ retries: 0, source: 'local-default' });
  });

  it('defaults to two retries in CI', () => {
    process.env.CI = 'true';
    delete process.env.PLAYWRIGHT_RETRIES;

    expect(resolveRetryPolicy()).toEqual({ retries: 2, source: 'ci-default' });
  });

  it('honors PLAYWRIGHT_RETRIES overrides', () => {
    process.env.PLAYWRIGHT_RETRIES = '1';

    expect(resolveRetryPolicy()).toEqual({ retries: 1, source: 'env' });
  });

  it('rejects invalid PLAYWRIGHT_RETRIES values', () => {
    process.env.PLAYWRIGHT_RETRIES = '-1';

    expect(() => resolveRetryPolicy()).toThrow(/PLAYWRIGHT_RETRIES/);
  });
});
