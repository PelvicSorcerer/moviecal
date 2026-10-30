import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getMovieDetails, searchMovies, searchMoviesPage, TMDbRequestError } from '../src/lib/tmdb/client';

beforeEach(() => {
  vi.stubEnv('TMDB_API_KEY', 'tmdb-key-for-tests');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function retryOptions(randomValue = 0) {
  return { sleep: vi.fn().mockResolvedValue(undefined), random: vi.fn(() => randomValue) };
}

describe('TMDb bounded retries', () => {
  it.each(['network', 429, 500, 503, 599])('retries %s and returns a successful search', async (failure) => {
    const fetchMock = vi.fn();
    if (failure === 'network') {
      fetchMock.mockRejectedValueOnce(new TypeError('network failed'));
    } else {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: Number(failure) }));
    }
    fetchMock.mockResolvedValueOnce(Response.json({ results: [{ id: 603, title: 'The Matrix' }] }));
    const options = retryOptions();

    await expect(searchMovies('matrix', fetchMock, options)).resolves.toMatchObject([{ tmdbId: 603 }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(options.sleep.mock.calls).toEqual([[125]]);
    expect(fetchMock.mock.calls[0]?.[0]).toEqual(fetchMock.mock.calls[1]?.[0]);
    expect(fetchMock.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
  });

  it('retries twice for details with exponential backoff and fixed jitter', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce(Response.json({ id: 603, title: 'The Matrix' }));
    const options = retryOptions(0.5);

    await expect(getMovieDetails(603, fetchMock, options)).resolves.toMatchObject({ tmdbId: 603 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(options.sleep.mock.calls).toEqual([[187.5], [375]]);
  });

  it('does not sleep or sample randomness on the happy path', async () => {
    vi.useFakeTimers();
    const options = retryOptions();
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ results: [] }));

    await expect(searchMoviesPage('matrix', 2, fetchMock, options)).resolves.toMatchObject({ page: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(options.sleep).not.toHaveBeenCalled();
    expect(options.random).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses the default sleep only between failed attempts', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ results: [] }));
    const result = searchMovies('matrix', fetchMock, { random: () => 0 });

    await vi.advanceTimersByTimeAsync(124);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['network', 502, 'TMDb request failed.'],
    [429, 503, 'TMDb is temporarily unavailable.'],
    [500, 502, 'TMDb request failed.'],
  ])('preserves the public error after exhausting %s', async (failure, status, message) => {
    const fetchMock = vi.fn().mockImplementation(async () => {
      if (failure === 'network') throw new Error('secret upstream information');
      return new Response(null, { status: Number(failure) });
    });
    const options = retryOptions(1);
    const result = searchMovies('matrix', fetchMock, options);

    await expect(result).rejects.toBeInstanceOf(TMDbRequestError);
    await expect(result).rejects.toMatchObject({ status, message });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(options.sleep.mock.calls).toEqual([[250], [500]]);
  });

  it.each([400, 401, 403, 404, 408, 422])('never retries HTTP %s', async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status }));
    const options = retryOptions();

    await expect(getMovieDetails(603, fetchMock, options)).rejects.toMatchObject({
      name: 'TMDbRequestError',
      status: status === 404 ? 404 : 502,
      message: status === 404 ? 'Movie not found.' : 'TMDb request failed.',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(options.sleep).not.toHaveBeenCalled();
  });

  it.each([
    ['0', 0], ['1', 1_000], ['2', 2_000], ['999999999999999999999', 2_000],
    [' 1 ', 1_000], ['', 125], ['invalid', 125], ['-1', 125], ['1.5', 125],
    ['Infinity', 125], ['1e3', 125], ['Fri, 30 Oct 2026 10:00:00 GMT', 125],
  ])('parses Retry-After %j with a cap and fallback', async (header, delay) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'retry-after': header } }))
      .mockResolvedValueOnce(Response.json({ results: [] }));
    const options = retryOptions();

    await expect(searchMovies('matrix', fetchMock, options)).resolves.toEqual([]);
    expect(options.sleep.mock.calls).toEqual([[delay]]);
  });

  it('ignores Retry-After on 5xx and uses backoff', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503, headers: { 'retry-after': '2' } }))
      .mockResolvedValueOnce(Response.json({ results: [] }));
    const options = retryOptions();

    await searchMovies('matrix', fetchMock, options);
    expect(options.sleep.mock.calls).toEqual([[125]]);
  });

  it('does not retry invalid JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('not json'));
    const options = retryOptions();

    await expect(searchMovies('matrix', fetchMock, options)).rejects.toMatchObject({
      message: 'TMDb returned an invalid response.', status: 502,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(options.sleep).not.toHaveBeenCalled();
  });

  it('bounds even a fetch that ignores abort and clears its deadline timer', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(() => new Promise(() => {}));
    const result = searchMovies('matrix', fetchMock, retryOptions());
    const rejection = expect(result).rejects.toMatchObject({
      name: 'TMDbRequestError', status: 502, message: 'TMDb request failed.',
    });

    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
    expect(fetchMock.mock.calls[0]?.[1].signal.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('includes response body consumption in the total budget', async () => {
    vi.useFakeTimers();
    const response = Response.json({ results: [] });
    vi.spyOn(response, 'json').mockImplementation(() => new Promise(() => {}));
    const fetchMock = vi.fn().mockResolvedValue(response);
    const result = searchMovies('matrix', fetchMock, retryOptions());
    const rejection = expect(result).rejects.toBeInstanceOf(TMDbRequestError);

    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
    expect(fetchMock.mock.calls[0]?.[1].signal.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shares one budget across attempts and delays, preserving the last 429 error', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 8_000));
        return new Response(null, { status: 429, headers: { 'retry-after': '1' } });
      })
      .mockImplementationOnce(() => new Promise(() => {}));
    const options = { ...retryOptions(), sleep: vi.fn(async (delay: number) => {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }) };
    const result = searchMovies('matrix', fetchMock, options);
    const rejection = expect(result).rejects.toMatchObject({
      status: 503, message: 'TMDb is temporarily unavailable.',
    });

    await vi.advanceTimersByTimeAsync(9_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(options.sleep.mock.calls).toEqual([[1_000]]);
    await vi.advanceTimersByTimeAsync(1_000);
    await rejection;
    expect(fetchMock.mock.calls[1]?.[1].signal.aborted).toBe(true);
  });

  it('does not start another attempt if the backoff cannot fit in the budget', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 9_000));
      return new Response(null, { status: 429, headers: { 'retry-after': '2' } });
    });
    const options = retryOptions();
    const result = searchMovies('matrix', fetchMock, options);
    const rejection = expect(result).rejects.toMatchObject({ status: 503 });

    await vi.advanceTimersByTimeAsync(9_000);
    await rejection;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(options.sleep).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not continue retrying after an injected sleep outlives the deadline', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 429 }));
    let resumeSleep!: () => void;
    const sleep = vi.fn(() => new Promise<void>((resolve) => { resumeSleep = resolve; }));
    const result = searchMovies('matrix', fetchMock, { sleep, random: () => 0 });
    const rejection = expect(result).rejects.toMatchObject({ status: 503 });

    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
    resumeSleep();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
