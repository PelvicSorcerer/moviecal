import { NextResponse } from 'next/server';

import { apiError, handleDomainError } from '../../../../lib/api/response';
import { extractBearerToken } from '../../../../lib/auth/bearer';
import type { CookieValueReader } from '../../../../lib/auth/cookies';
import { resolveAuthTokensWithClient } from '../../../../lib/auth/identity';
import {
  buildCalendarSubscriptionUrl,
  getOrCreateCalendarToken,
  rotateCalendarToken,
} from '../../../../lib/calendar-tokens';
import { syncE2ECalendarToken } from '../../../../lib/e2e/calendar-token-state';
import { E2E_USER, isE2ETestModeEnabled } from '../../../../lib/e2e/fixtures';
import { readRequestOrigin } from '../../../../lib/request-origin';
import { createSupabaseCalendarTokenRepository } from '../../../../lib/supabase/calendar-tokens';
import {
  createServerSupabaseClient,
  createServerSupabaseServiceRoleClient,
} from '../../../../lib/supabase/server';

/**
 * Versioned mobile API surface for the authenticated user's calendar
 * subscription URL.
 *
 * Auth: `Authorization: Bearer <access-token>` only. This handler never reads
 * cookies (the Next.js cookie transport module is intentionally not imported).
 * The bearer token builds a user-scoped client (`userClient`) used both for
 * identity resolution (`resolveAuthTokensWithClient`, `allowRefresh: false`) and
 * for the RLS-scoped `calendar_tokens` reads/inserts in
 * `getOrCreateCalendarToken`, so the returned token always resolves strictly to
 * the authenticated user — the request never reads or returns another user's
 * token. A service-role client (`adminClient`) is only supplied to satisfy the
 * repository seam; the interactive get/insert path runs through `userClient`.
 * Expired/invalid/missing tokens receive a `401`; the handler never silently
 * refreshes or extends a token, leaving refresh to the mobile client.
 *
 * The response body carries `{ subscriptionUrl }`, and that URL embeds the raw
 * calendar token (a bearer credential). The token value and the response body
 * are therefore never logged. The URL is the canonical `/api/calendar/[token]`
 * feed URL, identical to the one the cookie-based settings page renders; a call
 * creates the token on demand when the user has none and is idempotent
 * (repeated calls return the same URL until the token is rotated).
 *
 * The existing cookie-based settings page (`src/app/settings/calendar`) is
 * unchanged; this surface is purely additive.
 */

/**
 * The bearer transport has no cookie jar. The E2E calendar-token state helper
 * only needs a reader to look up an override token; with no cookies present it
 * falls back to the default E2E token, matching the settings page behaviour.
 */
const EMPTY_COOKIE_READER: CookieValueReader = { get: () => undefined };

export async function GET(request: Request): Promise<NextResponse> {
  const token = extractBearerToken(request);

  if (!token) {
    return apiError('Unauthorized.', 401);
  }

  const userClient = createServerSupabaseClient(token);

  const auth = await resolveAuthTokensWithClient(
    userClient,
    // Bearer-only auth: the Authorization header carries no refresh token, so
    // there is nothing to refresh. `refreshToken` is empty and, with
    // `allowRefresh: false`, the refresh branch never runs and never reads it.
    { accessToken: token, refreshToken: '' },
    { allowRefresh: false },
  );

  if (!auth.user) {
    return apiError('Unauthorized.', 401);
  }

  try {
    const origin = readRequestOrigin(request.headers);

    // Honour the E2E path the same way the settings page does: register the E2E
    // token as active so the `/api/calendar/[token]` feed recognises it, and
    // build the URL from that token instead of touching the database.
    const calendarToken =
      isE2ETestModeEnabled() && auth.user.id === E2E_USER.id
        ? syncE2ECalendarToken(EMPTY_COOKIE_READER)
        : (
            await getOrCreateCalendarToken({
              repository: createSupabaseCalendarTokenRepository({
                adminClient: createServerSupabaseServiceRoleClient(),
                userClient,
              }),
              userId: auth.user.id,
            })
          ).token;

    const subscriptionUrl = buildCalendarSubscriptionUrl(origin, calendarToken);

    return NextResponse.json({ subscriptionUrl });
  } catch (error) {
    return handleDomainError(error);
  }
}

/**
 * Rotates the authenticated user's calendar token, replacing the previous token
 * in the repository so its `/api/calendar/[token]` feed URL stops resolving
 * immediately, and returns the new `{ subscriptionUrl }`.
 *
 * Auth and transport match `GET`: `Authorization: Bearer <access-token>` only,
 * no cookies, no silent refresh (`allowRefresh: false`). Rotation runs through
 * the user-scoped, RLS-enforced client, so a caller can only rotate their own
 * token. The response body embeds the new calendar token (a bearer credential)
 * and is therefore never logged. Expired/invalid/missing tokens receive a `401`.
 *
 * For the E2E test user, rotation is a no-op: the E2E path returns the stable
 * E2E token URL without touching the database, mirroring the `GET` behaviour.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const token = extractBearerToken(request);

  if (!token) {
    return apiError('Unauthorized.', 401);
  }

  const userClient = createServerSupabaseClient(token);

  const auth = await resolveAuthTokensWithClient(
    userClient,
    // Bearer-only auth: no refresh token on the header, and with
    // `allowRefresh: false` the refresh branch never runs or reads it.
    { accessToken: token, refreshToken: '' },
    { allowRefresh: false },
  );

  if (!auth.user) {
    return apiError('Unauthorized.', 401);
  }

  try {
    const origin = readRequestOrigin(request.headers);

    // Honour the E2E path the same way `GET` does: rotation is a no-op for the
    // E2E user — return the stable E2E token URL without touching the database.
    const calendarToken =
      isE2ETestModeEnabled() && auth.user.id === E2E_USER.id
        ? syncE2ECalendarToken(EMPTY_COOKIE_READER)
        : (
            await rotateCalendarToken({
              repository: createSupabaseCalendarTokenRepository({
                adminClient: createServerSupabaseServiceRoleClient(),
                userClient,
              }),
              userId: auth.user.id,
            })
          ).token;

    const subscriptionUrl = buildCalendarSubscriptionUrl(origin, calendarToken);

    return NextResponse.json({ subscriptionUrl });
  } catch (error) {
    return handleDomainError(error);
  }
}
