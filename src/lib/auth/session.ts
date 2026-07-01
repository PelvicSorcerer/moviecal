import type { User } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { NextResponse, type NextRequest } from 'next/server';

import {
  clearE2EStateCookies,
  E2E_SESSION,
  hasE2EAuthenticatedSession,
  readE2EUser,
} from '../e2e/fixtures';
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

export interface AuthClientLike {
  auth: {
    getUser(accessToken: string): Promise<{ data: { user: User | null } }>;
    refreshSession(args: {
      refresh_token: string;
    }): Promise<{
      data: {
        session:
          | {
              access_token: string;
              refresh_token: string;
              expires_in?: number;
            }
          | null;
        user: User | null;
      };
    }>;
  };
}

export interface ResolveAuthTokenOptions {
  allowRefresh?: boolean;
}

export async function resolveAuthTokensWithClient(
  client: AuthClientLike,
  tokens: AuthTokens | null,
  options: ResolveAuthTokenOptions = {},
): Promise<AuthResolution> {
  const { allowRefresh = true } = options;

  if (!tokens) {
    return {
      refreshedSession: null,
      shouldClearCookies: false,
      user: null,
    };
  }

  const { data: userData } = await client.auth.getUser(tokens.accessToken);

  if (userData.user) {
    return {
      refreshedSession: null,
      shouldClearCookies: false,
      user: userData.user,
    };
  }

  if (!allowRefresh) {
    return {
      refreshedSession: null,
      shouldClearCookies: false,
      user: null,
    };
  }

  const { data: refreshData } = await client.auth.refreshSession({
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
      accessToken: refreshData.session.access_token,
      refreshToken: refreshData.session.refresh_token,
      expiresIn: refreshData.session.expires_in,
    },
    shouldClearCookies: false,
    user: refreshData.user,
  };
}

export async function resolveAuthTokens(
  tokens: AuthTokens | null,
  options: ResolveAuthTokenOptions = {},
): Promise<AuthResolution> {
  const supabase = createServerSupabaseClient();

  return resolveAuthTokensWithClient(supabase, tokens, options);
}

export async function getOptionalUser(): Promise<User | null> {
  const cookieStore = await cookies();

  if (hasE2EAuthenticatedSession(cookieStore)) {
    return readE2EUser(cookieStore);
  }

  try {
    const auth = await resolveAuthTokens(readAuthTokens(cookieStore), {
      allowRefresh: false,
    });

    return auth.user;
  } catch (error) {
    if (error instanceof SupabaseEnvironmentError) {
      return null;
    }

    throw error;
  }
}

export interface AuthenticatedPageSession {
  accessToken: string;
  user: User;
}

export async function getOptionalPageSession(): Promise<AuthenticatedPageSession | null> {
  const cookieStore = await cookies();

  if (hasE2EAuthenticatedSession(cookieStore)) {
    return {
      accessToken: E2E_SESSION.accessToken,
      user: readE2EUser(cookieStore),
    };
  }

  try {
    const tokens = readAuthTokens(cookieStore);
    const auth = await resolveAuthTokens(tokens, {
      allowRefresh: false,
    });
    const accessToken = tokens?.accessToken;

    if (!auth.user || !accessToken) {
      return null;
    }

    return {
      accessToken,
      user: auth.user,
    };
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

export async function requireAuthenticatedPageSession(
  nextPath: string,
): Promise<AuthenticatedPageSession> {
  const session = await getOptionalPageSession();

  if (!session) {
    redirect(`/sign-in?next=${encodeURIComponent(nextPath)}`);
  }

  return session;
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
      accessToken: string;
      applyAuthCookies(response: NextResponse): void;
      user: User;
    }
  | NextResponse
> {
  if (hasE2EAuthenticatedSession(request.cookies)) {
    return {
      accessToken: E2E_SESSION.accessToken,
      applyAuthCookies(): void {},
      user: readE2EUser(request.cookies),
    };
  }

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

    const accessToken = auth.refreshedSession?.accessToken ?? readAuthTokens(request.cookies)?.accessToken;

    if (!accessToken) {
      const response = NextResponse.json(
        { error: 'Authentication required.' },
        { status: 401 },
      );

      clearAuthCookies(response);

      return response;
    }

    return {
      accessToken,
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
  clearE2EStateCookies(response);
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
