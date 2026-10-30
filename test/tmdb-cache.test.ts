import { afterEach, describe, expect, it, vi } from 'vitest';

import { TMDbResponseCache } from '../src/lib/tmdb/cache';
import {
  clearTMDbResponseCache,
  getFreshMovieDetails,
  getMovieDetails,
  searchMoviesPage,
  TMDB_DETAILS_CACHE_TTL_MS,
  TMDB_SEARCH_CACHE_TTL_MS,
} from '../src/lib/tmdb/client';

const originalEnv = { ...process.env };

afterEach(() => {
  clearTMDbResponseCache();
  process.env = { ...originalEnv };
});

function setup(maxEntries = 10) {
  process.env.TMDB_API_KEY = 'secret-cache-key';
  let now = 1_000;
  const cache = new TMDbResponseCache({ maxEntries, now: () => now });
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const id = Number(url.pathname.split('/').pop());
    return Response.json(url.pathname.endsWith('/search/movie')
      ? { results: [{ id: 603, title: url.searchParams.get('query') }], page: 1 }
      : { id, title: `Movie ${id}` });
  });

  return {
    advance: (ms: number) => { now += ms; },
    cache,
    fetchMock,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, reject, resolve };
}

describe('TMDb response cache', () => {
  it('serves search hits within the TTL and refetches after expiry', async () => {
    const { advance, cache, fetchMock } = setup();

    await searchMoviesPage('matrix', 1, fetchMock, { cache });
    advance(TMDB_SEARCH_CACHE_TTL_MS - 1);
    await searchMoviesPage('matrix', 1, fetchMock, { cache });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    advance(1);
    await searchMoviesPage('matrix', 1, fetchMock, { cache });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('uses the longer detail TTL', async () => {
    const { advance, cache, fetchMock } = setup();

    await getMovieDetails(603, fetchMock, { cache });
    advance(TMDB_DETAILS_CACHE_TTL_MS - 1);
    await getMovieDetails(603, fetchMock, { cache });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    advance(1);
    await getMovieDetails(603, fetchMock, { cache });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent identical calls into one upstream fetch', async () => {
    const { cache } = setup();
    const response = deferred<Response>();
    const fetchMock = vi.fn(() => response.promise);

    const calls = [getMovieDetails(603, fetchMock, { cache }), getMovieDetails(603, fetchMock, { cache })];
    expect(fetchMock).toHaveBeenCalledTimes(1);
    response.resolve(Response.json({ id: 603, title: 'The Matrix' }));

    const [first, second] = await Promise.all(calls);
    expect(second).toEqual(first);
  });

  it('shares a failure with its burst but does not cache it', async () => {
    const { cache } = setup();
    const response = deferred<Response>();
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => response.promise)
      .mockResolvedValueOnce(Response.json({ id: 603, title: 'The Matrix' }));

    const results = Promise.allSettled([
      getMovieDetails(603, fetchMock, { cache }),
      getMovieDetails(603, fetchMock, { cache }),
    ]);
    response.resolve(new Response(null, { status: 404 }));

    const settled = await results;
    expect(settled.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cache.size).toBe(0);
    await expect(getMovieDetails(603, fetchMock, { cache })).resolves.toMatchObject({ tmdbId: 603 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps a bounded LRU set of entries', async () => {
    const { cache, fetchMock } = setup(2);

    await getMovieDetails(1, fetchMock, { cache });
    await getMovieDetails(2, fetchMock, { cache });
    await getMovieDetails(1, fetchMock, { cache });
    await getMovieDetails(3, fetchMock, { cache });
    expect(cache.size).toBe(2);
    expect(cache.keys()).toEqual(['/movie/1', '/movie/3']);

    await getMovieDetails(1, fetchMock, { cache });
    await getMovieDetails(2, fetchMock, { cache });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(cache.size).toBe(2);
  });

  it('builds credential-free keys from the path and all query parameters', async () => {
    const { cache, fetchMock } = setup();

    await searchMoviesPage(' matrix ', 2, fetchMock, { cache });
    expect(cache.keys()).toEqual(['/search/movie?include_adult=false&page=2&query=matrix']);
    expect(cache.keys().join('\n')).not.toContain('secret-cache-key');
    expect(cache.keys().join('\n')).not.toContain('api_key');
  });

  it('bypasses the cache for fresh detail reads and supports clearing', async () => {
    const { cache, fetchMock } = setup();

    await getMovieDetails(603, fetchMock);
    await getFreshMovieDetails(603, fetchMock);
    await getFreshMovieDetails(603, fetchMock);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await getMovieDetails(604, fetchMock, { cache });
    cache.clear();
    await getMovieDetails(604, fetchMock, { cache });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});
