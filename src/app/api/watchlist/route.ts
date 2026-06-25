import { NextResponse, type NextRequest } from 'next/server';

import { authenticateApiRequest } from '../../../lib/auth/session';
import {
  createE2EWatchlistItem,
  getE2EMovieFixture,
  hasE2EAuthenticatedSession,
  readE2EWatchlistItems,
  setE2EWatchlistCookie,
} from '../../../lib/e2e/fixtures';
import {
  addPersonalWatchlistItem,
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

    if (typeof tmdbId !== 'number') {
      throw new WatchlistInputError('A valid tmdb_id is required.');
    }

    if (hasE2EAuthenticatedSession(request.cookies)) {
      const existingItems = readE2EWatchlistItems(request.cookies);
      const existingItem = existingItems.find((item) => item.movie.tmdbId === tmdbId);

      if (existingItem) {
        return NextResponse.json({
          created: false,
          item: existingItem,
        });
      }

      if (!getE2EMovieFixture(tmdbId)) {
        return NextResponse.json({ error: 'Movie not found.' }, { status: 404 });
      }

      const nextItem = createE2EWatchlistItem(tmdbId);
      const response = NextResponse.json(
        {
          created: true,
          item: nextItem,
        },
        { status: 201 },
      );

      setE2EWatchlistCookie(response, [...existingItems, nextItem]);

      return response;
    }

    const result = await addPersonalWatchlistItem({
      getMovieDetails,
      repository: createRepositoryForRequest(auth),
      tmdbId,
      userId: auth.user.id,
    });

    return applyAuthCookies(
      auth,
      NextResponse.json(
        {
          created: result.created,
          item: result.item,
        },
        { status: result.created ? 201 : 200 },
      ),
    );
  } catch (error) {
    return applyAuthCookies(auth, handleWatchlistError(error));
  }
}
