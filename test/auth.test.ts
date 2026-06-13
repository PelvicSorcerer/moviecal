import { describe, expect, it } from 'vitest';
import type { User } from '@supabase/supabase-js';

import {
  ACCESS_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
  readAuthTokens,
  sanitizeNextPath,
} from '../src/lib/auth/cookies';
import { resolveAuthTokensWithClient } from '../src/lib/auth/session';

function createUser(id: string): User {
  return {
    id,
    app_metadata: {},
    aud: 'authenticated',
    created_at: '2026-01-01T00:00:00.000Z',
    user_metadata: {},
  };
}

describe('auth cookie helpers', () => {
  it('returns null when either auth cookie is missing', () => {
    const reader = {
      get(name: string) {
        if (name === ACCESS_TOKEN_COOKIE) {
          return { value: 'access-token' };
        }

        return undefined;
      },
    };

    expect(readAuthTokens(reader)).toBeNull();
  });

  it('reads both auth cookies together', () => {
    const reader = {
      get(name: string) {
        if (name === ACCESS_TOKEN_COOKIE) {
          return { value: 'access-token' };
        }

        if (name === REFRESH_TOKEN_COOKIE) {
          return { value: 'refresh-token' };
        }

        return undefined;
      },
    };

    expect(readAuthTokens(reader)).toEqual({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
    });
  });
});

describe('auth redirect sanitization', () => {
  it('keeps relative in-app paths', () => {
    expect(sanitizeNextPath('/settings/calendar')).toBe('/settings/calendar');
  });

  it('falls back when the next target is missing', () => {
    expect(sanitizeNextPath(undefined)).toBe('/watchlist');
  });

  it('rejects protocol-relative targets', () => {
    expect(sanitizeNextPath('//evil.example.com')).toBe('/watchlist');
  });
});

describe('auth session resolution', () => {
  it('does not refresh tokens when refresh persistence is unavailable', async () => {
    let refreshCalls = 0;

    const auth = await resolveAuthTokensWithClient(
      {
        auth: {
          async getUser() {
            return { data: { user: null } };
          },
          async refreshSession() {
            refreshCalls += 1;

            return {
              data: {
                session: {
                  access_token: 'new-access-token',
                  refresh_token: 'new-refresh-token',
                  expires_in: 3600,
                },
                user: createUser('user-1'),
              },
            };
          },
        },
      },
      {
        accessToken: 'expired-access-token',
        refreshToken: 'refresh-token',
      },
      { allowRefresh: false },
    );

    expect(auth).toEqual({
      refreshedSession: null,
      shouldClearCookies: false,
      user: null,
    });
    expect(refreshCalls).toBe(0);
  });

  it('refreshes tokens when the caller can persist new cookies', async () => {
    const auth = await resolveAuthTokensWithClient(
      {
        auth: {
          async getUser() {
            return { data: { user: null } };
          },
          async refreshSession() {
            return {
              data: {
                session: {
                  access_token: 'new-access-token',
                  refresh_token: 'new-refresh-token',
                  expires_in: 3600,
                },
                user: createUser('user-1'),
              },
            };
          },
        },
      },
      {
        accessToken: 'expired-access-token',
        refreshToken: 'refresh-token',
      },
    );

    expect(auth).toEqual({
      refreshedSession: {
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
        expiresIn: 3600,
      },
      shouldClearCookies: false,
      user: createUser('user-1'),
    });
  });
});
