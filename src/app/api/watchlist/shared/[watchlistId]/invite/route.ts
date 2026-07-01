import { NextResponse, type NextRequest } from 'next/server';

import { authenticateApiRequest } from '../../../../../../lib/auth/session';
import { createE2EInviteLink } from '../../../../../../lib/e2e/shared-watchlists';
import { hasE2EAuthenticatedSession } from '../../../../../../lib/e2e/fixtures';
import {
  createSharedWatchlistInviteLink,
  createWatchlistInviteToken,
  WatchlistAccessError,
  WatchlistNotFoundError,
} from '../../../../../../lib/watchlist';
import {
  createServerSupabaseClient,
  createServerSupabaseServiceRoleClient,
} from '../../../../../../lib/supabase/server';
import { createSupabaseWatchlistRepository } from '../../../../../../lib/supabase/watchlist';

function applyAuthCookies(
  auth: Exclude<Awaited<ReturnType<typeof authenticateApiRequest>>, NextResponse>,
  response: NextResponse,
): NextResponse {
  auth.applyAuthCookies(response);

  return response;
}

export async function POST(
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
      const response = NextResponse.json({});
      const result = createE2EInviteLink({
        actorUserId: auth.user.id,
        baseUrl: request.nextUrl.origin,
        reader: request.cookies,
        response,
        token: createWatchlistInviteToken(),
        watchlistId,
      });

      if (!result) {
        return NextResponse.json(
          { error: 'Watchlist access denied.' },
          { status: 403 },
        );
      }

      return NextResponse.json(result, {
        status: 201,
        headers: response.headers,
      });
    }

    const result = await createSharedWatchlistInviteLink({
      actorUserId: auth.user.id,
      baseUrl: request.nextUrl.origin,
      repository: createSupabaseWatchlistRepository({
        userClient: createServerSupabaseClient(auth.accessToken),
        adminClient: createServerSupabaseServiceRoleClient(),
      }),
      watchlistId,
    });

    return applyAuthCookies(auth, NextResponse.json(result, { status: 201 }));
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
