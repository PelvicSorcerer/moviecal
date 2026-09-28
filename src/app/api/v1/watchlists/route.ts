import { NextResponse } from 'next/server';

import { apiError, handleDomainError } from '../../../../lib/api/response';
import { resolveBearerIdentity } from '../../../../lib/auth/bearer-identity';
import { createServerSupabaseServiceRoleClient } from '../../../../lib/supabase/server';
import { createSupabaseWatchlistRepository } from '../../../../lib/supabase/watchlist';
import {
  createSharedWatchlist,
  listAuthorizedWatchlists,
  parsePageRequest,
  toAuthorizedWatchlistView,
  WatchlistInputError,
} from '../../../../lib/watchlist';

export async function GET(request: Request): Promise<NextResponse> {
  const identity = await resolveBearerIdentity(request);

  if (!identity) {
    return apiError('Unauthorized.', 401);
  }

  try {
    const result = await listAuthorizedWatchlists({
      page: parsePageRequest(new URL(request.url).searchParams),
      repository: createSupabaseWatchlistRepository({
        userClient: identity.userClient,
        adminClient: createServerSupabaseServiceRoleClient(),
      }),
      userId: identity.user.id,
    });

    return NextResponse.json(result);
  } catch (error) {
    return handleDomainError(error);
  }
}

/**
 * Creates a shared list owned by the caller. Not idempotent: every accepted
 * request creates a new list, so clients must not blindly retry a request whose
 * outcome is unknown; list first to check.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const identity = await resolveBearerIdentity(request);

  if (!identity) {
    return apiError('Unauthorized.', 401);
  }

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

    const watchlist = await createSharedWatchlist({
      name,
      repository: createSupabaseWatchlistRepository({
        userClient: identity.userClient,
        adminClient: createServerSupabaseServiceRoleClient(),
      }),
      userId: identity.user.id,
    });

    return NextResponse.json(
      {
        watchlist: toAuthorizedWatchlistView({
          actorUserId: identity.user.id,
          watchlist,
        }),
      },
      { status: 201 },
    );
  } catch (error) {
    return handleDomainError(error);
  }
}
