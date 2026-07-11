import { NextResponse, type NextRequest } from 'next/server';

import { authenticateApiRequest } from '../../../../../lib/auth/session';
import { acceptE2EInvite } from '../../../../../lib/e2e/shared-watchlists';
import { hasE2EAuthenticatedSession } from '../../../../../lib/e2e/fixtures';
import {
  acceptWatchlistInvite,
} from '../../../../../lib/watchlist';
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

interface AcceptInviteRequestBody {
  token?: unknown;
}

async function readRequestBody(
  request: NextRequest,
): Promise<AcceptInviteRequestBody> {
  try {
    const body = (await request.json()) as AcceptInviteRequestBody;

    return typeof body === 'object' && body !== null ? body : {};
  } catch {
    return {};
  }
}

export async function POST(request: NextRequest) {
  const auth = await authenticateApiRequest(request);

  if (auth instanceof NextResponse) {
    return auth;
  }

  const body = await readRequestBody(request);
  const token = typeof body.token === 'string' ? body.token : '';

  try {
    if (hasE2EAuthenticatedSession(request.cookies)) {
      const response = NextResponse.json({});
      const result = acceptE2EInvite({
        actorUserId: auth.user.id,
        reader: request.cookies,
        response,
        token,
      });

      if (!result) {
        return apiError('Invite link is invalid or expired.', 404);
      }

      return NextResponse.json(result, {
        status: 200,
        headers: response.headers,
      });
    }

    const result = await acceptWatchlistInvite({
      actorUserId: auth.user.id,
      repository: createSupabaseWatchlistRepository({
        userClient: createServerSupabaseClient(auth.accessToken),
        adminClient: createServerSupabaseServiceRoleClient(),
      }),
      token,
    });

    return applyAuthCookies(auth, NextResponse.json(result));
  } catch (error) {
    return applyAuthCookies(auth, handleDomainError(error));
  }
}
