import type { Json } from '../supabase/database';
import { getServerTMDbEnv, TMDbEnvironmentError } from './env';

const TMDB_API_BASE_URL = 'https://api.themoviedb.org/3';

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

export class TMDbRequestError extends Error {
  readonly status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.name = 'TMDbRequestError';
    this.status = status;
  }
}

type TMDbFetch = typeof fetch;

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeReleaseDate(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmedValue = value.trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmedValue)) {
    return null;
  }

  return trimmedValue;
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmedValue = value.trim();

  return trimmedValue ? trimmedValue : null;
}

function normalizeMovieSummary(
  value: unknown,
): NormalizedMovieSummary | null {
  if (!isJsonRecord(value) || typeof value.id !== 'number') {
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
): Promise<unknown> {
  const url = createTMDbUrl(path, searchParams);

  let response: Response;

  try {
    response = await fetchImpl(url, {
      headers: {
        accept: 'application/json',
      },
    });
  } catch {
    throw new TMDbRequestError('TMDb request failed.');
  }

  if (!response.ok) {
    if (response.status === 404) {
      throw new TMDbRequestError('Movie not found.', 404);
    }

    if (response.status === 429) {
      throw new TMDbRequestError('TMDb is temporarily unavailable.', 503);
    }

    throw new TMDbRequestError('TMDb request failed.');
  }

  try {
    return await response.json();
  } catch {
    throw new TMDbRequestError('TMDb returned an invalid response.');
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
): Promise<NormalizedMovieSummary[]> {
  const trimmedQuery = query.trim();

  if (!trimmedQuery) {
    throw new TMDbRequestError('Search query is required.', 400);
  }

  const payload = await fetchTMDbJson(
    '/search/movie',
    {
      include_adult: 'false',
      query: trimmedQuery,
    },
    fetchImpl,
  );

  return normalizeSearchResponse(payload);
}

export async function getMovieDetails(
  tmdbId: number,
  fetchImpl: TMDbFetch = fetch,
): Promise<NormalizedMovieDetail> {
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
    throw new TMDbRequestError('A valid TMDb movie id is required.', 400);
  }

  const payload = await fetchTMDbJson(`/movie/${tmdbId}`, {}, fetchImpl);

  return normalizeDetailResponse(payload);
}

export { TMDbEnvironmentError };
