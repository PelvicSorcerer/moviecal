import { NextResponse } from 'next/server';

import { apiError, handleDomainError } from '../../../../lib/api/response';
import { extractBearerToken } from '../../../../lib/auth/bearer';
import { resolveAuthTokensWithClient } from '../../../../lib/auth/identity';
import {
  createServerSupabaseClient,
  createServerSupabaseServiceRoleClient,
} from '../../../../lib/supabase/server';
import { createSupabaseWatchlistRepository } from '../../../../lib/supabase/watchlist';
import {
  getMovieDetails,
  TMDbEnvironmentError,
  TMDbRequestError,
} from '../../../../lib/tmdb/client';
import {
  addPersonalWatchlistItem,
  listPersonalWatchlistItems,
  removePersonalWatchlistItem,
  WatchlistInputError,
} from '../../../../lib/watchlist';

/**
 * Versioned mobile API surface for the authenticated user's personal watchlist.
 *
 * Auth: `Authorization: Bearer <access-token>` only. These handlers never read
 * cookies (the Next.js cookie transport module is intentionally not imported).
 * The bearer token builds a user-scoped Supabase client used for auth
 * resolution and RLS-scoped `watchlist_items` access — that user-scoped client
 * is the authorization boundary, with no application-level ownership checks. A
 * service-role client is used ONLY for the trusted server-side `movies`
 * metadata upsert (the same pattern as the unversioned routes), never for an
 * authorization decision. Expired/invalid tokens receive a `401`; the handlers
 * never silently refresh or extend a token, leaving refresh to the mobile
 * client.
 *
 * The existing unversioned routes under `src/app/api/watchlist/` are unchanged;
 * this surface is purely additive.
 */

interface ResolvedRequest {
  repository: ReturnType<typeof createSupabaseWatchlistRepository>;
  userId: string;
}

/**
 * Resolves the bearer token to an authenticated user and a user-scoped
 * watchlist repository. Returns a `401` `NextResponse` when the token is
 * missing, malformed, or does not resolve to a user.
 *
 * The user-scoped client resolves identity and backs all RLS-scoped
 * `watchlist_items` queries — it is the access-control boundary. A service-role
 * client backs only the `movies` metadata upsert, a trusted server-side write
 * with no authorization component.
 */
async function resolveRequest(
  request: Request,
): Promise<ResolvedRequest | NextResponse> {
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

  const repository = createSupabaseWatchlistRepository({
    userClient,
    // Service-role client used only for the trusted server-side `movies` upsert
    // of TMDb metadata (same as the existing routes). Authorization stays with
    // the user-scoped `userClient` above and RLS on `watchlist_items`; this is
    // not an authorization bypass.
    adminClient: createServerSupabaseServiceRoleClient(),
  });

  return { repository, userId: auth.user.id };
}

interface WatchlistCreateRequestBody {
  tmdbId?: unknown;
}

interface WatchlistDeleteRequestBody {
  watchlistItemId?: unknown;
}

async function readJsonBody<T>(request: Request): Promise<T> {
  try {
    const body = (await request.json()) as T;

    return (typeof body === 'object' && body !== null ? body : {}) as T;
  } catch {
    throw new WatchlistInputError('Request body must be valid JSON.');
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  const resolved = await resolveRequest(request);

  if (resolved instanceof NextResponse) {
    return resolved;
  }

  try {
    const items = await listPersonalWatchlistItems({
      repository: resolved.repository,
      userId: resolved.userId,
    });

    return NextResponse.json({ items });
  } catch (error) {
    return handleDomainError(error);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  const resolved = await resolveRequest(request);

  if (resolved instanceof NextResponse) {
    return resolved;
  }

  try {
    const body = await readJsonBody<WatchlistCreateRequestBody>(request);

    if (typeof body.tmdbId !== 'number') {
      throw new WatchlistInputError('A valid tmdbId is required.');
    }

    const result = await addPersonalWatchlistItem({
      getMovieDetails,
      repository: resolved.repository,
      tmdbId: body.tmdbId,
      userId: resolved.userId,
    });

    return NextResponse.json({ item: result.item }, { status: 201 });
  } catch (error) {
    if (error instanceof TMDbEnvironmentError) {
      return apiError(
        'Watchlist updates are unavailable until TMDb is configured.',
        503,
      );
    }

    if (error instanceof TMDbRequestError) {
      return apiError(error.message, error.status);
    }

    return handleDomainError(error);
  }
}

export async function DELETE(request: Request): Promise<NextResponse> {
  const resolved = await resolveRequest(request);

  if (resolved instanceof NextResponse) {
    return resolved;
  }

  try {
    const body = await readJsonBody<WatchlistDeleteRequestBody>(request);
    const watchlistItemId =
      typeof body.watchlistItemId === 'string' && body.watchlistItemId.trim()
        ? body.watchlistItemId.trim()
        : null;

    if (!watchlistItemId) {
      throw new WatchlistInputError('A valid watchlistItemId is required.');
    }

    await removePersonalWatchlistItem({
      itemId: watchlistItemId,
      repository: resolved.repository,
      userId: resolved.userId,
    });

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return handleDomainError(error);
  }
}
