import type { NormalizedMovieDetail } from '../../tmdb/client';
import type { ServerSupabaseClient } from '../server';
import type { WatchlistMovieRow, WatchlistRow } from '../../watchlist';
import {
  throwSupabaseError,
  trackedMovieSelect,
  watchlistItemSelect,
} from './shared';

export function assertWatchlistMovieRow(data: unknown): WatchlistMovieRow {
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

export function assertWatchlistRow(data: unknown): WatchlistRow {
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

export function assertWatchlistRows(data: unknown): WatchlistRow[] {
  if (!Array.isArray(data)) {
    throw new Error('Supabase returned an invalid watchlist response.');
  }

  return data.map(assertWatchlistRow);
}

export function assertTrackedMovieRows(data: unknown): WatchlistMovieRow[] {
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

export function createItemsAggregate(args: {
  adminClient: ServerSupabaseClient;
  userClient: ServerSupabaseClient;
}) {
  return {
    async deleteItemByIdForWatchlist(
      watchlistId: string,
      itemId: string,
    ): Promise<boolean> {
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

    async findItemByMovieIdForWatchlist(
      watchlistId: string,
      movieId: number,
    ): Promise<WatchlistRow | null> {
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

    async insertItemForWatchlist(
      watchlistId: string,
      movieId: number,
    ): Promise<{ errorCode: string | null; row: WatchlistRow | null }> {
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

    async listItemsForWatchlist(watchlistId: string): Promise<WatchlistRow[]> {
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

    async listTrackedMovies(): Promise<WatchlistMovieRow[]> {
      const { data, error } = await args.adminClient
        .from('watchlist_items')
        .select(trackedMovieSelect);

      if (error) {
        throwSupabaseError(error);
      }

      return assertTrackedMovieRows(data);
    },

    async upsertMovie(detail: NormalizedMovieDetail): Promise<{ id: number }> {
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
