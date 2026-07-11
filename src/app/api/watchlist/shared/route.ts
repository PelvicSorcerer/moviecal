import { NextResponse, type NextRequest } from 'next/server';

import { authenticateApiRequest } from '../../../../lib/auth/session';
import {
  createE2ESharedWatchlist,
  hasE2EAuthenticatedSession,
  readE2EWatchlists,
  setE2EWatchlistsCookie,
} from '../../../../lib/e2e/fixtures';
import {
  createSharedWatchlist,
  WatchlistInputError,
} from '../../../../lib/watchlist';
import {
  createServerSupabaseClient,
  createServerSupabaseServiceRoleClient,
} from '../../../../lib/supabase/server';
import { createSupabaseWatchlistRepository } from '../../../../lib/supabase/watchlist';
import { handleDomainError } from '../../../../lib/api/response';

function applyAuthCookies(
  auth: Exclude<Awaited<ReturnType<typeof authenticateApiRequest>>, NextResponse>,
  response: NextResponse,
): NextResponse {
  auth.applyAuthCookies(response);

  return response;
}

interface CreateSharedWatchlistRequestBody {
  name?: unknown;
}

async function readRequestBody(
  request: NextRequest,
): Promise<CreateSharedWatchlistRequestBody> {
  try {
    const body = (await request.json()) as CreateSharedWatchlistRequestBody;

    return typeof body === 'object' && body !== null ? body : {};
  } catch {
    throw new WatchlistInputError('Request body must be valid JSON.');
  }
}

export async function POST(request: NextRequest) {
  const auth = await authenticateApiRequest(request);

  if (auth instanceof NextResponse) {
    return auth;
  }

  try {
    const body = await readRequestBody(request);

    if (typeof body.name !== 'string') {
      throw new WatchlistInputError('A shared watchlist name is required.');
    }

    const normalizedName = body.name.trim().replace(/\s+/g, ' ');

    if (!normalizedName) {
      throw new WatchlistInputError('A shared watchlist name is required.');
    }

    if (hasE2EAuthenticatedSession(request.cookies)) {
      const watchlists = readE2EWatchlists(request.cookies);
      const nextWatchlist = createE2ESharedWatchlist(
        normalizedName,
        watchlists.filter((watchlist) => watchlist.kind === 'shared').length,
      );
      const response = NextResponse.json(
        {
          watchlist: nextWatchlist,
        },
        { status: 201 },
      );

      setE2EWatchlistsCookie(response, [...watchlists, nextWatchlist]);

      return response;
    }

    const watchlist = await createSharedWatchlist({
      name: normalizedName,
      repository: createSupabaseWatchlistRepository({
        userClient: createServerSupabaseClient(auth.accessToken),
        adminClient: createServerSupabaseServiceRoleClient(),
      }),
      userId: auth.user.id,
    });

    return applyAuthCookies(
      auth,
      NextResponse.json(
        {
          watchlist,
        },
        { status: 201 },
      ),
    );
  } catch (error) {
    return applyAuthCookies(auth, handleDomainError(error));
  }
}
