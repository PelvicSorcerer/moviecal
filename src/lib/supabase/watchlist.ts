import type { PostgrestError } from '@supabase/supabase-js';

import type { ServerSupabaseClient } from './server';
import type {
  WatchlistMovieRow,
  WatchlistRepository,
  WatchlistRow,
} from '../watchlist';
import type { NormalizedMovieDetail } from '../tmdb/client';

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

function assertWatchlistRows(data: unknown): WatchlistRow[] {
  if (!Array.isArray(data)) {
    throw new Error('Supabase returned an invalid watchlist response.');
  }

  return data.map(assertWatchlistRow);
}

function throwSupabaseError(error: PostgrestError | null): never {
  throw new Error(error?.message ?? 'Supabase request failed.');
}

export function createSupabaseWatchlistRepository(args: {
  adminClient: ServerSupabaseClient;
  userClient: ServerSupabaseClient;
}): WatchlistRepository {
  return {
    async listItemsForUser(userId) {
      const { data, error } = await args.userClient
        .from('watchlist_items')
        .select(watchlistItemSelect)
        .eq('user_id', userId)
        .order('added_at', { ascending: false });

      if (error) {
        throwSupabaseError(error);
      }

      return assertWatchlistRows(data);
    },

    async findItemByMovieIdForUser(userId, movieId) {
      const { data, error } = await args.userClient
        .from('watchlist_items')
        .select(watchlistItemSelect)
        .eq('user_id', userId)
        .eq('movie_id', movieId)
        .maybeSingle();

      if (error) {
        throwSupabaseError(error);
      }

      return data ? assertWatchlistRow(data) : null;
    },

    async insertItemForUser(userId, movieId) {
      const { data, error } = await args.userClient
        .from('watchlist_items')
        .insert({
          user_id: userId,
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

    async deleteItemByIdForUser(userId, itemId) {
      const { data, error } = await args.userClient
        .from('watchlist_items')
        .delete()
        .eq('id', itemId)
        .eq('user_id', userId)
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
