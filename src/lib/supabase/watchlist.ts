import type { PostgrestError } from '@supabase/supabase-js';

import type { ServerSupabaseClient } from './server';
import type {
  WatchlistAccessResult,
  WatchlistKind,
  WatchlistMovieRow,
  WatchlistRepository,
  WatchlistRow,
  WatchlistSummary,
} from '../watchlist';
import type { NormalizedMovieDetail } from '../tmdb/client';

const watchlistSelect = `
  id,
  owner_user_id,
  kind,
  name
`;

const watchlistItemSelect = `
  id,
  added_at,
  movie:movies!watchlist_items_movie_id_fkey (
    id,
    tmdb_id,
    title,
    release_date,
    raw_json,
    updated_at
  )
`;

const trackedMovieSelect = `
  movie:movies!watchlist_items_movie_id_fkey (
    id,
    tmdb_id,
    title,
    release_date,
    raw_json,
    updated_at
  )
`;

interface WatchlistMembershipRow {
  accepted_at: string | null;
  role: string;
}

interface WatchlistMembershipLookupRow {
  watchlist_id: string;
}

function assertWatchlistSummary(data: unknown): WatchlistSummary {
  if (
    typeof data !== 'object' ||
    data === null ||
    typeof (data as { id?: unknown }).id !== 'string' ||
    typeof (data as { owner_user_id?: unknown }).owner_user_id !== 'string' ||
    ((data as { kind?: unknown }).kind !== 'personal' &&
      (data as { kind?: unknown }).kind !== 'shared') ||
    typeof (data as { name?: unknown }).name !== 'string'
  ) {
    throw new Error('Supabase returned an invalid watchlist row.');
  }

  return {
    id: (data as { id: string }).id,
    kind: (data as { kind: WatchlistKind }).kind,
    name: (data as { name: string }).name,
    ownerUserId: (data as { owner_user_id: string }).owner_user_id,
  };
}

function assertWatchlistSummaries(data: unknown): WatchlistSummary[] {
  if (!Array.isArray(data)) {
    throw new Error('Supabase returned an invalid watchlists response.');
  }

  return data.map(assertWatchlistSummary);
}

function assertWatchlistRow(data: unknown): WatchlistRow {
  if (
    typeof data !== 'object' ||
    data === null ||
    typeof (data as { id?: unknown }).id !== 'string' ||
    typeof (data as { added_at?: unknown }).added_at !== 'string'
  ) {
    throw new Error('Supabase returned an invalid watchlist row.');
  }

  const movieValue = (data as { movie?: unknown }).movie;

  return {
    id: (data as { id: string }).id,
    added_at: (data as { added_at: string }).added_at,
    movie: movieValue as WatchlistMovieRow | null,
  };
}

function assertWatchlistMovieRow(data: unknown): WatchlistMovieRow {
  if (
    typeof data !== 'object' ||
    data === null ||
    typeof (data as { id?: unknown }).id !== 'number' ||
    typeof (data as { tmdb_id?: unknown }).tmdb_id !== 'number' ||
    typeof (data as { title?: unknown }).title !== 'string' ||
    !(
      typeof (data as { release_date?: unknown }).release_date === 'string' ||
      (data as { release_date?: unknown }).release_date === null
    ) ||
    typeof (data as { updated_at?: unknown }).updated_at !== 'string'
  ) {
    throw new Error('Supabase returned an invalid movie row.');
  }

  return data as WatchlistMovieRow;
}

function assertWatchlistRows(data: unknown): WatchlistRow[] {
  if (!Array.isArray(data)) {
    throw new Error('Supabase returned an invalid watchlist response.');
  }

  return data.map(assertWatchlistRow);
}

function assertTrackedMovieRows(data: unknown): WatchlistMovieRow[] {
  if (!Array.isArray(data)) {
    throw new Error('Supabase returned an invalid tracked movies response.');
  }

  const uniqueMovies = new Map<number, WatchlistMovieRow>();

  for (const row of data) {
    if (typeof row !== 'object' || row === null) {
      throw new Error('Supabase returned an invalid tracked movie row.');
    }

    const movieValue = (row as { movie?: unknown }).movie;

    if (movieValue === null || movieValue === undefined) {
      continue;
    }

    const movie = assertWatchlistMovieRow(movieValue);
    uniqueMovies.set(movie.tmdb_id, movie);
  }

  return [...uniqueMovies.values()];
}

function assertMembershipRow(data: unknown): WatchlistMembershipRow {
  if (
    typeof data !== 'object' ||
    data === null ||
    typeof (data as { role?: unknown }).role !== 'string' ||
    !(
      typeof (data as { accepted_at?: unknown }).accepted_at === 'string' ||
      (data as { accepted_at?: unknown }).accepted_at === null
    )
  ) {
    throw new Error('Supabase returned an invalid watchlist membership row.');
  }

  return {
    accepted_at: (data as { accepted_at: string | null }).accepted_at,
    role: (data as { role: string }).role,
  };
}

function assertMembershipLookupRows(data: unknown): WatchlistMembershipLookupRow[] {
  if (!Array.isArray(data)) {
    throw new Error('Supabase returned an invalid watchlist membership lookup.');
  }

  return data.map((row) => {
    if (
      typeof row !== 'object' ||
      row === null ||
      typeof (row as { watchlist_id?: unknown }).watchlist_id !== 'string'
    ) {
      throw new Error('Supabase returned an invalid watchlist membership lookup row.');
    }

    return {
      watchlist_id: (row as { watchlist_id: string }).watchlist_id,
    };
  });
}

function throwSupabaseError(error: PostgrestError | null): never {
  throw new Error(error?.message ?? 'Supabase request failed.');
}

export function createSupabaseWatchlistRepository(args: {
  adminClient: ServerSupabaseClient;
  userClient: ServerSupabaseClient;
}): WatchlistRepository {
  return {
    async ensurePersonalWatchlist(userId) {
      const { data: watchlistId, error: watchlistIdError } = await args.adminClient.rpc(
        'ensure_personal_watchlist_for_user',
        {
          target_user_id: userId,
        },
      );

      if (watchlistIdError || typeof watchlistId !== 'string') {
        throwSupabaseError(watchlistIdError);
      }

      const { data, error } = await args.adminClient
        .from('watchlists')
        .select(watchlistSelect)
        .eq('id', watchlistId)
        .single();

      if (error) {
        throwSupabaseError(error);
      }

      return assertWatchlistSummary(data);
    },

    async listWatchlistsForUser(userId) {
      const { data: ownedData, error: ownedError } = await args.adminClient
        .from('watchlists')
        .select(watchlistSelect)
        .eq('owner_user_id', userId)
        .order('created_at', { ascending: true });

      if (ownedError) {
        throwSupabaseError(ownedError);
      }

      const { data: membershipData, error: membershipError } = await args.adminClient
        .from('watchlist_memberships')
        .select('watchlist_id')
        .eq('user_id', userId)
        .not('accepted_at', 'is', null);

      if (membershipError) {
        throwSupabaseError(membershipError);
      }

      const watchlists = new Map<string, WatchlistSummary>();

      for (const watchlist of assertWatchlistSummaries(ownedData)) {
        watchlists.set(watchlist.id, watchlist);
      }

      const membershipRows = assertMembershipLookupRows(membershipData);
      const memberWatchlistIds = membershipRows
        .map((membership) => membership.watchlist_id)
        .filter((watchlistId) => !watchlists.has(watchlistId));

      if (memberWatchlistIds.length === 0) {
        return [...watchlists.values()];
      }

      const { data: memberWatchlistsData, error: memberWatchlistsError } =
        await args.adminClient
          .from('watchlists')
          .select(watchlistSelect)
          .in('id', memberWatchlistIds)
          .order('created_at', { ascending: true });

      if (memberWatchlistsError) {
        throwSupabaseError(memberWatchlistsError);
      }

      for (const watchlist of assertWatchlistSummaries(memberWatchlistsData)) {
        watchlists.set(watchlist.id, watchlist);
      }

      return [...watchlists.values()];
    },

    async listTrackedMovies() {
      const { data, error } = await args.adminClient
        .from('watchlist_items')
        .select(trackedMovieSelect);

      if (error) {
        throwSupabaseError(error);
      }

      return assertTrackedMovieRows(data);
    },

    async getWatchlistAccess(actorUserId, watchlistId): Promise<WatchlistAccessResult> {
      const { data: watchlistData, error: watchlistError } = await args.adminClient
        .from('watchlists')
        .select(watchlistSelect)
        .eq('id', watchlistId)
        .maybeSingle();

      if (watchlistError) {
        throwSupabaseError(watchlistError);
      }

      if (!watchlistData) {
        return { status: 'not_found' };
      }

      const watchlist = assertWatchlistSummary(watchlistData);

      if (watchlist.ownerUserId === actorUserId) {
        return {
          status: 'authorized',
          watchlist,
          canEdit: true,
        };
      }

      const { data: membershipData, error: membershipError } = await args.adminClient
        .from('watchlist_memberships')
        .select('accepted_at, role')
        .eq('watchlist_id', watchlistId)
        .eq('user_id', actorUserId)
        .maybeSingle();

      if (membershipError) {
        throwSupabaseError(membershipError);
      }

      if (!membershipData) {
        return { status: 'forbidden' };
      }

      const membership = assertMembershipRow(membershipData);

      if (!membership.accepted_at) {
        return { status: 'forbidden' };
      }

      return {
        status: 'authorized',
        watchlist,
        canEdit: membership.role === 'owner' || membership.role === 'editor',
      };
    },

    async listItemsForWatchlist(watchlistId) {
      const { data, error } = await args.adminClient
        .from('watchlist_items')
        .select(watchlistItemSelect)
        .eq('watchlist_id', watchlistId)
        .order('added_at', { ascending: false });

      if (error) {
        throwSupabaseError(error);
      }

      return assertWatchlistRows(data);
    },

    async findItemByMovieIdForWatchlist(watchlistId, movieId) {
      const { data, error } = await args.adminClient
        .from('watchlist_items')
        .select(watchlistItemSelect)
        .eq('watchlist_id', watchlistId)
        .eq('movie_id', movieId)
        .maybeSingle();

      if (error) {
        throwSupabaseError(error);
      }

      return data ? assertWatchlistRow(data) : null;
    },

    async insertItemForWatchlist(watchlistId, movieId) {
      const { data, error } = await args.adminClient
        .from('watchlist_items')
        .insert({
          watchlist_id: watchlistId,
          movie_id: movieId,
        })
        .select(watchlistItemSelect)
        .single();

      if (error) {
        return {
          row: null,
          errorCode: error.code ?? null,
        };
      }

      return {
        row: assertWatchlistRow(data),
        errorCode: null,
      };
    },

    async deleteItemByIdForWatchlist(watchlistId, itemId) {
      const { data, error } = await args.adminClient
        .from('watchlist_items')
        .delete()
        .eq('id', itemId)
        .eq('watchlist_id', watchlistId)
        .select('id')
        .maybeSingle();

      if (error) {
        throwSupabaseError(error);
      }

      return Boolean(data);
    },

    async upsertMovie(detail: NormalizedMovieDetail) {
      const { data, error } = await args.adminClient
        .from('movies')
        .upsert(
          {
            tmdb_id: detail.tmdbId,
            title: detail.title,
            release_date: detail.releaseDate,
            raw_json: detail.rawJson,
            updated_at: new Date().toISOString(),
          },
          {
            onConflict: 'tmdb_id',
          },
        )
        .select('id')
        .single();

      if (error || !data) {
        throwSupabaseError(error);
      }

      return { id: data.id };
    },
  };
}
