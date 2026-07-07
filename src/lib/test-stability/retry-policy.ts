const DEFAULT_CI_RETRIES = 2;
const DEFAULT_LOCAL_RETRIES = 0;

export type RetryPolicy = {
  retries: number;
  source: 'env' | 'ci-default' | 'local-default';
};

function parseRetryCount(raw: string): number | null {
  const trimmed = raw.trim();

  if (!/^\d+$/.test(trimmed)) {
    return null;
  }

  const value = Number.parseInt(trimmed, 10);

  if (!Number.isFinite(value) || value < 0) {
    return null;
  }

  return value;
}

export function resolveRetryPolicy(
  env: NodeJS.ProcessEnv = process.env,
): RetryPolicy {
  const explicit = env.PLAYWRIGHT_RETRIES;

  if (explicit !== undefined) {
    const parsed = parseRetryCount(explicit);

    if (parsed === null) {
      throw new Error(
        `PLAYWRIGHT_RETRIES must be a non-negative integer. Received: ${explicit}`,
      );
    }

    return { retries: parsed, source: 'env' };
  }

  if (env.CI) {
    return { retries: DEFAULT_CI_RETRIES, source: 'ci-default' };
  }

  return { retries: DEFAULT_LOCAL_RETRIES, source: 'local-default' };
}

export function shouldRetryForFlakeMitigation(policy: RetryPolicy): boolean {
  return policy.retries > 0;
}
