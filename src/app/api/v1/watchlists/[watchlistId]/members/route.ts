import { NextResponse } from 'next/server';

import { apiError, handleDomainError } from '../../../../../../lib/api/response';
import { withHiddenUnauthorizedAccess } from '../../../../../../lib/api/member-access';
import { resolveBearerIdentity } from '../../../../../../lib/auth/bearer-identity';
import { createServerSupabaseServiceRoleClient } from '../../../../../../lib/supabase/server';
import { createSupabaseWatchlistRepository } from '../../../../../../lib/supabase/watchlist';
import { listSharedWatchlistMemberProfiles } from '../../../../../../lib/watchlist';

export async function GET(
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
    const members = await withHiddenUnauthorizedAccess({
      actorUserId: identity.user.id,
      operation: () => listSharedWatchlistMemberProfiles({
        actorUserId: identity.user.id,
        includePending: true,
        repository,
        watchlistId,
      }),
      repository,
      watchlistId,
    });

    return NextResponse.json({
      members: members.map((member) => ({
        acceptedAt: member.acceptedAt,
        email: member.email,
        id: member.id,
        role: member.role,
        userId: member.userId,
      })),
    });
  } catch (error) {
    return handleDomainError(error);
  }
}
