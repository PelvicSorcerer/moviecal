import type { User } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { NextResponse, type NextRequest } from 'next/server';

import { SupabaseEnvironmentError } from '../supabase/env';
import { createServerSupabaseClient } from '../supabase/server';
import {
  ACCESS_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
  createAccessTokenCookieOptions,
  createExpiredCookieOptions,
  createRefreshTokenCookieOptions,
  readAuthTokens,
  sanitizeNextPath,
  sessionToAuthTokens,
  type AuthTokens,
} from './cookies';

export interface AuthResolution {
  refreshedSession:
    | {
        accessToken: string;
        refreshToken: string;
        expiresIn?: number;
      }
    | null;
  shouldClearCookies: boolean;
  user: User | null;
}

export async function resolveAuthTokens(
  tokens: AuthTokens | null,
): Promise<AuthResolution> {
  if (!tokens) {
    return {
      refreshedSession: null,
      shouldClearCookies: false,
      user: null,
    };
  }

  const supabase = createServerSupabaseClient();
  const { data: userData } = await supabase.auth.getUser(tokens.accessToken);

  if (userData.user) {
    return {
      refreshedSession: null,
      shouldClearCookies: false,
      user: userData.user,
    };
  }

  const { data: refreshData } = await supabase.auth.refreshSession({
    refresh_token: tokens.refreshToken,
  });

  if (!refreshData.session || !refreshData.user) {
    return {
      refreshedSession: null,
      shouldClearCookies: true,
      user: null,
    };
  }

  return {
    refreshedSession: {
      ...sessionToAuthTokens(refreshData.session),
      expiresIn: refreshData.session.expires_in,
    },
    shouldClearCookies: false,
    user: refreshData.user,
  };
}

export async function getOptionalUser(): Promise<User | null> {
  try {
    const cookieStore = await cookies();
    const auth = await resolveAuthTokens(readAuthTokens(cookieStore));

    return auth.user;
  } catch (error) {
    if (error instanceof SupabaseEnvironmentError) {
      return null;
    }

    throw error;
  }
}

export async function requireAuthenticatedPage(nextPath: string): Promise<User> {
  const user = await getOptionalUser();

  if (!user) {
    redirect(`/sign-in?next=${encodeURIComponent(nextPath)}`);
  }

  return user;
}

export async function getSignedInRedirect(nextPath?: string): Promise<string | null> {
  const user = await getOptionalUser();

  if (!user) {
    return null;
  }

  return sanitizeNextPath(nextPath);
}

export async function authenticateApiRequest(
  request: NextRequest,
): Promise<
  | {
      applyAuthCookies(response: NextResponse): void;
      user: User;
    }
  | NextResponse
> {
  try {
    const auth = await resolveAuthTokens(readAuthTokens(request.cookies));

    if (!auth.user) {
      const response = NextResponse.json(
        { error: 'Authentication required.' },
        { status: 401 },
      );

      if (auth.shouldClearCookies) {
        clearAuthCookies(response);
      }

      return response;
    }

    return {
      applyAuthCookies(response: NextResponse): void {
        if (auth.refreshedSession) {
          setAuthCookies(response, auth.refreshedSession);
        }
      },
      user: auth.user,
    };
  } catch (error) {
    if (error instanceof SupabaseEnvironmentError) {
      return NextResponse.json(
        { error: 'Authentication is unavailable until Supabase is configured.' },
        { status: 503 },
      );
    }

    throw error;
  }
}

export function setAuthCookies(
  response: NextResponse,
  session: {
    accessToken: string;
    refreshToken: string;
    expiresIn?: number;
  },
): void {
  response.cookies.set(
    ACCESS_TOKEN_COOKIE,
    session.accessToken,
    createAccessTokenCookieOptions(session.expiresIn),
  );
  response.cookies.set(
    REFRESH_TOKEN_COOKIE,
    session.refreshToken,
    createRefreshTokenCookieOptions(),
  );
}

export function clearAuthCookies(response: NextResponse): void {
  response.cookies.set(
    ACCESS_TOKEN_COOKIE,
    '',
    createExpiredCookieOptions(),
  );
  response.cookies.set(
    REFRESH_TOKEN_COOKIE,
    '',
    createExpiredCookieOptions(),
  );
}

export function redirectToSignIn(
  request: NextRequest,
  reason?: 'auth-unavailable',
): NextResponse {
  const signInUrl = new URL('/sign-in', request.url);
  const nextPath = `${request.nextUrl.pathname}${request.nextUrl.search}`;

  signInUrl.searchParams.set('next', sanitizeNextPath(nextPath));

  if (reason) {
    signInUrl.searchParams.set('error', reason);
  }

  return NextResponse.redirect(signInUrl);
}
