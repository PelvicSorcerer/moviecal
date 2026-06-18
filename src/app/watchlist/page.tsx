import type { Metadata } from 'next';
import { cookies } from 'next/headers';

import { requireAuthenticatedPageSession } from '../../lib/auth/session';
import { E2E_USER, readE2EWatchlistItems } from '../../lib/e2e/fixtures';
import { createServerSupabaseClient, createServerSupabaseServiceRoleClient } from '../../lib/supabase/server';
import { createSupabaseWatchlistRepository } from '../../lib/supabase/watchlist';
import { SupabaseEnvironmentError } from '../../lib/supabase/env';
import {
  listWatchlistItems,
  WatchlistDataError,
  type WatchlistItem,
} from '../../lib/watchlist';
import { WatchlistPageClient } from './watchlist-page-client';

export const metadata: Metadata = {
  title: 'Watchlist | moviecal',
  description: 'View and manage the private movies saved to your moviecal watchlist.',
};

export default async function WatchlistPage() {
  const { user, accessToken } = await requireAuthenticatedPageSession('/watchlist');
  let items: WatchlistItem[] = [];
  let errorMessage: string | null = null;

  if (user.id === E2E_USER.id) {
    items = readE2EWatchlistItems(await cookies());
  } else {
    try {
      items = await listWatchlistItems({
        repository: createSupabaseWatchlistRepository({
          userClient: createServerSupabaseClient(accessToken),
          adminClient: createServerSupabaseServiceRoleClient(),
        }),
        userId: user.id,
      });
    } catch (error) {
      if (error instanceof SupabaseEnvironmentError) {
        errorMessage =
          'Watchlist access is unavailable until Supabase is configured for this environment.';
      } else if (error instanceof WatchlistDataError) {
        errorMessage = error.message;
      } else {
        errorMessage = 'Could not load your watchlist right now.';
      }
    }
  }

  return (
    <section className="space-y-8">
      <div className="rounded-3xl bg-slate-950 px-8 py-10 text-white shadow-xl">
        <p className="text-sm font-medium uppercase tracking-[0.2em] text-sky-200">
          Private watchlist
        </p>
        <h2 className="mt-3 text-4xl font-semibold leading-tight">Your saved movies</h2>
        <p className="mt-4 max-w-2xl text-sm leading-7 text-slate-200">
          Keep release dates in one place and remove titles when you no longer want
          them in your personal calendar pipeline.
        </p>
        <p className="mt-5 text-sm text-slate-300">
          Signed in as <span className="font-medium text-white">{user.email ?? 'unknown user'}</span>.
        </p>
      </div>

      {errorMessage ? (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-6 text-sm text-rose-700 shadow-sm">
          <p className="text-base font-semibold text-rose-900">Watchlist unavailable</p>
          <p className="mt-2 leading-6">{errorMessage}</p>
        </div>
      ) : (
        <WatchlistPageClient initialItems={items} />
      )}
    </section>
  );
}
