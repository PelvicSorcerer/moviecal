import { NextResponse } from 'next/server';

import { apiError, handleDomainError } from '../../../../../../../lib/api/response';
import { resolveBearerIdentity } from '../../../../../../../lib/auth/bearer-identity';
import { createServerSupabaseServiceRoleClient } from '../../../../../../../lib/supabase/server';
import { createSupabaseWatchlistRepository } from '../../../../../../../lib/supabase/watchlist';
import {
  removeWatchlistItem,
  WatchlistAccessError,
} from '../../../../../../../lib/watchlist';

/**
 * Removes one item from an authorized list. Owner and accepted editors only,
 * via the same `removeWatchlistItem` rules as the web route. A forbidden list
 * answers the same `404` as an unknown one. Removing an already-removed item is
 * a `404` (not a silent success), matching the web route.
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ itemId: string; watchlistId: string }> },
): Promise<NextResponse> {
  const identity = await resolveBearerIdentity(request);

  if (!identity) {
    return apiError('Unauthorized.', 401);
  }

  const { itemId, watchlistId } = await context.params;

  try {
    await removeWatchlistItem({
      actorUserId: identity.user.id,
      itemId,
      repository: createSupabaseWatchlistRepository({
        userClient: identity.userClient,
        adminClient: createServerSupabaseServiceRoleClient(),
      }),
      watchlistId,
    });

    return new NextResponse(null, { status: 204 });
  } catch (error) {
    if (error instanceof WatchlistAccessError) {
      return apiError('Watchlist not found.', 404);
    }

    return handleDomainError(error);
  }
}
