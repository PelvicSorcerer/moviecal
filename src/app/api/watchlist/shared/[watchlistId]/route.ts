import { NextResponse, type NextRequest } from 'next/server';

import { authenticateApiRequest } from '../../../../../lib/auth/session';
import { hasE2EAuthenticatedSession } from '../../../../../lib/e2e/fixtures';
import {
  deleteE2EWatchlist,
  renameE2ESharedWatchlist,
} from '../../../../../lib/e2e/shared-watchlists';
import {
  deleteSharedWatchlist,
  normalizeSharedWatchlistName,
  renameSharedWatchlist,
  WatchlistInputError,
} from '../../../../../lib/watchlist';
import {
  createServerSupabaseClient,
  createServerSupabaseServiceRoleClient,
} from '../../../../../lib/supabase/server';
import { createSupabaseWatchlistRepository } from '../../../../../lib/supabase/watchlist';
import { apiError, handleDomainError } from '../../../../../lib/api/response';

function applyAuthCookies(
  auth: Exclude<Awaited<ReturnType<typeof authenticateApiRequest>>, NextResponse>,
  response: NextResponse,
): NextResponse {
  auth.applyAuthCookies(response);

  return response;
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ watchlistId: string }> },
) {
  const auth = await authenticateApiRequest(request);

  if (auth instanceof NextResponse) {
    return auth;
  }

  const { watchlistId } = await context.params;

  try {
    if (hasE2EAuthenticatedSession(request.cookies)) {
      const response = NextResponse.json({ deleted: true, watchlistId });
      const result = deleteE2EWatchlist({
        actorUserId: auth.user.id,
        reader: request.cookies,
        response,
        watchlistId,
      });

      if (result === 'not_found') {
        return apiError('Watchlist not found.', 404);
      }

      if (result === 'forbidden') {
        return apiError('Watchlist access denied.', 403);
      }

      return response;
    }

    await deleteSharedWatchlist({
      actorUserId: auth.user.id,
      repository: createSupabaseWatchlistRepository({
        userClient: createServerSupabaseClient(auth.accessToken),
        adminClient: createServerSupabaseServiceRoleClient(),
      }),
      watchlistId,
    });

    return applyAuthCookies(
      auth,
      NextResponse.json({ deleted: true, watchlistId }),
    );
  } catch (error) {
    return applyAuthCookies(auth, handleDomainError(error));
  }
}

interface RenameSharedWatchlistRequestBody {
  name?: unknown;
}

async function readRequestBody(
  request: NextRequest,
): Promise<RenameSharedWatchlistRequestBody> {
  try {
    const body = (await request.json()) as RenameSharedWatchlistRequestBody;

    return typeof body === 'object' && body !== null ? body : {};
  } catch {
    throw new WatchlistInputError('Request body must be valid JSON.');
  }
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ watchlistId: string }> },
) {
  const auth = await authenticateApiRequest(request);

  if (auth instanceof NextResponse) {
    return auth;
  }

  const { watchlistId } = await context.params;

  try {
    const body = await readRequestBody(request);

    if (typeof body.name !== 'string') {
      throw new WatchlistInputError('A shared watchlist name is required.');
    }

    const normalizedName = normalizeSharedWatchlistName(body.name);

    if (hasE2EAuthenticatedSession(request.cookies)) {
      const response = NextResponse.json({});
      const watchlist = renameE2ESharedWatchlist({
        actorUserId: auth.user.id,
        name: normalizedName,
        reader: request.cookies,
        response,
        watchlistId,
      });

      if (!watchlist) {
        return apiError('Watchlist access denied.', 403);
      }

      return NextResponse.json({ watchlist }, { headers: response.headers });
    }

    const watchlist = await renameSharedWatchlist({
      actorUserId: auth.user.id,
      name: normalizedName,
      repository: createSupabaseWatchlistRepository({
        userClient: createServerSupabaseClient(auth.accessToken),
        adminClient: createServerSupabaseServiceRoleClient(),
      }),
      watchlistId,
    });

    return applyAuthCookies(auth, NextResponse.json({ watchlist }));
  } catch (error) {
    return applyAuthCookies(auth, handleDomainError(error));
  }
}
