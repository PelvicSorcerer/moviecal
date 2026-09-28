import { NextResponse, type NextRequest } from 'next/server';

import { authenticateApiRequest } from '../../../../../../lib/auth/session';
import { hasE2EAuthenticatedSession } from '../../../../../../lib/e2e/fixtures';
import { leaveE2EWatchlist } from '../../../../../../lib/e2e/shared-watchlists';
import { leaveSharedWatchlist } from '../../../../../../lib/watchlist';
import {
  createServerSupabaseClient,
  createServerSupabaseServiceRoleClient,
} from '../../../../../../lib/supabase/server';
import { createSupabaseWatchlistRepository } from '../../../../../../lib/supabase/watchlist';
import { apiError, handleDomainError } from '../../../../../../lib/api/response';

function applyAuthCookies(
  auth: Exclude<Awaited<ReturnType<typeof authenticateApiRequest>>, NextResponse>,
  response: NextResponse,
): NextResponse {
  auth.applyAuthCookies(response);

  return response;
}

/**
 * The signed-in editor removes their own membership from a shared watchlist.
 * Owners are refused by the domain layer.
 */
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
      const response = NextResponse.json({ left: true, watchlistId });
      const outcome = leaveE2EWatchlist({
        actorUserId: auth.user.id,
        reader: request.cookies,
        response,
        watchlistId,
      });

      if (outcome === 'owner') {
        return apiError('A watchlist owner cannot leave their own watchlist.', 403);
      }

      if (outcome === 'not-member') {
        return apiError('Watchlist access denied.', 403);
      }

      return response;
    }

    await leaveSharedWatchlist({
      actorUserId: auth.user.id,
      repository: createSupabaseWatchlistRepository({
        userClient: createServerSupabaseClient(auth.accessToken),
        adminClient: createServerSupabaseServiceRoleClient(),
      }),
      watchlistId,
    });

    return applyAuthCookies(
      auth,
      NextResponse.json({ left: true, watchlistId }),
    );
  } catch (error) {
    return applyAuthCookies(auth, handleDomainError(error));
  }
}
