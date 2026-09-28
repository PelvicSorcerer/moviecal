import { NextResponse } from 'next/server';

import { apiError, handleDomainError } from '../../../../../lib/api/response';
import { resolveBearerIdentity } from '../../../../../lib/auth/bearer-identity';
import { createServerSupabaseServiceRoleClient } from '../../../../../lib/supabase/server';
import { createSupabaseWatchlistRepository } from '../../../../../lib/supabase/watchlist';
import {
  deleteSharedWatchlist,
  getAuthorizedWatchlistDetail,
  parsePageRequest,
  renameSharedWatchlist,
  toAuthorizedWatchlistView,
  WatchlistAccessError,
  WatchlistInputError,
  WatchlistNotFoundError,
} from '../../../../../lib/watchlist';

export async function GET(
  request: Request,
  context: { params: Promise<{ watchlistId: string }> },
): Promise<NextResponse> {
  const identity = await resolveBearerIdentity(request);

  if (!identity) {
    return apiError('Unauthorized.', 401);
  }

  const { watchlistId } = await context.params;

  try {
    const result = await getAuthorizedWatchlistDetail({
      actorUserId: identity.user.id,
      page: parsePageRequest(new URL(request.url).searchParams),
      repository: createSupabaseWatchlistRepository({
        userClient: identity.userClient,
        adminClient: createServerSupabaseServiceRoleClient(),
      }),
      watchlistId,
    });

    return NextResponse.json(result);
  } catch (error) {
    return handleDomainError(error);
  }
}

/**
 * Renames a shared list (owner or accepted editor). Last successful write wins,
 * so the request is idempotent and safe to retry. Outsiders, pending invitees,
 * personal lists, and unknown ids are all answered with the same 404.
 */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ watchlistId: string }> },
): Promise<NextResponse> {
  const identity = await resolveBearerIdentity(request);

  if (!identity) {
    return apiError('Unauthorized.', 401);
  }

  const { watchlistId } = await context.params;

  try {
    const body: unknown = await request.json().catch(() => {
      throw new WatchlistInputError('Request body must be valid JSON.');
    });
    const name =
      typeof body === 'object' && body !== null
        ? (body as { name?: unknown }).name
        : undefined;

    if (typeof name !== 'string') {
      throw new WatchlistInputError('A shared watchlist name is required.');
    }

    const watchlist = await renameSharedWatchlist({
      actorUserId: identity.user.id,
      name,
      repository: createSupabaseWatchlistRepository({
        userClient: identity.userClient,
        adminClient: createServerSupabaseServiceRoleClient(),
      }),
      watchlistId,
    });

    return NextResponse.json({
      watchlist: toAuthorizedWatchlistView({
        actorUserId: identity.user.id,
        watchlist,
      }),
    });
  } catch (error) {
    if (
      error instanceof WatchlistAccessError
      || error instanceof WatchlistNotFoundError
    ) {
      return apiError('Watchlist not found.', 404);
    }

    return handleDomainError(error);
  }
}

/**
 * Permanently deletes a shared watchlist the bearer owns. All authorization
 * and cascade rules live in `deleteSharedWatchlist`; this route only adds the
 * bearer transport and the stable response mapping.
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ watchlistId: string }> },
): Promise<NextResponse> {
  const identity = await resolveBearerIdentity(request);

  if (!identity) {
    return apiError('Unauthorized.', 401);
  }

  const { watchlistId } = await context.params;

  try {
    await deleteSharedWatchlist({
      actorUserId: identity.user.id,
      repository: createSupabaseWatchlistRepository({
        userClient: identity.userClient,
        adminClient: createServerSupabaseServiceRoleClient(),
      }),
      watchlistId,
    });

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return handleDomainError(error);
  }
}
