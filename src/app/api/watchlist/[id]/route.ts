import { NextResponse, type NextRequest } from 'next/server';

import { authenticateApiRequest } from '../../../../lib/auth/session';
import { removeWatchlistItem, WatchlistNotFoundError } from '../../../../lib/watchlist';
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

  try {
    await removeWatchlistItem({
      itemId: id,
      repository: createSupabaseWatchlistRepository({
        userClient: createServerSupabaseClient(auth.accessToken),
        adminClient: createServerSupabaseServiceRoleClient(),
      }),
      userId: auth.user.id,
    });

    return applyAuthCookies(auth, NextResponse.json({ deleted: true, id }));
  } catch (error) {
    if (error instanceof WatchlistNotFoundError) {
      return applyAuthCookies(
        auth,
        NextResponse.json({ error: error.message }, { status: error.status }),
      );
    }

    throw error;
  }
}
