import type { User } from '@supabase/supabase-js';
import {
  createAccessTokenCookieOptions,
  createExpiredCookieOptions,
  type CookieValueReader,
} from '../auth/cookies';
import type { NormalizedMovieDetail, NormalizedMovieSummary } from '../tmdb/client';
import type { WatchlistItem } from '../watchlist';

export const E2E_AUTH_COOKIE = 'moviecal-e2e-auth';
export const E2E_WATCHLIST_COOKIE = 'moviecal-e2e-watchlist';
export const E2E_CALENDAR_TOKEN_COOKIE = 'moviecal-e2e-calendar-token';
const E2E_CALENDAR_TOKEN_PREFIX = 'e2e-calendar-token';

const E2E_AUTHENTICATED_VALUE = 'authenticated';
const E2E_COOKIE_MAX_AGE_SECONDS = 60 * 60;
export const E2E_DEFAULT_CALENDAR_TOKEN = 'e2e-calendar-token-initial-1234567890';

interface CookieWriter {
  cookies: {
    set(name: string, value: string, options: ReturnType<typeof createAccessTokenCookieOptions>): void;
  };
}

export const E2E_USER: User = {
  id: 'e2e-user',
  email: 'e2e@example.com',
  app_metadata: {
    provider: 'e2e',
  },
  aud: 'authenticated',
  created_at: '2026-06-18T00:00:00.000Z',
  user_metadata: {
    label: 'Playwright smoke user',
  },
};

export const E2E_SESSION = {
  accessToken: 'e2e-access-token',
  expiresIn: E2E_COOKIE_MAX_AGE_SECONDS,
  refreshToken: 'e2e-refresh-token',
};

const MOVIE_FIXTURES: Record<number, NormalizedMovieDetail> = {
  603: {
    tmdbId: 603,
    title: 'The Matrix',
    releaseDate: '1999-03-31',
    posterPath: '/matrix.jpg',
    overview: 'A hacker discovers the truth.',
    rawJson: {
      id: 603,
      title: 'The Matrix',
      release_date: '1999-03-31',
      poster_path: '/matrix.jpg',
      overview: 'A hacker discovers the truth.',
    },
  },
  27205: {
    tmdbId: 27205,
    title: 'Inception',
    releaseDate: '2010-07-16',
    posterPath: '/inception.jpg',
    overview: 'A thief steals secrets through shared dreams.',
    rawJson: {
      id: 27205,
      title: 'Inception',
      release_date: '2010-07-16',
      poster_path: '/inception.jpg',
      overview: 'A thief steals secrets through shared dreams.',
    },
  },
};

const MOVIE_ADDED_AT: Record<number, string> = {
  603: '2026-06-18T12:00:00.000Z',
  27205: '2026-06-18T12:05:00.000Z',
};

export function isE2ETestModeEnabled(): boolean {
  return process.env.MOVIECAL_E2E_TEST_MODE === '1';
}

export function hasE2EAuthenticatedSession(reader: CookieValueReader): boolean {
  return isE2ETestModeEnabled()
    && reader.get(E2E_AUTH_COOKIE)?.value === E2E_AUTHENTICATED_VALUE;
}

export function getE2EMovieFixture(
  tmdbId: number,
): NormalizedMovieDetail | null {
  return MOVIE_FIXTURES[tmdbId] ?? null;
}

export function getE2EMovieSummaries(
  tmdbIds: number[],
): NormalizedMovieSummary[] {
  return tmdbIds.flatMap((tmdbId) => {
    const movie = getE2EMovieFixture(tmdbId);

    return movie
      ? [
          {
            tmdbId: movie.tmdbId,
            title: movie.title,
            releaseDate: movie.releaseDate,
            posterPath: movie.posterPath,
            overview: movie.overview,
          },
        ]
      : [];
  });
}

export function createE2EWatchlistItem(tmdbId: number): WatchlistItem {
  const movie = getE2EMovieFixture(tmdbId);

  if (!movie) {
    throw new Error(`Missing E2E movie fixture for tmdbId ${tmdbId}.`);
  }

  return {
    id: `e2e-watchlist-item-${tmdbId}`,
    addedAt: MOVIE_ADDED_AT[tmdbId] ?? MOVIE_ADDED_AT[603],
    movie: {
      id: tmdbId,
      tmdbId: movie.tmdbId,
      title: movie.title,
      releaseDate: movie.releaseDate,
      overview: movie.overview,
      posterPath: movie.posterPath,
    },
  };
}

export function serializeE2EWatchlistItems(items: WatchlistItem[]): string {
  return JSON.stringify(items);
}

function isWatchlistItem(value: unknown): value is WatchlistItem {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const item = value as Partial<WatchlistItem>;
  const movie = item.movie as WatchlistItem['movie'] | undefined;

  return typeof item.id === 'string'
    && typeof item.addedAt === 'string'
    && typeof movie?.id === 'number'
    && typeof movie.tmdbId === 'number'
    && typeof movie.title === 'string';
}

export function readE2EWatchlistItems(reader: CookieValueReader): WatchlistItem[] {
  if (!isE2ETestModeEnabled()) {
    return [];
  }

  const rawValue = reader.get(E2E_WATCHLIST_COOKIE)?.value;

  if (!rawValue) {
    return [];
  }

  try {
    const parsedValue = JSON.parse(rawValue) as unknown;

    return Array.isArray(parsedValue)
      ? parsedValue.filter(isWatchlistItem)
      : [];
  } catch {
    return [];
  }
}

export function readE2ECalendarToken(reader: CookieValueReader): string {
  if (!isE2ETestModeEnabled()) {
    return E2E_DEFAULT_CALENDAR_TOKEN;
  }

  return reader.get(E2E_CALENDAR_TOKEN_COOKIE)?.value ?? E2E_DEFAULT_CALENDAR_TOKEN;
}

export function createSeededE2ECalendarToken(seed: string): string {
  return `${E2E_CALENDAR_TOKEN_PREFIX}-${seed}-initial`;
}

export function createNextE2ECalendarToken(currentToken: string): string {
  return currentToken.endsWith('-initial')
    ? `${currentToken.slice(0, -'-initial'.length)}-rotated`
    : currentToken;
}

export function setE2EAuthCookie(response: CookieWriter): void {
  response.cookies.set(
    E2E_AUTH_COOKIE,
    E2E_AUTHENTICATED_VALUE,
    createAccessTokenCookieOptions(E2E_COOKIE_MAX_AGE_SECONDS),
  );
}

export function setE2EWatchlistCookie(
  response: CookieWriter,
  items: WatchlistItem[],
): void {
  response.cookies.set(
    E2E_WATCHLIST_COOKIE,
    serializeE2EWatchlistItems(items),
    createAccessTokenCookieOptions(E2E_COOKIE_MAX_AGE_SECONDS),
  );
}

export function setE2ECalendarTokenCookie(
  response: CookieWriter,
  token: string,
): void {
  response.cookies.set(
    E2E_CALENDAR_TOKEN_COOKIE,
    token,
    createAccessTokenCookieOptions(E2E_COOKIE_MAX_AGE_SECONDS),
  );
}

export function clearE2EStateCookies(response: CookieWriter): void {
  response.cookies.set(E2E_AUTH_COOKIE, '', createExpiredCookieOptions());
  response.cookies.set(E2E_WATCHLIST_COOKIE, '', createExpiredCookieOptions());
  response.cookies.set(E2E_CALENDAR_TOKEN_COOKIE, '', createExpiredCookieOptions());
}
