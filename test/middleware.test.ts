import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from '../src/lib/auth/cookies';
import { SupabaseEnvironmentError } from '../src/lib/supabase/env';

// Mocks are declared with vi.hoisted so they are available before imports resolve.
const mocks = vi.hoisted(() => ({
  resolveAuthTokens: vi.fn(),
  hasE2EAuthenticatedSession: vi.fn(() => false),
  isE2ETestModeEnabled: vi.fn(() => false),
}));

vi.mock('../src/lib/auth/session', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/auth/session')>(
    '../src/lib/auth/session',
  );

  return {
    ...actual,
    resolveAuthTokens: mocks.resolveAuthTokens,
  };
});

vi.mock('../src/lib/e2e/fixtures', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/e2e/fixtures')>(
    '../src/lib/e2e/fixtures',
  );

  return {
    ...actual,
    hasE2EAuthenticatedSession: mocks.hasE2EAuthenticatedSession,
    isE2ETestModeEnabled: mocks.isE2ETestModeEnabled,
  };
});

// Static import — all tests share the same module instances so instanceof checks
// against SupabaseEnvironmentError work correctly without vi.resetModules().
import { middleware } from '../src/middleware';

function isPassThrough(response: { status: number }): boolean {
  return response.status !== 301
    && response.status !== 302
    && response.status !== 307
    && response.status !== 308;
}

describe('middleware public-route pass-through', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hasE2EAuthenticatedSession.mockReturnValue(false);
    mocks.isE2ETestModeEnabled.mockReturnValue(false);
  });

  describe('/search — public route', () => {
    it('passes through unauthenticated visitors without redirecting or writing cookies', async () => {
      mocks.resolveAuthTokens.mockResolvedValue({
        user: null,
        refreshedSession: null,
        shouldClearCookies: false,
      });

      const request = new NextRequest('https://moviecal.test/search');
      const response = await middleware(request);

      expect(isPassThrough(response)).toBe(true);
      // No cookie writes on a plain pass-through
      expect(response.cookies.get(ACCESS_TOKEN_COOKIE)).toBeUndefined();
    });

    it('passes through a valid-token authenticated user without redirecting', async () => {
      mocks.resolveAuthTokens.mockResolvedValue({
        user: { id: 'user-123', email: 'user@example.com' },
        refreshedSession: null,
        shouldClearCookies: false,
      });

      const request = new NextRequest('https://moviecal.test/search');
      const response = await middleware(request);

      expect(isPassThrough(response)).toBe(true);
    });

    it('passes through and sets refreshed cookies when access token is expired but refresh token is valid', async () => {
      mocks.resolveAuthTokens.mockResolvedValue({
        user: { id: 'user-123', email: 'user@example.com' },
        refreshedSession: {
          accessToken: 'new-access-token',
          refreshToken: 'new-refresh-token',
          expiresIn: 3600,
        },
        shouldClearCookies: false,
      });

      const request = new NextRequest('https://moviecal.test/search');
      const response = await middleware(request);

      expect(isPassThrough(response)).toBe(true);
      // Refreshed cookies must be set on the response
      const accessCookie = response.cookies.get(ACCESS_TOKEN_COOKIE);
      expect(accessCookie).toBeDefined();
      expect(accessCookie?.value).toBe('new-access-token');
      const refreshCookie = response.cookies.get(REFRESH_TOKEN_COOKIE);
      expect(refreshCookie).toBeDefined();
      expect(refreshCookie?.value).toBe('new-refresh-token');
    });

    it('passes through and clears stale cookies when both tokens are expired', async () => {
      mocks.resolveAuthTokens.mockResolvedValue({
        user: null,
        refreshedSession: null,
        shouldClearCookies: true,
      });

      const request = new NextRequest('https://moviecal.test/search');
      const response = await middleware(request);

      expect(isPassThrough(response)).toBe(true);
      // Cleared cookies are present with empty value and maxAge 0
      const accessCookie = response.cookies.get(ACCESS_TOKEN_COOKIE);
      expect(accessCookie).toBeDefined();
      expect(accessCookie?.value).toBe('');
      const refreshCookie = response.cookies.get(REFRESH_TOKEN_COOKIE);
      expect(refreshCookie).toBeDefined();
      expect(refreshCookie?.value).toBe('');
      const setCookie = response.headers.get('set-cookie') ?? '';
      expect(setCookie).toMatch(/max-age=0/i);
    });

    it('passes through on SupabaseEnvironmentError without redirecting', async () => {
      mocks.resolveAuthTokens.mockRejectedValue(
        new SupabaseEnvironmentError('Supabase is not configured.'),
      );

      const request = new NextRequest('https://moviecal.test/search');
      const response = await middleware(request);

      expect(isPassThrough(response)).toBe(true);
    });
  });

  describe('/watchlist — protected route', () => {
    it('redirects unauthenticated visitors to /sign-in', async () => {
      mocks.resolveAuthTokens.mockResolvedValue({
        user: null,
        refreshedSession: null,
        shouldClearCookies: false,
      });

      const request = new NextRequest('https://moviecal.test/watchlist');
      const response = await middleware(request);

      expect(isPassThrough(response)).toBe(false);
      expect(response.headers.get('location')).toContain('/sign-in');
    });

    it('redirects to /sign-in?error=auth-unavailable on SupabaseEnvironmentError', async () => {
      mocks.resolveAuthTokens.mockRejectedValue(
        new SupabaseEnvironmentError('Supabase is not configured.'),
      );

      const request = new NextRequest('https://moviecal.test/watchlist');
      const response = await middleware(request);

      expect(isPassThrough(response)).toBe(false);
      const location = response.headers.get('location') ?? '';
      expect(location).toContain('/sign-in');
      expect(location).toContain('error=auth-unavailable');
    });
  });
});
