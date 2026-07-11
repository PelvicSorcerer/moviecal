import { describe, expect, it, vi } from 'vitest';

import {
  fetchMovieDetail,
  persistMovieUpdate,
  runRefreshPipeline,
  selectTrackedMovieIds,
} from '../src/lib/release-refresh';
import { TMDbEnvironmentError } from '../src/lib/tmdb/env';
import { TMDbRequestError } from '../src/lib/tmdb/client';
import type { NormalizedMovieDetail } from '../src/lib/tmdb/client';
import type { WatchlistMovieRow } from '../src/lib/watchlist';
import { createWatchlistRepository } from './support/mocks/watchlist-repository';

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

function buildMovieDetail(
  overrides: Partial<NormalizedMovieDetail> = {},
): NormalizedMovieDetail {
  return {
    tmdbId: 603,
    title: 'The Matrix',
    releaseDate: '1999-03-31',
    posterPath: null,
    overview: null,
    rawJson: { id: 603 },
    ...overrides,
  };
}

describe('selectTrackedMovieIds', () => {
  it('returns deduplicated valid tmdb_ids', async () => {
    const repository = createWatchlistRepository({
      async listTrackedMovies() {
        return [
          buildMovieRow(),
          buildMovieRow({ id: 43, updated_at: '2026-06-23T01:00:00.000Z' }),
          buildMovieRow({ id: 44, tmdb_id: 27205, title: 'Inception' }),
        ];
      },
    });

    await expect(selectTrackedMovieIds(repository)).resolves.toEqual([603, 27205]);
  });

  it('filters out non-positive and non-integer tmdb_ids', async () => {
    const repository = createWatchlistRepository({
      async listTrackedMovies() {
        return [
          buildMovieRow({ tmdb_id: 0 }),
          buildMovieRow({ id: 43, tmdb_id: -1 }),
          buildMovieRow({ id: 44, tmdb_id: 603 }),
        ];
      },
    });

    await expect(selectTrackedMovieIds(repository)).resolves.toEqual([603]);
  });

  it('returns empty array when no tracked movies exist', async () => {
    const repository = createWatchlistRepository({
      async listTrackedMovies() {
        return [];
      },
    });

    await expect(selectTrackedMovieIds(repository)).resolves.toEqual([]);
  });
});

describe('fetchMovieDetail', () => {
  it('returns success result when getMovieDetails resolves', async () => {
    const detail = buildMovieDetail();
    const getMovieDetails = vi.fn().mockResolvedValue(detail);

    await expect(fetchMovieDetail(603, getMovieDetails)).resolves.toEqual({
      success: true,
      detail,
    });
    expect(getMovieDetails).toHaveBeenCalledWith(603);
  });

  it('returns failure result when getMovieDetails rejects with non-environment error', async () => {
    const error = new TMDbRequestError('TMDb request failed.', 502);
    const getMovieDetails = vi.fn().mockRejectedValue(error);

    await expect(fetchMovieDetail(603, getMovieDetails)).resolves.toEqual({
      success: false,
      tmdbId: 603,
      error,
    });
  });

  it('rethrows TMDbEnvironmentError instead of swallowing it', async () => {
    const error = new TMDbEnvironmentError('TMDb is not configured.');
    const getMovieDetails = vi.fn().mockRejectedValue(error);

    await expect(fetchMovieDetail(603, getMovieDetails)).rejects.toBeInstanceOf(
      TMDbEnvironmentError,
    );
  });

  it('returns failure result when getMovieDetails rejects with a generic error', async () => {
    const error = new Error('network timeout');
    const getMovieDetails = vi.fn().mockRejectedValue(error);

    const result = await fetchMovieDetail(603, getMovieDetails);
    expect(result).toEqual({ success: false, tmdbId: 603, error });
  });
});

describe('persistMovieUpdate', () => {
  it('calls upsertMovie with the provided detail', async () => {
    const upsertMovie = vi.fn().mockResolvedValue({ id: 42 });
    const repository = createWatchlistRepository({ upsertMovie });
    const detail = buildMovieDetail();

    await expect(persistMovieUpdate(detail, repository)).resolves.toBeUndefined();
    expect(upsertMovie).toHaveBeenCalledWith(detail);
  });

  it('propagates errors from upsertMovie', async () => {
    const error = new Error('db write failed');
    const upsertMovie = vi.fn().mockRejectedValue(error);
    const repository = createWatchlistRepository({ upsertMovie });

    await expect(persistMovieUpdate(buildMovieDetail(), repository)).rejects.toThrow(
      'db write failed',
    );
  });
});

describe('runRefreshPipeline', () => {
  it('refreshes all tracked movies and returns correct result on happy path', async () => {
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
      runRefreshPipeline({
        getMovieDetails,
        repository: createWatchlistRepository({
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
      failedMovieIds: [],
      failedMovies: 0,
      refreshedMovies: 2,
      trackedMovies: 2,
    });

    expect(getMovieDetails).toHaveBeenCalledTimes(2);
    expect(getMovieDetails).toHaveBeenNthCalledWith(1, 603);
    expect(getMovieDetails).toHaveBeenNthCalledWith(2, 27205);
    expect(upsertMovie).toHaveBeenCalledTimes(2);
  });

  it('records failing movie ids and continues processing remaining movies', async () => {
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
      runRefreshPipeline({
        getMovieDetails,
        repository: createWatchlistRepository({
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
      failedMovieIds: [603, 27205],
      failedMovies: 2,
      refreshedMovies: 1,
      trackedMovies: 3,
    });
  });

  it('surfaces TMDbEnvironmentError instead of masking it as a partial failure', async () => {
    await expect(
      runRefreshPipeline({
        getMovieDetails: async () => {
          throw new TMDbEnvironmentError('TMDb is not configured.');
        },
        repository: createWatchlistRepository({
          async listTrackedMovies() {
            return [buildMovieRow()];
          },
        }),
      }),
    ).rejects.toBeInstanceOf(TMDbEnvironmentError);
  });
});
