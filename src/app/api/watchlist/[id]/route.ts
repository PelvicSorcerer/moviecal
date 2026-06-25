import { NextResponse, type NextRequest } from 'next/server';

import { authenticateApiRequest } from '../../../../lib/auth/session';
import {
  hasE2EAuthenticatedSession,
  readE2EWatchlistItems,
  setE2EWatchlistCookie,
} from '../../../../lib/e2e/fixtures';
import {
  removePersonalWatchlistItem,
  WatchlistAccessError,
  WatchlistNotFoundError,
} from '../../../../lib/watchlist';
import {
  createServerSupabaseClient,
  createServerSupabaseServiceRoleClient,
} from '../../../../lib/supabase/server';
import { createSupabaseWatchlistRepository } from '../../../../lib/supabase/watchlist';

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

  if (hasE2EAuthenticatedSession(request.cookies)) {
    const existingItems = readE2EWatchlistItems(request.cookies);
    const nextItems = existingItems.filter((item) => item.id !== id);

    if (nextItems.length === existingItems.length) {
      return NextResponse.json(
        { error: 'Watchlist item not found.' },
        { status: 404 },
      );
    }

    const response = NextResponse.json({ deleted: true, id });
    setE2EWatchlistCookie(response, nextItems);

    return response;
  }

  try {
    await removePersonalWatchlistItem({
      itemId: id,
      repository: createSupabaseWatchlistRepository({
        userClient: createServerSupabaseClient(auth.accessToken),
        adminClient: createServerSupabaseServiceRoleClient(),
      }),
      userId: auth.user.id,
    });

    return applyAuthCookies(auth, NextResponse.json({ deleted: true, id }));
  } catch (error) {
    if (
      error instanceof WatchlistAccessError ||
      error instanceof WatchlistNotFoundError
    ) {
      return applyAuthCookies(
        auth,
        NextResponse.json({ error: error.message }, { status: error.status }),
      );
    }

    throw error;
  }
}
