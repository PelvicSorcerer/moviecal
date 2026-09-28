import { NextResponse, type NextRequest } from 'next/server';

import { authenticateApiRequest } from '../../../../../lib/auth/session';
import { hasE2EAuthenticatedSession } from '../../../../../lib/e2e/fixtures';
import { deleteE2EWatchlist } from '../../../../../lib/e2e/shared-watchlists';
import { deleteSharedWatchlist } from '../../../../../lib/watchlist';
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
