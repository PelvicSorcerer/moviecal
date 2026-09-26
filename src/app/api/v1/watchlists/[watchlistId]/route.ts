import { NextResponse } from 'next/server';

import { apiError, handleDomainError } from '../../../../../lib/api/response';
import { resolveBearerIdentity } from '../../../../../lib/auth/bearer-identity';
import { createServerSupabaseServiceRoleClient } from '../../../../../lib/supabase/server';
import { createSupabaseWatchlistRepository } from '../../../../../lib/supabase/watchlist';
import {
  getAuthorizedWatchlistDetail,
  parsePageRequest,
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
