import { describe, expect, it, vi } from 'vitest';

import {
  MAX_RELEASE_DATE_CHANGES,
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

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settleWork() {
  await new Promise<void>((resolve) => setImmediate(resolve));
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
  it.each([1, 2, undefined, 20])('bounds fetch and persistence together with concurrency %s', async (concurrency) => {
    const movies = Array.from({ length: 7 }, (_, index) => buildMovieRow({ tmdb_id: index + 1 }));
    const fetches = movies.map(() => deferred<NormalizedMovieDetail>());
    const writes = movies.map(() => deferred<{ id: number }>());
    let active = 0;
    let maximumActive = 0;
    const getMovieDetails = vi.fn((tmdbId: number) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      return fetches[tmdbId - 1].promise;
    });
    const upsertMovie = vi.fn(async (detail: NormalizedMovieDetail) => {
      const result = await writes[detail.tmdbId - 1].promise;
      active -= 1;
      return result;
    });
    const run = runRefreshPipeline({
      concurrency,
      getMovieDetails,
      repository: createWatchlistRepository({ listTrackedMovies: async () => movies, upsertMovie }),
    });
    const limit = Math.min(concurrency ?? 5, movies.length);
    await settleWork();
    expect(getMovieDetails).toHaveBeenCalledTimes(limit);

    for (const [index, movie] of movies.entries()) {
      const started = Math.min(limit + index, movies.length);
      expect(getMovieDetails).toHaveBeenCalledTimes(started);
      fetches[index].resolve(buildMovieDetail({ tmdbId: movie.tmdb_id }));
      await settleWork();
      expect(upsertMovie).toHaveBeenCalledTimes(index + 1);
      expect(getMovieDetails).toHaveBeenCalledTimes(started);
      writes[index].resolve({ id: movie.tmdb_id });
      await settleWork();
    }

    expect(await run).toMatchObject({ trackedMovies: 7, refreshedMovies: 7, changedMovies: 7, failedMovies: 0 });
    expect(getMovieDetails.mock.calls.map(([tmdbId]) => tmdbId)).toEqual(movies.map((movie) => movie.tmdb_id));
    expect(maximumActive).toBe(limit);
    expect(active).toBe(0);
  });

  it('matches sequential results for mixed outcomes completed in reverse order', async () => {
    const movies = Array.from({ length: 7 }, (_, index) => buildMovieRow({ tmdb_id: index + 1 }));
    const fetches = movies.map(() => deferred<NormalizedMovieDetail>());
    const repository = createWatchlistRepository({
      listTrackedMovies: async () => movies,
      findMovieByTmdbId: async (tmdbId) => {
        if (tmdbId === 3) throw new Error('read failed');
        return movies[tmdbId - 1];
      },
      upsertMovie: async (detail) => {
        if (detail.tmdbId === 5) throw new Error('write failed');
        return { id: detail.tmdbId };
      },
    });
    const detailFor = (tmdbId: number) => buildMovieDetail({
      tmdbId, releaseDate: tmdbId === 6 ? '1999-03-31' : '2027-01-01',
      posterPath: '/matrix.jpg', overview: 'A hacker discovers the truth.',
    });
    const run = runRefreshPipeline({
      concurrency: 10, repository, getMovieDetails: (tmdbId) => fetches[tmdbId - 1].promise,
    });
    await settleWork();
    for (const movie of [...movies].reverse()) {
      if ([2, 4].includes(movie.tmdb_id)) {
        fetches[movie.tmdb_id - 1].reject(new TMDbRequestError('fetch failed', 502));
      } else {
        fetches[movie.tmdb_id - 1].resolve(detailFor(movie.tmdb_id));
      }
      await settleWork();
    }
    const sequential = await runRefreshPipeline({
      concurrency: 1, repository,
      getMovieDetails: async (tmdbId) => {
        if ([2, 4].includes(tmdbId)) throw new TMDbRequestError('fetch failed', 502);
        return detailFor(tmdbId);
      },
    });
    expect(await run).toEqual(sequential);
    expect(await run).toEqual({
      trackedMovies: 7, refreshedMovies: 3, failedMovies: 4, failedMovieIds: [2, 3, 4, 5],
      changedMovies: 2, unchangedMovies: 1,
      releaseDateChanges: [1, 7].map((tmdbId) => ({ tmdbId, from: '1999-03-31', to: '2027-01-01' })),
    });
  });

  it('stops scheduling on an environment error and waits for in-flight fetches and writes', async () => {
    const fetches = Array.from({ length: 3 }, () => deferred<NormalizedMovieDetail>());
    const write = deferred<{ id: number }>();
    const environmentError = new TMDbEnvironmentError('TMDb is not configured.');
    const getMovieDetails = vi.fn((tmdbId: number) => fetches[tmdbId - 1].promise);
    const upsertMovie = vi.fn(() => write.promise);
    const run = runRefreshPipeline({
      concurrency: 3, getMovieDetails,
      repository: createWatchlistRepository({
        listTrackedMovies: async () => Array.from({ length: 6 }, (_, index) => buildMovieRow({ tmdb_id: index + 1 })),
        upsertMovie,
      }),
    });
    const settled = vi.fn();
    const outcome = run.then(settled, (error) => { settled(); return error; });
    await settleWork();
    fetches[1].reject(environmentError);
    await settleWork();
    expect(getMovieDetails).toHaveBeenCalledTimes(3);
    expect(settled).not.toHaveBeenCalled();

    fetches[0].reject(new Error('ordinary fetch failure'));
    fetches[2].resolve(buildMovieDetail({ tmdbId: 3 }));
    await settleWork();
    expect(upsertMovie).toHaveBeenCalledOnce();
    expect(getMovieDetails).toHaveBeenCalledTimes(3);
    expect(settled).not.toHaveBeenCalled();
    write.resolve({ id: 3 });
    expect(await outcome).toBe(environmentError);
    expect(getMovieDetails.mock.calls.map(([tmdbId]) => tmdbId)).toEqual([1, 2, 3]);
  });

  it.each([0, -1, 1.5, NaN, Infinity])('rejects invalid concurrency %s before accessing the repository', async (concurrency) => {
    const listTrackedMovies = vi.fn();
    await expect(runRefreshPipeline({
      concurrency, getMovieDetails: vi.fn(),
      repository: createWatchlistRepository({ listTrackedMovies }),
    })).rejects.toThrow(RangeError);
    expect(listTrackedMovies).not.toHaveBeenCalled();
  });

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
      changedMovies: 2,
      unchangedMovies: 0,
      releaseDateChanges: [],
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
      changedMovies: 1,
      unchangedMovies: 0,
      releaseDateChanges: [],
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

  it('skips identical movies even when unrelated raw metadata differs', async () => {
    const upsertMovie = vi.fn();
    const result = await runRefreshPipeline({
      getMovieDetails: async () => buildMovieDetail({
        posterPath: '/matrix.jpg',
        overview: 'A hacker discovers the truth.',
        rawJson: { vote_count: 100 },
      }),
      repository: createWatchlistRepository({
        listTrackedMovies: async () => [buildMovieRow()],
        findMovieByTmdbId: async () => buildMovieRow(),
        upsertMovie,
      }),
    });

    expect(upsertMovie).not.toHaveBeenCalled();
    expect(result).toEqual({
      trackedMovies: 1, refreshedMovies: 1, failedMovies: 0, failedMovieIds: [],
      changedMovies: 0, unchangedMovies: 1, releaseDateChanges: [],
    });
  });

  it.each([
    { title: 'The Matrix (updated)' },
    { posterPath: '/new-poster.jpg' },
    { overview: 'Updated overview' },
  ])('persists a metadata-only change: %j', async (change) => {
    const detail = buildMovieDetail(change);
    const upsertMovie = vi.fn(async () => ({ id: 42 }));
    const result = await runRefreshPipeline({
      getMovieDetails: async () => detail,
      repository: createWatchlistRepository({
        listTrackedMovies: async () => [buildMovieRow()],
        findMovieByTmdbId: async () => buildMovieRow({ raw_json: {} }),
        upsertMovie,
      }),
    });

    expect(upsertMovie).toHaveBeenCalledExactlyOnceWith(detail);
    expect(result).toMatchObject({
      changedMovies: 1, unchangedMovies: 0, refreshedMovies: 1, releaseDateChanges: [],
    });
  });

  it.each([null, {}, { poster_path: ' ', overview: 123 }])(
    'normalizes missing or invalid stored metadata: %j', async (rawJson) => {
      const upsertMovie = vi.fn();
      const result = await runRefreshPipeline({
        getMovieDetails: async () => buildMovieDetail(),
        repository: createWatchlistRepository({
          listTrackedMovies: async () => [buildMovieRow()],
          findMovieByTmdbId: async () => buildMovieRow({ raw_json: rawJson }),
          upsertMovie,
        }),
      });

      expect(result.unchangedMovies).toBe(1);
      expect(upsertMovie).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['1999-03-31', '2027-01-01'],
    [null, '2027-01-01'],
    ['1999-03-31', null],
  ])('reports a saved release date change from %s to %s', async (from, to) => {
    const result = await runRefreshPipeline({
      getMovieDetails: async () => buildMovieDetail({ releaseDate: to }),
      repository: createWatchlistRepository({
        listTrackedMovies: async () => [buildMovieRow()],
        findMovieByTmdbId: async () => buildMovieRow({ release_date: from }),
      }),
    });

    expect(result).toMatchObject({
      changedMovies: 1, unchangedMovies: 0, refreshedMovies: 1,
      releaseDateChanges: [{ tmdbId: 603, from, to }],
    });
  });

  it('treats a missing stored row as changed without reporting a date change', async () => {
    const upsertMovie = vi.fn(async () => ({ id: 42 }));
    const result = await runRefreshPipeline({
      getMovieDetails: async () => buildMovieDetail(),
      repository: createWatchlistRepository({
        listTrackedMovies: async () => [buildMovieRow()],
        findMovieByTmdbId: async () => null,
        upsertMovie,
      }),
    });

    expect(upsertMovie).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      changedMovies: 1, unchangedMovies: 0, releaseDateChanges: [],
    });
  });

  it.each(['read', 'write'])('counts a %s failure without reporting an unsaved change', async (operation) => {
    const result = await runRefreshPipeline({
      getMovieDetails: async (tmdbId) => buildMovieDetail({ tmdbId, releaseDate: '2027-01-01' }),
      repository: createWatchlistRepository({
        listTrackedMovies: async () => [buildMovieRow(), buildMovieRow({ tmdb_id: 550 })],
        findMovieByTmdbId: vi.fn()
          .mockImplementationOnce(async () => {
            if (operation === 'read') throw new Error('read failed');
            return buildMovieRow();
          })
          .mockResolvedValueOnce(null),
        upsertMovie: operation === 'write'
          ? vi.fn().mockRejectedValueOnce(new Error('write failed')).mockResolvedValueOnce({ id: 42 })
          : vi.fn().mockResolvedValue({ id: 42 }),
      }),
    });

    expect(result).toEqual({
      trackedMovies: 2, refreshedMovies: 1, failedMovies: 1, failedMovieIds: [603],
      changedMovies: 1, unchangedMovies: 0, releaseDateChanges: [],
    });
  });

  it('bounds the date change report without limiting processing or counts', async () => {
    const movies = Array.from({ length: MAX_RELEASE_DATE_CHANGES + 5 }, (_, index) =>
      buildMovieRow({ tmdb_id: index + 1 }));
    const upsertMovie = vi.fn(async () => ({ id: 42 }));
    const result = await runRefreshPipeline({
      getMovieDetails: async (tmdbId) => buildMovieDetail({ tmdbId, releaseDate: '2027-01-01' }),
      repository: createWatchlistRepository({
        listTrackedMovies: async () => movies,
        findMovieByTmdbId: async (tmdbId) => movies[tmdbId - 1],
        upsertMovie,
      }),
    });

    expect(result.changedMovies).toBe(movies.length);
    expect(result.refreshedMovies).toBe(movies.length);
    expect(result.failedMovies).toBe(0);
    expect(result.releaseDateChanges).toHaveLength(MAX_RELEASE_DATE_CHANGES);
    expect(result.releaseDateChanges.at(-1)?.tmdbId).toBe(MAX_RELEASE_DATE_CHANGES);
    expect(upsertMovie).toHaveBeenCalledTimes(movies.length);
  });

  it('caps the date change report in tracked order rather than completion order', async () => {
    const movies = Array.from({ length: MAX_RELEASE_DATE_CHANGES + 5 }, (_, index) =>
      buildMovieRow({ tmdb_id: index + 1 }));
    const fetches = movies.map(() => deferred<NormalizedMovieDetail>());
    const run = runRefreshPipeline({
      concurrency: movies.length,
      getMovieDetails: (tmdbId) => fetches[tmdbId - 1].promise,
      repository: createWatchlistRepository({
        listTrackedMovies: async () => movies,
        findMovieByTmdbId: async (tmdbId) => movies[tmdbId - 1],
      }),
    });
    await settleWork();
    for (const movie of [...movies].reverse()) {
      fetches[movie.tmdb_id - 1].resolve(buildMovieDetail({ tmdbId: movie.tmdb_id, releaseDate: '2027-01-01' }));
      await settleWork();
    }
    const result = await run;
    expect(result.changedMovies).toBe(movies.length);
    expect(result.releaseDateChanges.map((change) => change.tmdbId))
      .toEqual(movies.slice(0, MAX_RELEASE_DATE_CHANGES).map((movie) => movie.tmdb_id));
  });

  it('returns zero counts and an empty report when nothing is tracked', async () => {
    const getMovieDetails = vi.fn();
    expect(await runRefreshPipeline({
      getMovieDetails,
      repository: createWatchlistRepository(),
    })).toEqual({
      trackedMovies: 0, refreshedMovies: 0, failedMovies: 0, failedMovieIds: [],
      changedMovies: 0, unchangedMovies: 0, releaseDateChanges: [],
    });
    expect(getMovieDetails).not.toHaveBeenCalled();
  });
});
