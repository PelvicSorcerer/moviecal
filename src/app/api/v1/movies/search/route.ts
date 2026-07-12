import { NextResponse } from 'next/server';

import { apiError, handleDomainError } from '../../../../../lib/api/response';
import { extractBearerToken } from '../../../../../lib/auth/bearer';
import { resolveAuthTokensWithClient } from '../../../../../lib/auth/identity';
import {
  isE2ETestModeEnabled,
  searchE2EMovieCatalog,
} from '../../../../../lib/e2e/fixtures';
import { createServerSupabaseClient } from '../../../../../lib/supabase/server';
import {
  searchMovies,
  TMDbEnvironmentError,
  TMDbRequestError,
} from '../../../../../lib/tmdb/client';

/**
 * Versioned mobile API surface for authenticated movie search.
 *
 * Auth: `Authorization: Bearer <access-token>` only. This handler never reads
 * cookies (the Next.js cookie transport module is intentionally not imported).
 * The bearer token builds a user-scoped client used solely for identity
 * resolution (`resolveAuthTokensWithClient`, `allowRefresh: false`). Search does
 * not touch user-owned data, so there is no service-role client and no RLS
 * concern — but a valid token is still required. Expired/invalid/missing tokens
 * receive a `401`; the handler never silently refreshes or extends a token,
 * leaving refresh to the mobile client. The token value is never logged.
 *
 * The success and error shapes mirror the unversioned
 * `src/app/api/movies/search/route.ts` route (`{ results }` on success, the E2E
 * fixture path, and `503` when TMDb is not configured), which is left unchanged;
 * this surface is purely additive. Errors follow the v1 contract's
 * `{ "error": string }` shape.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const token = extractBearerToken(request);

  if (!token) {
    return apiError('Unauthorized.', 401);
  }

  const userClient = createServerSupabaseClient(token);

  const auth = await resolveAuthTokensWithClient(
    userClient,
    // Bearer-only auth: the Authorization header carries no refresh token, so
    // there is nothing to refresh. `refreshToken` is empty and, with
    // `allowRefresh: false`, the refresh branch never runs and never reads it.
    { accessToken: token, refreshToken: '' },
    { allowRefresh: false },
  );

  if (!auth.user) {
    return apiError('Unauthorized.', 401);
  }

  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q')?.trim() ?? '';

  if (!query) {
    return apiError('Search query "q" is required.', 400);
  }

  try {
    if (isE2ETestModeEnabled()) {
      try {
        const results = searchE2EMovieCatalog(query);

        return NextResponse.json({ results });
      } catch (error) {
        return apiError(
          error instanceof Error
            ? error.message
            : 'Movie search is unavailable right now.',
          503,
        );
      }
    }

    const results = await searchMovies(query);

    return NextResponse.json({ results });
  } catch (error) {
    if (error instanceof TMDbEnvironmentError) {
      return apiError(
        'Movie search is unavailable until TMDb is configured.',
        503,
      );
    }

    if (error instanceof TMDbRequestError) {
      return apiError(error.message, error.status);
    }

    return handleDomainError(error);
  }
}
