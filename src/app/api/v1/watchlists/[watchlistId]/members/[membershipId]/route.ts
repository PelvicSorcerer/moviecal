import { NextResponse } from 'next/server';

import { apiError, handleDomainError } from '../../../../../../../lib/api/response';
import { withHiddenUnauthorizedAccess } from '../../../../../../../lib/api/member-access';
import { resolveBearerIdentity } from '../../../../../../../lib/auth/bearer-identity';
import { createServerSupabaseServiceRoleClient } from '../../../../../../../lib/supabase/server';
import { createSupabaseWatchlistRepository } from '../../../../../../../lib/supabase/watchlist';
import { removeSharedWatchlistMember } from '../../../../../../../lib/watchlist';

export async function DELETE(
  request: Request,
  context: { params: Promise<{ membershipId: string; watchlistId: string }> },
): Promise<NextResponse> {
  const identity = await resolveBearerIdentity(request);

  if (!identity) {
    return apiError('Unauthorized.', 401);
  }

  const { membershipId, watchlistId } = await context.params;
  const repository = createSupabaseWatchlistRepository({
    userClient: identity.userClient,
    adminClient: createServerSupabaseServiceRoleClient(),
  });

  try {
    await withHiddenUnauthorizedAccess({
      actorUserId: identity.user.id,
      operation: () => removeSharedWatchlistMember({
        actorUserId: identity.user.id,
        membershipId,
        repository,
        watchlistId,
      }),
      repository,
      watchlistId,
    });

    return NextResponse.json({ deleted: true, membershipId });
  } catch (error) {
    return handleDomainError(error);
  }
}
