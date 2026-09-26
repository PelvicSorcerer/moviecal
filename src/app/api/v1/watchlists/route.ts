import { NextResponse } from 'next/server';

import { apiError, handleDomainError } from '../../../../lib/api/response';
import { resolveBearerIdentity } from '../../../../lib/auth/bearer-identity';
import { createServerSupabaseServiceRoleClient } from '../../../../lib/supabase/server';
import { createSupabaseWatchlistRepository } from '../../../../lib/supabase/watchlist';
import { listAuthorizedWatchlists, parsePageRequest } from '../../../../lib/watchlist';

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
