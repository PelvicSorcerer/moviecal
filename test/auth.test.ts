import { describe, expect, it } from 'vitest';

import {
  ACCESS_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
  readAuthTokens,
  sanitizeNextPath,
} from '../src/lib/auth/cookies';

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
