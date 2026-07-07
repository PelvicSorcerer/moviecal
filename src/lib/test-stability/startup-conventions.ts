/** Shared startup and readiness conventions for browser/runtime lanes. */

/** Loopback host used for browser lane startup and readiness checks. */
export const E2E_APP_HOST = 'localhost';
export const E2E_APP_PORT = 3100;
export const E2E_APP_URL = `http://${E2E_APP_HOST}:${E2E_APP_PORT}`;

/** How long Playwright waits for the Next.js dev server to become ready. */
export const WEB_SERVER_STARTUP_TIMEOUT_MS = 120_000;

/** Default per-test timeout for browser specs. */
export const BROWSER_TEST_TIMEOUT_MS = 30_000;

/** Env flag that enables deterministic E2E fixtures in the app runtime. */
export const E2E_TEST_MODE_ENV = 'MOVIECAL_E2E_TEST_MODE';
export const E2E_TEST_MODE_VALUE = '1';

export function resolveAppUrl(): string {
  return process.env.APP_URL?.trim() || E2E_APP_URL;
}

export function buildWebServerCommand(): string {
  return `npm run dev -- --hostname ${E2E_APP_HOST} --port ${E2E_APP_PORT}`;
}

export function buildWebServerEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    [E2E_TEST_MODE_ENV]: E2E_TEST_MODE_VALUE,
  };
}
