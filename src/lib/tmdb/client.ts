import type { Json } from '../supabase/database';
import { createTMDbCacheKey, TMDbResponseCache } from './cache';
import { getServerTMDbEnv, TMDbEnvironmentError } from './env';

const TMDB_API_BASE_URL = 'https://api.themoviedb.org/3';
const MAX_ATTEMPTS = 3;
const REQUEST_BUDGET_MS = 10_000;
const RETRY_AFTER_CAP_MS = 2_000;
const BACKOFF_BASE_MS = 250;
export const TMDB_SEARCH_CACHE_TTL_MS = 60_000;
export const TMDB_DETAILS_CACHE_TTL_MS = 10 * 60_000;

const defaultTMDbResponseCache = new TMDbResponseCache();

export interface TMDbRetryOptions {
  sleep?: (delayMs: number) => Promise<void>;
  random?: () => number;
}

export interface TMDbRequestOptions extends TMDbRetryOptions {
  cache?: TMDbResponseCache | null;
}

export function clearTMDbResponseCache(): void {
  defaultTMDbResponseCache.clear();
}

export interface NormalizedMovieSummary {
  overview: string | null;
  posterPath: string | null;
  releaseDate: string | null;
  title: string;
  tmdbId: number;
}

export interface NormalizedMovieDetail extends NormalizedMovieSummary {
  rawJson: Json;
}

export interface MovieSearchPage {
  results: NormalizedMovieSummary[];
  page: number;
  totalPages: number;
  totalResults: number;
}

export class TMDbRequestError extends Error {
  readonly status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.name = 'TMDbRequestError';
    this.status = status;
  }
}

type TMDbFetch = typeof fetch;

function retryDelay(response: Response | undefined, attempt: number, random: () => number): number {
  const retryAfter = response?.status === 429 ? response.headers.get('retry-after')?.trim() : null;

  if (retryAfter && /^\d+$/.test(retryAfter)) {
    return Math.min(Number(retryAfter) * 1_000, RETRY_AFTER_CAP_MS);
  }

  const backoff = BACKOFF_BASE_MS * 2 ** attempt;
  return backoff * (0.5 + random() * 0.5);
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeReleaseDate(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmedValue = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmedValue);

  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  // setUTCFullYear (unlike Date.UTC/the Date constructor) has no two-digit
  // year special case, and it normalizes out-of-range month/day components
  // instead of throwing, so a round-trip check reliably detects impossible
  // calendar dates such as 2023-02-30 or 2023-02-29 (non-leap).
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);

  const isValidCalendarDate =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;

  return isValidCalendarDate ? trimmedValue : null;
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmedValue = value.trim();

  return trimmedValue ? trimmedValue : null;
}

function isValidTMDbId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function normalizeMovieSummary(
  value: unknown,
): NormalizedMovieSummary | null {
  if (!isJsonRecord(value) || !isValidTMDbId(value.id)) {
    return null;
  }

  const title =
    normalizeOptionalString(value.title) ??
    normalizeOptionalString(value.original_title);

  if (!title) {
    return null;
  }

  return {
    tmdbId: value.id,
    title,
    releaseDate: normalizeReleaseDate(value.release_date),
    posterPath: normalizeOptionalString(value.poster_path),
    overview: normalizeOptionalString(value.overview),
  };
}

function createTMDbUrl(
  path: string,
  searchParams: Record<string, string | number>,
): URL {
  const url = new URL(`${TMDB_API_BASE_URL}${path}`);
  const { apiKey } = getServerTMDbEnv();

  url.searchParams.set('api_key', apiKey);

  for (const [key, value] of Object.entries(searchParams)) {
    url.searchParams.set(key, String(value));
  }

  return url;
}

async function fetchTMDbJson(
  path: string,
  searchParams: Record<string, string | number>,
  fetchImpl: TMDbFetch,
  ttlMs: number,
  options: TMDbRequestOptions,
): Promise<unknown> {
  const cache = options.cache === undefined ? defaultTMDbResponseCache : options.cache;

  if (!cache) {
    return fetchTMDbJsonUncached(path, searchParams, fetchImpl, options);
  }

  return cache.getOrLoad(
    createTMDbCacheKey(path, searchParams),
    ttlMs,
    () => fetchTMDbJsonUncached(path, searchParams, fetchImpl, options),
  );
}

async function fetchTMDbJsonUncached(
  path: string,
  searchParams: Record<string, string | number>,
  fetchImpl: TMDbFetch,
  retryOptions: TMDbRetryOptions,
): Promise<unknown> {
  const url = createTMDbUrl(path, searchParams);
  const { sleep = (delayMs) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)),
    random = Math.random } = retryOptions;
  const controller = new AbortController();
  const deadline = Date.now() + REQUEST_BUDGET_MS;
  let lastError = new TMDbRequestError('TMDb request failed.');
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const budget = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(lastError);
      controller.abort();
    }, REQUEST_BUDGET_MS);
  });

  const request = async (): Promise<unknown> => {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      if (controller.signal.aborted || Date.now() >= deadline) {
        throw lastError;
      }

      let response: Response | undefined;

      try {
        response = await fetchImpl(url, {
          headers: { accept: 'application/json' },
          signal: controller.signal,
        });
      } catch {
        if (controller.signal.aborted) {
          throw lastError;
        }
      }

      if (controller.signal.aborted || Date.now() >= deadline) {
        throw lastError;
      }

      if (response?.ok) {
        try {
          return await response.json();
        } catch {
          throw new TMDbRequestError('TMDb returned an invalid response.');
        }
      }

      if (response?.status === 404) {
        throw new TMDbRequestError('Movie not found.', 404);
      }

      lastError = response?.status === 429
        ? new TMDbRequestError('TMDb is temporarily unavailable.', 503)
        : new TMDbRequestError('TMDb request failed.');

      if (response?.body) {
        void response.body.cancel().catch(() => undefined);
      }

      const transient = !response || response.status === 429
        || (response.status >= 500 && response.status <= 599);

      if (!transient || attempt === MAX_ATTEMPTS - 1) {
        throw lastError;
      }

      const delay = retryDelay(response, attempt, random);
      if (delay >= deadline - Date.now()) {
        throw lastError;
      }

      await sleep(delay);
    }

    throw lastError;
  };

  try {
    return await Promise.race([request(), budget]);
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeSearchResponse(payload: unknown): NormalizedMovieSummary[] {
  if (!isJsonRecord(payload) || !Array.isArray(payload.results)) {
    throw new TMDbRequestError('TMDb returned an invalid response.');
  }

  return payload.results.flatMap((movie): NormalizedMovieSummary[] => {
    const normalizedMovie = normalizeMovieSummary(movie);

    return normalizedMovie ? [normalizedMovie] : [];
  });
}

function normalizeDetailResponse(payload: unknown): NormalizedMovieDetail {
  const normalizedMovie = normalizeMovieSummary(payload);

  if (!normalizedMovie || !isJsonRecord(payload)) {
    throw new TMDbRequestError('TMDb returned an invalid response.');
  }

  return {
    ...normalizedMovie,
    rawJson: payload as Json,
  };
}

export async function searchMovies(
  query: string,
  fetchImpl: TMDbFetch = fetch,
  options: TMDbRequestOptions = {},
): Promise<NormalizedMovieSummary[]> {
  return (await searchMoviesPage(query, 1, fetchImpl, options)).results;
}

export async function searchMoviesPage(
  query: string,
  page = 1,
  fetchImpl: TMDbFetch = fetch,
  options: TMDbRequestOptions = {},
): Promise<MovieSearchPage> {
  const trimmedQuery = query.trim();

  if (!trimmedQuery) {
    throw new TMDbRequestError('Search query is required.', 400);
  }

  if (!Number.isInteger(page) || page < 1 || page > 500) {
    throw new TMDbRequestError('Page must be an integer between 1 and 500.', 400);
  }

  const payload = await fetchTMDbJson(
    '/search/movie',
    {
      include_adult: 'false',
      query: trimmedQuery,
      page,
    },
    fetchImpl,
    TMDB_SEARCH_CACHE_TTL_MS,
    options,
  );

  const results = normalizeSearchResponse(payload);
  const record = payload as Record<string, unknown>;
  const responsePage = typeof record.page === 'number' && Number.isInteger(record.page)
    && record.page >= 1 && record.page <= 500 ? record.page : page;
  const totalPages = typeof record.total_pages === 'number'
    && Number.isInteger(record.total_pages) && record.total_pages >= 0
    ? Math.min(record.total_pages, 500) : responsePage;
  const totalResults = typeof record.total_results === 'number'
    && Number.isInteger(record.total_results) && record.total_results >= 0
    ? record.total_results : results.length;

  return { results, page: responsePage, totalPages, totalResults };
}

export async function getMovieDetails(
  tmdbId: number,
  fetchImpl: TMDbFetch = fetch,
  options: TMDbRequestOptions = {},
): Promise<NormalizedMovieDetail> {
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
    throw new TMDbRequestError('A valid TMDb movie id is required.', 400);
  }

  const payload = await fetchTMDbJson(
    `/movie/${tmdbId}`,
    {},
    fetchImpl,
    TMDB_DETAILS_CACHE_TTL_MS,
    options,
  );

  return normalizeDetailResponse(payload);
}

export async function getFreshMovieDetails(
  tmdbId: number,
  fetchImpl: TMDbFetch = fetch,
): Promise<NormalizedMovieDetail> {
  return getMovieDetails(tmdbId, fetchImpl, { cache: null });
}

export { TMDbEnvironmentError };
