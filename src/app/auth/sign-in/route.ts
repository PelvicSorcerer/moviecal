import { NextResponse } from 'next/server';

import { sanitizeNextPath } from '../../../lib/auth/cookies';
import { isE2ETestModeEnabled, setE2EAuthCookie } from '../../../lib/e2e/fixtures';
import { setAuthCookies } from '../../../lib/auth/session';
import { SupabaseEnvironmentError } from '../../../lib/supabase/env';
import { createServerSupabaseClient } from '../../../lib/supabase/server';

function buildRedirect(request: Request, path: string): NextResponse {
  return NextResponse.redirect(new URL(path, request.url));
}

export async function POST(request: Request) {
  const formData = await request.formData();
  const email = formData.get('email');
  const password = formData.get('password');
  const nextPath = sanitizeNextPath(formData.get('next')?.toString());

  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
    return buildRedirect(
      request,
      `/sign-in?error=missing-fields&next=${encodeURIComponent(nextPath)}`,
    );
  }

  if (isE2ETestModeEnabled()) {
    const response = buildRedirect(request, nextPath);

    setE2EAuthCookie(response);

    return response;
  }

  try {
    const supabase = createServerSupabaseClient();
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error || !data.session) {
      return buildRedirect(
        request,
        `/sign-in?error=invalid-credentials&next=${encodeURIComponent(nextPath)}`,
      );
    }

    const response = buildRedirect(request, nextPath);

    setAuthCookies(response, {
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
      expiresIn: data.session.expires_in,
    });

    return response;
  } catch (error) {
    if (error instanceof SupabaseEnvironmentError) {
      return buildRedirect(
        request,
        `/sign-in?error=auth-unavailable&next=${encodeURIComponent(nextPath)}`,
      );
    }

    throw error;
  }
}
