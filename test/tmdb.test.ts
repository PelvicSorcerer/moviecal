import { afterEach, describe, expect, it, vi } from 'vitest';

import { GET as searchRoute } from '../src/app/api/movies/search/route';
import {
  getMovieDetails,
  searchMovies,
  TMDbRequestError,
} from '../src/lib/tmdb/client';
import { getServerTMDbEnv, TMDbEnvironmentError } from '../src/lib/tmdb/env';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

function setValidTMDbEnv(): void {
  process.env.TMDB_API_KEY = 'tmdb-key-for-tests';
}

describe('TMDb environment validation', () => {
  it('reads the server-only TMDb key', () => {
    setValidTMDbEnv();

    expect(getServerTMDbEnv()).toEqual({
      apiKey: 'tmdb-key-for-tests',
    });
  });

  it('rejects placeholder TMDb values', () => {
    process.env.TMDB_API_KEY = 'your-tmdb-api-key';

    expect(() => getServerTMDbEnv()).toThrowError(TMDbEnvironmentError);
    expect(() => getServerTMDbEnv()).toThrowError(/placeholder value/);
  });
});

describe('TMDb wrapper', () => {
  it('normalizes search results from TMDb', async () => {
    setValidTMDbEnv();

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            {
              id: 603,
              title: 'The Matrix',
              release_date: '1999-03-31',
              poster_path: '/f89U3ADr1oiB1s9GkdPOEpXUk5H.jpg',
              overview: 'A hacker discovers the truth.',
            },
            {
              id: 999,
              title: '  ',
              release_date: 'invalid-date',
            },
          ],
        }),
      ),
    );

    await expect(searchMovies('matrix', fetchMock)).resolves.toEqual([
      {
        tmdbId: 603,
        title: 'The Matrix',
        releaseDate: '1999-03-31',
        posterPath: '/f89U3ADr1oiB1s9GkdPOEpXUk5H.jpg',
        overview: 'A hacker discovers the truth.',
      },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/3/search/movie');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      'api_key=tmdb-key-for-tests',
    );
  });

  it('normalizes movie details for later watchlist caching', async () => {
    setValidTMDbEnv();

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 603,
          title: 'The Matrix',
          release_date: '1999-03-31',
          poster_path: '/f89U3ADr1oiB1s9GkdPOEpXUk5H.jpg',
          overview: 'A hacker discovers the truth.',
        }),
      ),
    );

    await expect(getMovieDetails(603, fetchMock)).resolves.toEqual({
      tmdbId: 603,
      title: 'The Matrix',
      releaseDate: '1999-03-31',
      posterPath: '/f89U3ADr1oiB1s9GkdPOEpXUk5H.jpg',
      overview: 'A hacker discovers the truth.',
      rawJson: {
        id: 603,
        title: 'The Matrix',
        release_date: '1999-03-31',
        poster_path: '/f89U3ADr1oiB1s9GkdPOEpXUk5H.jpg',
        overview: 'A hacker discovers the truth.',
      },
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/3/movie/603');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      'api_key=tmdb-key-for-tests',
    );
  });

  it('maps upstream failures to safe errors without leaking the TMDb key', async () => {
    process.env.TMDB_API_KEY = 'super-secret-tmdb-key';

    const fetchMock = vi.fn().mockResolvedValue(
      new Response('{"status_message":"Invalid API key: super-secret-tmdb-key"}', {
        status: 500,
      }),
    );

    await expect(searchMovies('matrix', fetchMock)).rejects.toMatchObject({
      name: 'TMDbRequestError',
      message: 'TMDb request failed.',
      status: 502,
    });

    await expect(searchMovies('matrix', fetchMock)).rejects.not.toThrow(
      /super-secret-tmdb-key/,
    );
  });

  it('rejects invalid movie ids before calling TMDb', async () => {
    await expect(getMovieDetails(0)).rejects.toMatchObject<TMDbRequestError>({
      message: 'A valid TMDb movie id is required.',
      status: 400,
    });
  });

  describe('release date normalization', () => {
    async function normalizeReleaseDateFromDetails(
      release_date: unknown,
    ): Promise<string | null> {
      setValidTMDbEnv();

      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 603,
            title: 'The Matrix',
            release_date,
          }),
        ),
      );

      const details = await getMovieDetails(603, fetchMock);

      return details.releaseDate;
    }

    it.each([
      ['1999-03-31', '1999-03-31'],
      ['2000-01-01', '2000-01-01'],
      ['2000-12-31', '2000-12-31'],
    ])('keeps the valid canonical release date %s unchanged', async (input, expected) => {
      await expect(normalizeReleaseDateFromDetails(input)).resolves.toBe(
        expected,
      );
    });

    it.each([
      ['2000-02-29', '2000-02-29'],
      ['2024-02-29', '2024-02-29'],
    ])('keeps the valid leap-day release date %s unchanged', async (input, expected) => {
      await expect(normalizeReleaseDateFromDetails(input)).resolves.toBe(
        expected,
      );
    });

    it.each([
      ['2023-02-29', 'non-leap-year February 29'],
      ['2025-02-30', 'February day overflow'],
      ['2025-04-31', 'April day overflow'],
      ['2025-01-32', 'day overflow'],
      ['2025-13-01', 'month overflow'],
      ['2025-00-15', 'month underflow'],
      ['2025-01-00', 'day underflow'],
    ])('normalizes the impossible release date %s (%s) to null', async (input) => {
      await expect(normalizeReleaseDateFromDetails(input)).resolves.toBeNull();
    });

    it.each([
      ['1999/03/31', 'slash-delimited date'],
      ['31-03-1999', 'day-first date'],
      ['1999-3-31', 'non-zero-padded month'],
      ['invalid-date', 'non-date string'],
      ['', 'empty string'],
      ['   ', 'blank string'],
    ])('normalizes the noncanonical release date %s (%s) to null', async (input) => {
      await expect(normalizeReleaseDateFromDetails(input)).resolves.toBeNull();
    });

    it.each([
      [null, 'null'],
      [undefined, 'undefined'],
      [19990331, 'a number'],
      [true, 'a boolean'],
      [{}, 'an object'],
      [['1999-03-31'], 'an array'],
    ])('normalizes the non-string release date %s to null', async (input) => {
      await expect(normalizeReleaseDateFromDetails(input)).resolves.toBeNull();
    });
  });
});

describe('movie search route', () => {
  it('returns 400 when q is missing', async () => {
    const response = await searchRoute(
      new Request('https://moviecal.test/api/movies/search'),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Search query "q" is required.',
    });
  });

  it('returns normalized TMDb search results', async () => {
    setValidTMDbEnv();

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            results: [
              {
                id: 550,
                title: 'Fight Club',
                release_date: '1999-10-15',
                poster_path: '/pB8BM7pdSp6B6Ih7QZ4DrQ3PmJK.jpg',
                overview: 'Mischief and mayhem.',
              },
            ],
          }),
        ),
      ),
    );

    const response = await searchRoute(
      new Request('https://moviecal.test/api/movies/search?q=fight%20club'),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      results: [
        {
          tmdbId: 550,
          title: 'Fight Club',
          releaseDate: '1999-10-15',
          posterPath: '/pB8BM7pdSp6B6Ih7QZ4DrQ3PmJK.jpg',
          overview: 'Mischief and mayhem.',
        },
      ],
    });
  });

  it('returns a safe 503 when TMDb is not configured', async () => {
    delete process.env.TMDB_API_KEY;

    const response = await searchRoute(
      new Request('https://moviecal.test/api/movies/search?q=matrix'),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'Movie search is unavailable until TMDb is configured.',
    });
  });
});
