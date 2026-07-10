import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { readAuthTokens } from './lib/auth/cookies';
import {
  hasE2EAuthenticatedSession,
  isE2ETestModeEnabled,
} from './lib/e2e/fixtures';
import {
  clearAuthCookies,
  redirectToSignIn,
  resolveAuthTokens,
  setAuthCookies,
} from './lib/auth/session';
import { SupabaseEnvironmentError } from './lib/supabase/env';

// Routes where expired tokens should be refreshed but unauthenticated visitors
// must NOT be redirected to sign-in (the page is publicly accessible).
const PUBLIC_REFRESH_PATHNAMES = new Set(['/search']);

export async function middleware(request: NextRequest) {
  if (hasE2EAuthenticatedSession(request.cookies)) {
    return NextResponse.next();
  }

  const isPublicRoute = PUBLIC_REFRESH_PATHNAMES.has(request.nextUrl.pathname);

  try {
    const auth = await resolveAuthTokens(readAuthTokens(request.cookies));

    if (!auth.user) {
      const response = isPublicRoute ? NextResponse.next() : redirectToSignIn(request);

      if (auth.shouldClearCookies) {
        clearAuthCookies(response);
      }

      return response;
    }

    const response = NextResponse.next();

    if (auth.refreshedSession) {
      setAuthCookies(response, auth.refreshedSession);
    }

    return response;
  } catch (error) {
    if (error instanceof SupabaseEnvironmentError) {
      if (isPublicRoute) {
        return NextResponse.next();
      }

      if (isE2ETestModeEnabled()) {
        return redirectToSignIn(request);
      }

      return redirectToSignIn(request, 'auth-unavailable');
    }

    throw error;
  }
}

export const config = {
  matcher: ['/watchlist/:path*', '/settings/calendar/:path*', '/search'],
};
