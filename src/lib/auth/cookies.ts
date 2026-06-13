import type { Session } from '@supabase/supabase-js';

export const ACCESS_TOKEN_COOKIE = 'moviecal-access-token';
export const REFRESH_TOKEN_COOKIE = 'moviecal-refresh-token';
const REFRESH_TOKEN_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface CookieValueReader {
  get(name: string): { value: string } | undefined;
}

export function readAuthTokens(reader: CookieValueReader): AuthTokens | null {
  const accessToken = reader.get(ACCESS_TOKEN_COOKIE)?.value;
  const refreshToken = reader.get(REFRESH_TOKEN_COOKIE)?.value;

  if (!accessToken || !refreshToken) {
    return null;
  }

  return { accessToken, refreshToken };
}

export function createAccessTokenCookieOptions(expiresIn: number | undefined) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: expiresIn ?? 60 * 60,
  };
}

export function createRefreshTokenCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: REFRESH_TOKEN_MAX_AGE_SECONDS,
  };
}

export function createExpiredCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 0,
  };
}

export function sessionToAuthTokens(session: Session): AuthTokens {
  return {
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
  };
}

export function sanitizeNextPath(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) {
    return '/watchlist';
  }

  return value;
}
