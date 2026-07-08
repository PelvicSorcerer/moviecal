import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import {
  TMDbEnvironmentError,
  TMDbRequestError,
} from '../src/lib/tmdb/client';
import { TEST_TMDB_IDS } from '../src/lib/test-data/catalog';
import { buildNormalizedMovieSummaries } from './support';

const mocks = vi.hoisted(() => ({
  searchMovies: vi.fn(),
}));

vi.mock('../src/lib/tmdb/client', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/tmdb/client')>(
    '../src/lib/tmdb/client',
  );

  return {
    ...actual,
    searchMovies: mocks.searchMovies,
  };
});

describe('movie search route integration seam', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns 400 when the search query is missing', async () => {
    const { GET } = await import('../src/app/api/movies/search/route');
    const response = await GET(
      new NextRequest('https://moviecal.test/api/movies/search'),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Search query "q" is required.',
    });
    expect(mocks.searchMovies).not.toHaveBeenCalled();
  });

  it('returns normalized results through GET /api/movies/search', async () => {
    mocks.searchMovies.mockResolvedValue(
      buildNormalizedMovieSummaries([TEST_TMDB_IDS.MATRIX, TEST_TMDB_IDS.INCEPTION]),
    );

    const { GET } = await import('../src/app/api/movies/search/route');
    const response = await GET(
      new NextRequest('https://moviecal.test/api/movies/search?q=matrix'),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      results: [
        {
          tmdbId: TEST_TMDB_IDS.MATRIX,
          title: 'The Matrix',
          releaseDate: '1999-03-31',
          posterPath: '/matrix.jpg',
          overview: 'A hacker discovers the truth.',
        },
        {
          tmdbId: TEST_TMDB_IDS.INCEPTION,
          title: 'Inception',
          releaseDate: '2010-07-16',
          posterPath: '/inception.jpg',
          overview: 'A thief steals secrets through shared dreams.',
        },
      ],
    });
    expect(mocks.searchMovies).toHaveBeenCalledWith('matrix');
  });

  it('returns an empty result set when no movies match the query', async () => {
    mocks.searchMovies.mockResolvedValue([]);

    const { GET } = await import('../src/app/api/movies/search/route');
    const response = await GET(
      new NextRequest('https://moviecal.test/api/movies/search?q=unknown-title'),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ results: [] });
  });

  it('returns a safe 503 when TMDb is not configured', async () => {
    mocks.searchMovies.mockRejectedValue(
      new TMDbEnvironmentError('TMDB_API_KEY is not configured.'),
    );

    const { GET } = await import('../src/app/api/movies/search/route');
    const response = await GET(
      new NextRequest('https://moviecal.test/api/movies/search?q=matrix'),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'Movie search is unavailable until TMDb is configured.',
    });
  });

  it('passes through provider request failures with a safe message', async () => {
    mocks.searchMovies.mockRejectedValue(
      new TMDbRequestError('Movie search is temporarily unavailable.', 502),
    );

    const { GET } = await import('../src/app/api/movies/search/route');
    const response = await GET(
      new NextRequest('https://moviecal.test/api/movies/search?q=matrix'),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: 'Movie search is temporarily unavailable.',
    });
  });

  it('returns deterministic catalog results in E2E test mode without calling TMDb', async () => {
    vi.stubEnv('MOVIECAL_E2E_TEST_MODE', '1');

    const { GET } = await import('../src/app/api/movies/search/route');
    const response = await GET(
      new NextRequest('https://moviecal.test/api/movies/search?q=matrix'),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      results: [
        {
          tmdbId: TEST_TMDB_IDS.MATRIX,
          title: 'The Matrix',
          releaseDate: '1999-03-31',
          posterPath: '/matrix.jpg',
          overview: 'A hacker discovers the truth.',
        },
      ],
    });
    expect(mocks.searchMovies).not.toHaveBeenCalled();

    vi.unstubAllEnvs();
  });

  it('returns an empty result set for unmatched E2E catalog queries', async () => {
    vi.stubEnv('MOVIECAL_E2E_TEST_MODE', '1');

    const { GET } = await import('../src/app/api/movies/search/route');
    const response = await GET(
      new NextRequest('https://moviecal.test/api/movies/search?q=unknown-title'),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ results: [] });
    expect(mocks.searchMovies).not.toHaveBeenCalled();

    vi.unstubAllEnvs();
  });

  it('returns a safe 503 for handled E2E search failures', async () => {
    vi.stubEnv('MOVIECAL_E2E_TEST_MODE', '1');

    const { GET } = await import('../src/app/api/movies/search/route');
    const response = await GET(
      new NextRequest(
        'https://moviecal.test/api/movies/search?q=__e2e_search_unavailable__',
      ),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'Movie search is unavailable right now.',
    });
    expect(mocks.searchMovies).not.toHaveBeenCalled();

    vi.unstubAllEnvs();
  });
});
