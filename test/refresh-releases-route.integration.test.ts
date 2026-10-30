import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WatchlistMovieRow } from '../src/lib/watchlist';

const mocks = vi.hoisted(() => ({
  createServerSupabaseServiceRoleClient: vi.fn(),
  createSupabaseWatchlistRepository: vi.fn(),
  getMovieDetails: vi.fn(),
}));

vi.mock('../src/lib/supabase/server', () => ({
  createServerSupabaseServiceRoleClient:
    mocks.createServerSupabaseServiceRoleClient,
}));

vi.mock('../src/lib/supabase/watchlist', () => ({
  createSupabaseWatchlistRepository: mocks.createSupabaseWatchlistRepository,
}));

vi.mock('../src/lib/tmdb/client', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/tmdb/client')>(
    '../src/lib/tmdb/client',
  );

  return {
    ...actual,
    getFreshMovieDetails: mocks.getMovieDetails,
  };
});

const originalEnv = { ...process.env };

function buildMovieRow(overrides: Partial<WatchlistMovieRow> = {}): WatchlistMovieRow {
  return {
    id: 42,
    tmdb_id: 603,
    title: 'The Matrix',
    release_date: '1999-03-31',
    raw_json: { id: 603 },
    updated_at: '2026-06-23T00:00:00.000Z',
    ...overrides,
  };
}

describe('refresh releases route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.env = {
      ...originalEnv,
      CRON_SECRET: 'cron-secret-for-tests',
    };

    mocks.createServerSupabaseServiceRoleClient.mockReturnValue({
      name: 'service-role-client',
    });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('refreshes tracked movies for an authorized request', async () => {
    const upsertMovie = vi.fn(async () => ({ id: 42 }));

    mocks.createSupabaseWatchlistRepository.mockReturnValue({
      listTrackedMovies: vi.fn(async () => [
        buildMovieRow(),
        buildMovieRow({ id: 43, tmdb_id: 27205, title: 'Inception' }),
      ]),
      findMovieByTmdbId: vi.fn(async (tmdbId) => buildMovieRow({ tmdb_id: tmdbId,
        title: tmdbId === 603 ? 'The Matrix' : 'Inception' })),
      upsertMovie,
    });
    mocks.getMovieDetails
      .mockResolvedValueOnce({
        tmdbId: 603,
        title: 'The Matrix',
        releaseDate: '1999-03-31',
        posterPath: null,
        overview: null,
        rawJson: { id: 603 },
      })
      .mockResolvedValueOnce({
        tmdbId: 27205,
        title: 'Inception',
        releaseDate: '2010-07-16',
        posterPath: null,
        overview: null,
        rawJson: { id: 27205 },
      });

    const { POST } = await import('../src/app/api/cron/refresh-releases/route');
    const response = await POST(
      new Request('https://moviecal.test/api/cron/refresh-releases', {
        method: 'POST',
        headers: {
          authorization: 'Bearer cron-secret-for-tests',
        },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      trackedMovies: 2,
      refreshedMovies: 2,
      failedMovies: 0,
      changedMovies: 1,
      unchangedMovies: 1,
      releaseDateChanges: [{ tmdbId: 27205, from: '1999-03-31', to: '2010-07-16' }],
    });
    expect(mocks.createSupabaseWatchlistRepository).toHaveBeenCalledWith({
      adminClient: { name: 'service-role-client' },
      userClient: { name: 'service-role-client' },
    });
    expect(upsertMovie).toHaveBeenCalledTimes(1);
  });

  it('allows the Vercel cron GET request shape with bearer auth', async () => {
    const upsertMovie = vi.fn(async () => ({ id: 42 }));

    mocks.createSupabaseWatchlistRepository.mockReturnValue({
      listTrackedMovies: vi.fn(async () => [buildMovieRow()]),
      findMovieByTmdbId: vi.fn(async () => buildMovieRow()),
      upsertMovie,
    });
    mocks.getMovieDetails.mockResolvedValue({
      tmdbId: 603,
      title: 'The Matrix',
      releaseDate: '1999-03-31',
      posterPath: null,
      overview: null,
      rawJson: { id: 603 },
    });

    const { GET } = await import('../src/app/api/cron/refresh-releases/route');
    const response = await GET(
      new Request('https://moviecal.test/api/cron/refresh-releases', {
        method: 'GET',
        headers: {
          authorization: 'Bearer cron-secret-for-tests',
          'user-agent': 'vercel-cron/1.0',
        },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      trackedMovies: 1,
      refreshedMovies: 1,
      failedMovies: 0,
      changedMovies: 0,
      unchangedMovies: 1,
      releaseDateChanges: [],
    });
    expect(upsertMovie).not.toHaveBeenCalled();
  });

  it('rejects unauthorized refresh attempts', async () => {
    const { POST } = await import('../src/app/api/cron/refresh-releases/route');
    const response = await POST(
      new Request('https://moviecal.test/api/cron/refresh-releases', {
        method: 'POST',
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: 'Unauthorized.',
    });
    expect(mocks.createSupabaseWatchlistRepository).not.toHaveBeenCalled();
    expect(mocks.getMovieDetails).not.toHaveBeenCalled();
  });

  it('returns a safe aggregate failure when one or more refreshes fail', async () => {
    const upsertMovie = vi.fn()
      .mockRejectedValueOnce(new Error('db write failed'))
      .mockResolvedValueOnce({ id: 43 });

    mocks.createSupabaseWatchlistRepository.mockReturnValue({
      listTrackedMovies: vi.fn(async () => [buildMovieRow(), buildMovieRow({ tmdb_id: 550 })]),
      findMovieByTmdbId: vi.fn(async (tmdbId) => buildMovieRow({ tmdb_id: tmdbId })),
      upsertMovie,
    });
    mocks.getMovieDetails.mockImplementation(async (tmdbId) => ({
      tmdbId,
      title: 'The Matrix',
      releaseDate: '2027-01-01',
      posterPath: null,
      overview: null,
      rawJson: { id: 603 },
    }));

    const { POST } = await import('../src/app/api/cron/refresh-releases/route');
    const response = await POST(
      new Request('https://moviecal.test/api/cron/refresh-releases', {
        method: 'POST',
        headers: {
          'x-cron-secret': 'cron-secret-for-tests',
        },
      }),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: 'One or more movie refreshes failed.',
      trackedMovies: 2,
      refreshedMovies: 1,
      failedMovies: 1,
      changedMovies: 1,
      unchangedMovies: 0,
      releaseDateChanges: [{ tmdbId: 550, from: '1999-03-31', to: '2027-01-01' }],
    });
  });

  it('uses five concurrent slots and reports partial failures after out-of-order work', async () => {
    const movies = Array.from({ length: 7 }, (_, index) => buildMovieRow({ tmdb_id: index + 1 }));
    const completions = movies.map(() => {
      let complete!: () => void;
      const promise = new Promise<void>((resolve) => { complete = resolve; });
      return { promise, complete };
    });
    const upsertMovie = vi.fn(async () => ({ id: 42 }));
    mocks.createSupabaseWatchlistRepository.mockReturnValue({
      listTrackedMovies: async () => movies,
      findMovieByTmdbId: async (tmdbId: number) => movies[tmdbId - 1],
      upsertMovie,
    });
    mocks.getMovieDetails.mockImplementation(async (tmdbId: number) => {
      await completions[tmdbId - 1].promise;
      if (tmdbId === 2) throw new Error('fetch failed');
      return {
        tmdbId, title: 'The Matrix', releaseDate: '2027-01-01',
        posterPath: null, overview: null, rawJson: { id: tmdbId },
      };
    });
    const { GET } = await import('../src/app/api/cron/refresh-releases/route');
    const run = GET(new Request('https://moviecal.test/api/cron/refresh-releases', {
      headers: { authorization: 'Bearer cron-secret-for-tests' },
    }));
    await vi.waitFor(() => expect(mocks.getMovieDetails).toHaveBeenCalledTimes(5));
    completions[4].complete();
    await vi.waitFor(() => expect(mocks.getMovieDetails).toHaveBeenCalledTimes(6));
    completions[5].complete();
    await vi.waitFor(() => expect(mocks.getMovieDetails).toHaveBeenCalledTimes(7));
    completions.forEach(({ complete }) => complete());
    const response = await run;
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: 'One or more movie refreshes failed.',
      trackedMovies: 7, refreshedMovies: 6, failedMovies: 1,
      changedMovies: 6, unchangedMovies: 0,
      releaseDateChanges: [1, 3, 4, 5, 6, 7].map((tmdbId) => ({
        tmdbId, from: '1999-03-31', to: '2027-01-01',
      })),
    });
    expect(upsertMovie).toHaveBeenCalledTimes(6);
  });

  it('returns 503 when the cron secret is not configured', async () => {
    delete process.env.CRON_SECRET;

    const { POST } = await import('../src/app/api/cron/refresh-releases/route');
    const response = await POST(
      new Request('https://moviecal.test/api/cron/refresh-releases', {
        method: 'POST',
        headers: {
          authorization: 'Bearer cron-secret-for-tests',
        },
      }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'Release refresh is unavailable until cron auth is configured.',
    });
  });
});
