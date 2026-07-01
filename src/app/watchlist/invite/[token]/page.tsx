import type { Metadata } from 'next';
import { cookies } from 'next/headers';

import { requireAuthenticatedPageSession } from '../../../../lib/auth/session';
import { resolveE2EWatchlistInvite } from '../../../../lib/e2e/shared-watchlists';
import { hasE2EAuthenticatedSession } from '../../../../lib/e2e/fixtures';
import {
  resolveWatchlistInvite,
} from '../../../../lib/watchlist';
import {
  createServerSupabaseClient,
  createServerSupabaseServiceRoleClient,
} from '../../../../lib/supabase/server';
import { createSupabaseWatchlistRepository } from '../../../../lib/supabase/watchlist';
import { WatchlistInvitePageClient } from './watchlist-invite-page-client';

export const metadata: Metadata = {
  title: 'Watchlist invite | moviecal',
  description: 'Accept a shared watchlist invite through the moviecal app.',
};

export default async function WatchlistInvitePage(
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params;
  const { accessToken } = await requireAuthenticatedPageSession(
    `/watchlist/invite/${token}`,
  );
  const cookieStore = await cookies();
  let watchlistId: string | null = null;
  let watchlistName: string | null = null;

  if (hasE2EAuthenticatedSession(cookieStore)) {
    const resolvedInvite = resolveE2EWatchlistInvite(cookieStore, token);

    if (resolvedInvite) {
      watchlistId = resolvedInvite.watchlist.id;
      watchlistName = resolvedInvite.watchlist.name;
    }
  } else {
    const repository = createSupabaseWatchlistRepository({
      userClient: createServerSupabaseClient(accessToken),
      adminClient: createServerSupabaseServiceRoleClient(),
    });
    const resolvedInvite = await resolveWatchlistInvite({
      repository,
      token,
    });

    if (resolvedInvite) {
      watchlistId = resolvedInvite.watchlist.id;
      watchlistName = resolvedInvite.watchlist.name;
    }
  }

  return (
    <section className="space-y-8">
      <div className="rounded-3xl bg-slate-950 px-8 py-10 text-white shadow-xl">
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-sky-200">
          Invite acceptance
        </p>
        <h1 className="mt-3 text-4xl font-semibold leading-tight">
          Join a shared watchlist
        </h1>
        <p className="mt-4 max-w-2xl text-sm leading-7 text-slate-200">
          Invite links are secret URLs. This page never reveals more than the minimum
          shared watchlist context needed to accept a valid invite.
        </p>
      </div>

      <WatchlistInvitePageClient
        canAccept={watchlistId !== null}
        token={token}
        watchlistId={watchlistId}
        watchlistName={watchlistName}
      />
    </section>
  );
}
