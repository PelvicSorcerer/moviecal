import { NextResponse } from 'next/server';

import { apiError, handleDomainError } from '../../../../../../lib/api/response';
import { resolveBearerIdentity } from '../../../../../../lib/auth/bearer-identity';
import { createServerSupabaseServiceRoleClient } from '../../../../../../lib/supabase/server';
import { createSupabaseWatchlistRepository } from '../../../../../../lib/supabase/watchlist';
import {
  getMovieDetails,
  TMDbEnvironmentError,
  TMDbRequestError,
} from '../../../../../../lib/tmdb/client';
import {
  addWatchlistItem,
  WatchlistAccessError,
  WatchlistInputError,
} from '../../../../../../lib/watchlist';

interface ItemCreateRequestBody {
  tmdbId?: unknown;
}

async function readJsonBody(request: Request): Promise<ItemCreateRequestBody> {
  try {
    const body = (await request.json()) as ItemCreateRequestBody;

    return typeof body === 'object' && body !== null ? body : {};
  } catch {
    throw new WatchlistInputError('Request body must be valid JSON.');
  }
}

/**
 * Adds a movie to one authorized list (personal or shared). Owner and accepted
 * editors only, using the same `addWatchlistItem` domain rules and TMDb movie
 * validation as the web route. A forbidden list answers the same `404` as an
 * unknown one so list existence is never revealed. A duplicate add is stable:
 * it returns `200` with `created: false` and the existing item.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ watchlistId: string }> },
): Promise<NextResponse> {
  const identity = await resolveBearerIdentity(request);

  if (!identity) {
    return apiError('Unauthorized.', 401);
  }

  const { watchlistId } = await context.params;

  try {
    const body = await readJsonBody(request);

    if (typeof body.tmdbId !== 'number') {
      throw new WatchlistInputError('A valid tmdbId is required.');
    }

    const result = await addWatchlistItem({
      actorUserId: identity.user.id,
      getMovieDetails,
      repository: createSupabaseWatchlistRepository({
        userClient: identity.userClient,
        adminClient: createServerSupabaseServiceRoleClient(),
      }),
      tmdbId: body.tmdbId,
      watchlistId,
    });

    return NextResponse.json(
      {
        created: result.created,
        item: result.item,
        watchlist: result.watchlist,
      },
      { status: result.created ? 201 : 200 },
    );
  } catch (error) {
    if (error instanceof WatchlistAccessError) {
      return apiError('Watchlist not found.', 404);
    }

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
