import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

import { readAuthTokens } from './lib/auth/cookies';
import {
  clearAuthCookies,
  redirectToSignIn,
  resolveAuthTokens,
  setAuthCookies,
} from './lib/auth/session';
import { SupabaseEnvironmentError } from './lib/supabase/env';

export async function middleware(request: NextRequest) {
  try {
    const auth = await resolveAuthTokens(readAuthTokens(request.cookies));

    if (!auth.user) {
      const response = redirectToSignIn(request);

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
      return redirectToSignIn(request, 'auth-unavailable');
    }

    throw error;
  }
}

export const config = {
  matcher: ['/watchlist/:path*', '/settings/calendar/:path*'],
};
