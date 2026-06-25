import { describe, expect, it, vi } from 'vitest';

import { refreshTrackedMovies } from '../src/lib/release-refresh';
import { TMDbEnvironmentError } from '../src/lib/tmdb/env';
import { TMDbRequestError } from '../src/lib/tmdb/client';
import type { WatchlistMovieRow, WatchlistRepository } from '../src/lib/watchlist';

function buildMovieRow(overrides: Partial<WatchlistMovieRow> = {}): WatchlistMovieRow {
  return {
    id: 42,
    tmdb_id: 603,
    title: 'The Matrix',
    release_date: '1999-03-31',
    raw_json: {
      overview: 'A hacker discovers the truth.',
      poster_path: '/matrix.jpg',
    },
    updated_at: '2026-06-23T00:00:00.000Z',
    ...overrides,
  };
}

function createRepository(
  overrides: Partial<WatchlistRepository> = {},
): WatchlistRepository {
  return {
    async deleteItemByIdForWatchlist() {
      return true;
    },
    async ensurePersonalWatchlist() {
      return {
        id: 'watchlist-1',
        kind: 'personal',
        name: 'My watchlist',
        ownerUserId: 'user-1',
      };
    },
    async findItemByMovieIdForWatchlist() {
      return null;
    },
    async getWatchlistAccess() {
      return {
        status: 'authorized',
        watchlist: {
          id: 'watchlist-1',
          kind: 'personal',
          name: 'My watchlist',
          ownerUserId: 'user-1',
        },
        canEdit: true,
      };
    },
    async insertItemForWatchlist() {
      return {
        row: null,
        errorCode: null,
      };
    },
    async listItemsForWatchlist() {
      return [];
    },
    async listTrackedMovies() {
      return [];
    },
    async listWatchlistsForUser() {
      return [];
    },
    async upsertMovie() {
      return { id: 42 };
    },
    ...overrides,
  };
}

describe('release refresh helper', () => {
  it('refreshes each tracked TMDb movie only once', async () => {
    const getMovieDetails = vi.fn(async (tmdbId: number) => ({
      tmdbId,
      title: tmdbId === 603 ? 'The Matrix' : 'Inception',
      releaseDate: tmdbId === 603 ? '1999-03-31' : '2010-07-16',
      posterPath: null,
      overview: null,
      rawJson: { id: tmdbId },
    }));
    const upsertMovie = vi.fn(async () => ({ id: 42 }));

    await expect(
      refreshTrackedMovies({
        getMovieDetails,
        repository: createRepository({
          async listTrackedMovies() {
            return [
              buildMovieRow(),
              buildMovieRow({ id: 43, updated_at: '2026-06-23T01:00:00.000Z' }),
              buildMovieRow({ id: 44, tmdb_id: 27205, title: 'Inception' }),
            ];
          },
          upsertMovie,
        }),
      }),
    ).resolves.toEqual({
      trackedMovies: 2,
      refreshedMovies: 2,
      failedMovies: 0,
    });

    expect(getMovieDetails).toHaveBeenCalledTimes(2);
    expect(getMovieDetails).toHaveBeenNthCalledWith(1, 603);
    expect(getMovieDetails).toHaveBeenNthCalledWith(2, 27205);
    expect(upsertMovie).toHaveBeenCalledTimes(2);
  });

  it('continues after per-movie TMDb or persistence failures', async () => {
    const getMovieDetails = vi
      .fn()
      .mockRejectedValueOnce(new TMDbRequestError('TMDb request failed.', 502))
      .mockResolvedValueOnce({
        tmdbId: 27205,
        title: 'Inception',
        releaseDate: '2010-07-16',
        posterPath: null,
        overview: null,
        rawJson: { id: 27205 },
      })
      .mockResolvedValueOnce({
        tmdbId: 550,
        title: 'Fight Club',
        releaseDate: '1999-10-15',
        posterPath: null,
        overview: null,
        rawJson: { id: 550 },
      });
    const upsertMovie = vi
      .fn()
      .mockRejectedValueOnce(new Error('db write failed'))
      .mockResolvedValueOnce({ id: 44 });

    await expect(
      refreshTrackedMovies({
        getMovieDetails,
        repository: createRepository({
          async listTrackedMovies() {
            return [
              buildMovieRow(),
              buildMovieRow({ id: 43, tmdb_id: 27205, title: 'Inception' }),
              buildMovieRow({ id: 44, tmdb_id: 550, title: 'Fight Club' }),
            ];
          },
          upsertMovie,
        }),
      }),
    ).resolves.toEqual({
      trackedMovies: 3,
      refreshedMovies: 1,
      failedMovies: 2,
    });
  });

  it('surfaces missing TMDb configuration instead of masking it as a partial failure', async () => {
    await expect(
      refreshTrackedMovies({
        getMovieDetails: async () => {
          throw new TMDbEnvironmentError('TMDb is not configured.');
        },
        repository: createRepository({
          async listTrackedMovies() {
            return [buildMovieRow()];
          },
        }),
      }),
    ).rejects.toBeInstanceOf(TMDbEnvironmentError);
  });
});
