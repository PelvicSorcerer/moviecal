import type { Metadata } from 'next';
import { cookies } from 'next/headers';

import { getOptionalPageSession } from '../../lib/auth/session';
import { findE2EUserById, readE2EWatchlists } from '../../lib/e2e/fixtures';
import {
  createServerSupabaseClient,
  createServerSupabaseServiceRoleClient,
} from '../../lib/supabase/server';
import { createSupabaseWatchlistRepository } from '../../lib/supabase/watchlist';
import { listUserWatchlists, type WatchlistSummary } from '../../lib/watchlist';
import { SearchPageClient } from './search-page-client';

export const metadata: Metadata = {
  title: 'Search',
  description: 'Search TMDb-backed movie results through the server-side moviecal API.',
};

function readQueryParam(
  value: string | string[] | undefined,
): string {
  if (Array.isArray(value)) {
    return value[0]?.trim() ?? '';
  }

  return value?.trim() ?? '';
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = (await searchParams) ?? {};
  const initialQuery = readQueryParam(params.q);
  const session = await getOptionalPageSession();
  let availableWatchlists: WatchlistSummary[] = [];
  let watchlistLoadFailed = false;

  if (session && findE2EUserById(session.user.id)) {
    availableWatchlists = readE2EWatchlists(await cookies());
  } else if (session) {
    try {
      availableWatchlists = await listUserWatchlists({
        repository: createSupabaseWatchlistRepository({
          userClient: createServerSupabaseClient(session.accessToken),
          adminClient: createServerSupabaseServiceRoleClient(),
        }),
        userId: session.user.id,
      });
    } catch {
      availableWatchlists = [];
      watchlistLoadFailed = true;
    }
  }

  return (
    <SearchPageClient
      initialQuery={initialQuery}
      isAuthenticated={Boolean(session)}
      availableWatchlists={availableWatchlists}
      watchlistLoadFailed={watchlistLoadFailed}
    />
  );
}
