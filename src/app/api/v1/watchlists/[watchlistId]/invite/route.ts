import { NextResponse } from 'next/server';

import { apiError, handleDomainError } from '../../../../../../lib/api/response';
import { withHiddenUnauthorizedAccess } from '../../../../../../lib/api/member-access';
import { resolveBearerIdentity } from '../../../../../../lib/auth/bearer-identity';
import { createServerSupabaseServiceRoleClient } from '../../../../../../lib/supabase/server';
import { createSupabaseWatchlistRepository } from '../../../../../../lib/supabase/watchlist';
import {
  createSharedWatchlistInviteLink,
  revokeSharedWatchlistInviteLink,
} from '../../../../../../lib/watchlist';

/**
 * Generates (or rotates) the one live seven-day invite link for a shared list
 * the bearer owns. `createSharedWatchlistInviteLink` always calls the
 * transaction-safe `rotate_watchlist_invite_link` RPC (MOV-331), so a link
 * that already exists is atomically revoked and replaced rather than left
 * live alongside a second one: a failed rotation never strands the old link.
 * The raw token is embedded in `inviteUrl` in this one response only — it is
 * hashed before it is persisted and is never logged or re-readable from v1.
 * An accepted editor is refused with 403; an outsider or pending invitee, and
 * an unknown watchlist id, all get the same 404.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ watchlistId: string }> },
): Promise<NextResponse> {
  const identity = await resolveBearerIdentity(request);

  if (!identity) {
    return apiError('Unauthorized.', 401);
  }

  const { watchlistId } = await context.params;
  const repository = createSupabaseWatchlistRepository({
    userClient: identity.userClient,
    adminClient: createServerSupabaseServiceRoleClient(),
  });

  try {
    const result = await withHiddenUnauthorizedAccess({
      actorUserId: identity.user.id,
      operation: () => createSharedWatchlistInviteLink({
        actorUserId: identity.user.id,
        baseUrl: new URL(request.url).origin,
        repository,
        watchlistId,
      }),
      repository,
      watchlistId,
    });

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return handleDomainError(error);
  }
}

/**
 * Revokes the live invite link for a shared list the bearer owns, leaving no
 * replacement. Owner-only and idempotent: a list with no live link simply has
 * nothing to revoke, and the response does not distinguish that case from a
 * link that existed a moment ago. Authorization follows the same
 * owner/editor/outsider shape as `POST`.
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ watchlistId: string }> },
): Promise<NextResponse> {
  const identity = await resolveBearerIdentity(request);

  if (!identity) {
    return apiError('Unauthorized.', 401);
  }

  const { watchlistId } = await context.params;
  const repository = createSupabaseWatchlistRepository({
    userClient: identity.userClient,
    adminClient: createServerSupabaseServiceRoleClient(),
  });

  try {
    await withHiddenUnauthorizedAccess({
      actorUserId: identity.user.id,
      operation: () => revokeSharedWatchlistInviteLink({
        actorUserId: identity.user.id,
        repository,
        watchlistId,
      }),
      repository,
      watchlistId,
    });

    return NextResponse.json({ revoked: true });
  } catch (error) {
    return handleDomainError(error);
  }
}
