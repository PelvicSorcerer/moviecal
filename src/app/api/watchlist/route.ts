import { NextResponse, type NextRequest } from 'next/server';

import { authenticateApiRequest } from '../../../lib/auth/session';
import {
  addE2EWatchlistItemToTarget,
  findE2EWatchlist,
  getE2EMovieFixture,
  getE2EPersonalWatchlistId,
  hasE2EAuthenticatedSession,
  readE2EWatchlistItems,
  readE2EUser,
  setE2EWatchlistCookie,
} from '../../../lib/e2e/fixtures';
import {
  addPersonalWatchlistItem,
  addWatchlistItem,
  listPersonalWatchlistItems,
  WatchlistAccessError,
  WatchlistDataError,
  WatchlistInputError,
} from '../../../lib/watchlist';
import {
  createServerSupabaseClient,
  createServerSupabaseServiceRoleClient,
} from '../../../lib/supabase/server';
import { createSupabaseWatchlistRepository } from '../../../lib/supabase/watchlist';
import {
  getMovieDetails,
  TMDbEnvironmentError,
  TMDbRequestError,
} from '../../../lib/tmdb/client';

function applyAuthCookies(
  auth: Exclude<Awaited<ReturnType<typeof authenticateApiRequest>>, NextResponse>,
  response: NextResponse,
): NextResponse {
  auth.applyAuthCookies(response);

  return response;
}

function createRepositoryForRequest(
  auth: Exclude<Awaited<ReturnType<typeof authenticateApiRequest>>, NextResponse>,
) {
  return createSupabaseWatchlistRepository({
    userClient: createServerSupabaseClient(auth.accessToken),
    adminClient: createServerSupabaseServiceRoleClient(),
  });
}

function handleWatchlistError(error: unknown): NextResponse {
  if (
    error instanceof WatchlistAccessError ||
    error instanceof WatchlistInputError ||
    error instanceof WatchlistDataError
  ) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  if (error instanceof TMDbEnvironmentError) {
    return NextResponse.json(
      { error: 'Watchlist updates are unavailable until TMDb is configured.' },
      { status: 503 },
    );
  }

  if (error instanceof TMDbRequestError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  throw error;
}

export async function GET(request: NextRequest) {
  const auth = await authenticateApiRequest(request);

  if (auth instanceof NextResponse) {
    return auth;
  }

  if (hasE2EAuthenticatedSession(request.cookies)) {
    return NextResponse.json({
      items: readE2EWatchlistItems(request.cookies),
    });
  }

  try {
    const items = await listPersonalWatchlistItems({
      repository: createRepositoryForRequest(auth),
      userId: auth.user.id,
    });

    return applyAuthCookies(auth, NextResponse.json({ items }));
  } catch (error) {
    return applyAuthCookies(auth, handleWatchlistError(error));
  }
}

interface WatchlistCreateRequestBody {
  tmdb_id?: unknown;
  watchlist_id?: unknown;
}

async function readRequestBody(
  request: NextRequest,
): Promise<WatchlistCreateRequestBody> {
  try {
    const body = (await request.json()) as WatchlistCreateRequestBody;

    return typeof body === 'object' && body !== null ? body : {};
  } catch {
    throw new WatchlistInputError('Request body must be valid JSON.');
  }
}

export async function POST(request: NextRequest) {
  const auth = await authenticateApiRequest(request);

  if (auth instanceof NextResponse) {
    return auth;
  }

  try {
    const body = await readRequestBody(request);
    const tmdbId = body.tmdb_id;
    const watchlistId =
      typeof body.watchlist_id === 'string' && body.watchlist_id.trim()
        ? body.watchlist_id.trim()
        : null;

    if (typeof tmdbId !== 'number') {
      throw new WatchlistInputError('A valid tmdb_id is required.');
    }

    if (hasE2EAuthenticatedSession(request.cookies)) {
      const targetWatchlistId = watchlistId
        ?? getE2EPersonalWatchlistId(readE2EUser(request.cookies).id);
      const targetWatchlist = findE2EWatchlist(request.cookies, targetWatchlistId);

      if (!targetWatchlist) {
        return NextResponse.json({ error: 'Watchlist not found.' }, { status: 404 });
      }

      if (!getE2EMovieFixture(tmdbId)) {
        return NextResponse.json({ error: 'Movie not found.' }, { status: 404 });
      }

      const result = addE2EWatchlistItemToTarget(
        request.cookies,
        targetWatchlistId,
        tmdbId,
      );
      const response = NextResponse.json(
        {
          created: result.created,
          item: result.item,
          watchlist: targetWatchlist,
        },
        { status: result.created ? 201 : 200 },
      );

      setE2EWatchlistCookie(response, result.itemsByWatchlist);

      return response;
    }

    const repository = createRepositoryForRequest(auth);
    const result = watchlistId
      ? await addWatchlistItem({
        actorUserId: auth.user.id,
        getMovieDetails,
        repository,
        tmdbId,
        watchlistId,
      })
      : await addPersonalWatchlistItem({
        getMovieDetails,
        repository,
        tmdbId,
        userId: auth.user.id,
      });

    return applyAuthCookies(
      auth,
      NextResponse.json(
        {
          created: result.created,
          item: result.item,
          watchlist: result.watchlist,
        },
        { status: result.created ? 201 : 200 },
      ),
    );
  } catch (error) {
    return applyAuthCookies(auth, handleWatchlistError(error));
  }
}
