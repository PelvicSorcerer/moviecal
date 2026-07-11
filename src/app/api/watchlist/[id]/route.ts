import { NextResponse, type NextRequest } from 'next/server';

import { authenticateApiRequest } from '../../../../lib/auth/session';
import {
  findE2EWatchlist,
  getE2EPersonalWatchlistId,
  hasE2EAuthenticatedSession,
  removeE2EWatchlistItemFromTarget,
  readE2EUser,
  setE2EWatchlistCookie,
} from '../../../../lib/e2e/fixtures';
import {
  removeWatchlistItem,
  removePersonalWatchlistItem,
} from '../../../../lib/watchlist';
import {
  createServerSupabaseClient,
  createServerSupabaseServiceRoleClient,
} from '../../../../lib/supabase/server';
import { createSupabaseWatchlistRepository } from '../../../../lib/supabase/watchlist';
import { apiError, handleDomainError } from '../../../../lib/api/response';

function applyAuthCookies(
  auth: Exclude<Awaited<ReturnType<typeof authenticateApiRequest>>, NextResponse>,
  response: NextResponse,
): NextResponse {
  auth.applyAuthCookies(response);

  return response;
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await authenticateApiRequest(request);

  if (auth instanceof NextResponse) {
    return auth;
  }

  const { id } = await context.params;
  const watchlistId = request.nextUrl.searchParams.get('watchlist_id')?.trim() || null;

  if (hasE2EAuthenticatedSession(request.cookies)) {
    const targetWatchlistId = watchlistId
      ?? getE2EPersonalWatchlistId(readE2EUser(request.cookies).id);
    const targetWatchlist = findE2EWatchlist(request.cookies, targetWatchlistId);

    if (!targetWatchlist) {
      return apiError('Watchlist not found.', 404);
    }

    const result = removeE2EWatchlistItemFromTarget(
      request.cookies,
      targetWatchlistId,
      id,
    );

    if (!result.deleted) {
      return apiError('Watchlist item not found.', 404);
    }

    const response = NextResponse.json({ deleted: true, id });
    setE2EWatchlistCookie(response, result.itemsByWatchlist);

    return response;
  }

  const repository = createSupabaseWatchlistRepository({
    userClient: createServerSupabaseClient(auth.accessToken),
    adminClient: createServerSupabaseServiceRoleClient(),
  });

  try {
    if (watchlistId) {
      await removeWatchlistItem({
        actorUserId: auth.user.id,
        itemId: id,
        repository,
        watchlistId,
      });
    } else {
      await removePersonalWatchlistItem({
        itemId: id,
        repository,
        userId: auth.user.id,
      });
    }

    return applyAuthCookies(auth, NextResponse.json({ deleted: true, id }));
  } catch (error) {
    return applyAuthCookies(auth, handleDomainError(error));
  }
}
