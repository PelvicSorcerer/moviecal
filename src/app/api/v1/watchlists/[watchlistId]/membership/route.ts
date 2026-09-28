import { NextResponse } from 'next/server';

import { apiError, handleDomainError } from '../../../../../../lib/api/response';
import { withHiddenUnauthorizedAccess } from '../../../../../../lib/api/member-access';
import { resolveBearerIdentity } from '../../../../../../lib/auth/bearer-identity';
import { createServerSupabaseServiceRoleClient } from '../../../../../../lib/supabase/server';
import { createSupabaseWatchlistRepository } from '../../../../../../lib/supabase/watchlist';
import { leaveSharedWatchlist } from '../../../../../../lib/watchlist';

/** The caller's own membership: an accepted editor leaves the shared list. */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ watchlistId: string }> },
): Promise<NextResponse> {
  const identity = await resolveBearerIdentity(request);

  if (!identity) {
    return apiError('Unauthorized.', 401);
  }

  const { watchlistId } = await context.params;
  const repository = createSupabaseWatchlistRepository({
    userClient: identity.userClient,
    adminClient: createServerSupabaseServiceRoleClient(),
  });

  try {
    await withHiddenUnauthorizedAccess({
      actorUserId: identity.user.id,
      operation: () => leaveSharedWatchlist({
        actorUserId: identity.user.id,
        repository,
        watchlistId,
      }),
      repository,
      watchlistId,
    });

    return NextResponse.json({ left: true, watchlistId });
  } catch (error) {
    return handleDomainError(error);
  }
}
