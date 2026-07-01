import { NextResponse, type NextRequest } from 'next/server';

import { authenticateApiRequest } from '../../../../../../../lib/auth/session';
import { hasE2EAuthenticatedSession } from '../../../../../../../lib/e2e/fixtures';
import { removeE2EWatchlistMember } from '../../../../../../../lib/e2e/shared-watchlists';
import {
  removeSharedWatchlistMember,
  WatchlistAccessError,
  WatchlistNotFoundError,
} from '../../../../../../../lib/watchlist';
import {
  createServerSupabaseClient,
  createServerSupabaseServiceRoleClient,
} from '../../../../../../../lib/supabase/server';
import { createSupabaseWatchlistRepository } from '../../../../../../../lib/supabase/watchlist';

function applyAuthCookies(
  auth: Exclude<Awaited<ReturnType<typeof authenticateApiRequest>>, NextResponse>,
  response: NextResponse,
): NextResponse {
  auth.applyAuthCookies(response);

  return response;
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ membershipId: string; watchlistId: string }> },
) {
  const auth = await authenticateApiRequest(request);

  if (auth instanceof NextResponse) {
    return auth;
  }

  const { membershipId, watchlistId } = await context.params;

  try {
    if (hasE2EAuthenticatedSession(request.cookies)) {
      const response = NextResponse.json({ deleted: true, membershipId });
      const removed = removeE2EWatchlistMember({
        actorUserId: auth.user.id,
        membershipId,
        reader: request.cookies,
        response,
        watchlistId,
      });

      if (!removed) {
        return NextResponse.json(
          { error: 'Watchlist member not found.' },
          { status: 404 },
        );
      }

      return response;
    }

    await removeSharedWatchlistMember({
      actorUserId: auth.user.id,
      membershipId,
      repository: createSupabaseWatchlistRepository({
        userClient: createServerSupabaseClient(auth.accessToken),
        adminClient: createServerSupabaseServiceRoleClient(),
      }),
      watchlistId,
    });

    return applyAuthCookies(
      auth,
      NextResponse.json({ deleted: true, membershipId }),
    );
  } catch (error) {
    if (
      error instanceof WatchlistAccessError
      || error instanceof WatchlistNotFoundError
    ) {
      return applyAuthCookies(
        auth,
        NextResponse.json({ error: error.message }, { status: error.status }),
      );
    }

    throw error;
  }
}
