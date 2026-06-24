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
    getMovieDetails: mocks.getMovieDetails,
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
    });
    expect(mocks.createSupabaseWatchlistRepository).toHaveBeenCalledWith({
      adminClient: { name: 'service-role-client' },
      userClient: { name: 'service-role-client' },
    });
    expect(upsertMovie).toHaveBeenCalledTimes(2);
  });

  it('allows the Vercel cron GET request shape with bearer auth', async () => {
    const upsertMovie = vi.fn(async () => ({ id: 42 }));

    mocks.createSupabaseWatchlistRepository.mockReturnValue({
      listTrackedMovies: vi.fn(async () => [buildMovieRow()]),
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
    });
    expect(upsertMovie).toHaveBeenCalledTimes(1);
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
    const upsertMovie = vi.fn(async () => {
      throw new Error('db write failed');
    });

    mocks.createSupabaseWatchlistRepository.mockReturnValue({
      listTrackedMovies: vi.fn(async () => [buildMovieRow()]),
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
      trackedMovies: 1,
      refreshedMovies: 0,
      failedMovies: 1,
    });
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
