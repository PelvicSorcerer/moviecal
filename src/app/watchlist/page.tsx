import type { Metadata } from 'next';
import { cookies } from 'next/headers';

import { requireAuthenticatedPageSession } from '../../lib/auth/session';
import {
  E2E_USER,
  readE2EWatchlistItems,
  readE2EWatchlists,
} from '../../lib/e2e/fixtures';
import { createServerSupabaseClient, createServerSupabaseServiceRoleClient } from '../../lib/supabase/server';
import { createSupabaseWatchlistRepository } from '../../lib/supabase/watchlist';
import { SupabaseEnvironmentError } from '../../lib/supabase/env';
import {
  listPersonalWatchlistItems,
  listUserWatchlists,
  WatchlistAccessError,
  WatchlistDataError,
  type WatchlistItem,
  type WatchlistSummary,
} from '../../lib/watchlist';
import { WatchlistPageClient } from './watchlist-page-client';

export const metadata: Metadata = {
  title: 'Watchlists',
  description: 'Create shared watchlists and manage the movies saved to your personal moviecal watchlist.',
};

export default async function WatchlistPage() {
  const { user, accessToken } = await requireAuthenticatedPageSession('/watchlist');
  let items: WatchlistItem[] = [];
  let watchlists: WatchlistSummary[] = [];
  let overviewErrorMessage: string | null = null;
  let personalItemsErrorMessage: string | null = null;

  if (user.id === E2E_USER.id) {
    const cookieStore = await cookies();
    items = readE2EWatchlistItems(cookieStore);
    watchlists = readE2EWatchlists(cookieStore);
  } else {
    const repository = createSupabaseWatchlistRepository({
      userClient: createServerSupabaseClient(accessToken),
      adminClient: createServerSupabaseServiceRoleClient(),
    });

    try {
      watchlists = await listUserWatchlists({
        repository,
        userId: user.id,
      });
    } catch (error) {
      if (error instanceof SupabaseEnvironmentError) {
        overviewErrorMessage =
          'Watchlist access is unavailable until Supabase is configured for this environment.';
      } else if (error instanceof WatchlistAccessError) {
        overviewErrorMessage = error.message;
      } else if (error instanceof WatchlistDataError) {
        overviewErrorMessage = error.message;
      } else {
        overviewErrorMessage = 'Could not load your watchlists right now.';
      }
    }

    try {
      items = await listPersonalWatchlistItems({
        repository,
        userId: user.id,
      });
    } catch (error) {
      if (error instanceof SupabaseEnvironmentError) {
        personalItemsErrorMessage =
          'Personal watchlist items are unavailable until Supabase is configured for this environment.';
      } else if (error instanceof WatchlistAccessError) {
        personalItemsErrorMessage = error.message;
      } else if (error instanceof WatchlistDataError) {
        personalItemsErrorMessage = error.message;
      } else {
        personalItemsErrorMessage = 'Could not load your personal watchlist right now.';
      }
    }
  }

  const personalWatchlist =
    watchlists.find((watchlist) => watchlist.kind === 'personal') ?? null;

  return (
    <section className="space-y-8">
      <div className="rounded-3xl bg-slate-950 px-8 py-10 text-white shadow-xl">
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-sky-200">
          Watchlist overview
        </p>
        <h2 className="mt-3 text-4xl font-semibold leading-tight">Your personal and shared watchlists</h2>
        <p className="mt-4 max-w-2xl text-sm leading-7 text-slate-200">
          Create shared watchlists for collaborators, keep your personal watchlist private,
          and use this overview as the stable entry point for future watchlist detail and
          invite flows.
        </p>
        <p className="mt-5 text-sm text-slate-300">
          Signed in as <span className="font-medium text-white">{user.email ?? 'unknown user'}</span>.
        </p>
      </div>

      <WatchlistPageClient
        initialItems={items}
        initialWatchlists={watchlists}
        overviewErrorMessage={overviewErrorMessage}
        personalItemsErrorMessage={personalItemsErrorMessage}
        personalWatchlistId={personalWatchlist?.id ?? null}
      />
    </section>
  );
}
