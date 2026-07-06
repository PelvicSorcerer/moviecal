import type { NormalizedMovieDetail } from '../tmdb/client';

/**
 * Canonical deterministic values for automated tests.
 * Import from here (or test/support factories) instead of inventing ad hoc IDs,
 * timestamps, or movie payloads in individual test files.
 */
export const TEST_TIMESTAMPS = {
  FIXED_NOW: '2026-06-20T14:05:06.789Z',
  USER_CREATED: '2026-06-18T00:00:00.000Z',
  ITEM_ADDED_AT: '2026-06-13T05:00:00.000Z',
  MATRIX_ADDED_AT: '2026-06-18T12:00:00.000Z',
  INCEPTION_ADDED_AT: '2026-06-18T12:05:00.000Z',
  MEMBERSHIP_ACCEPTED: '2026-06-20T00:00:00.000Z',
  INVITE_CREATED: '2026-06-20T00:00:00.000Z',
  MOVIE_UPDATED: '2026-06-13T05:00:00.000Z',
  TOKEN_CREATED: '2026-06-19T00:00:00.000Z',
} as const;

export const TEST_USER_IDS = {
  OWNER: 'user-1',
  COLLABORATOR: 'user-2',
  E2E_OWNER: 'e2e-user',
  E2E_COLLABORATOR: 'e2e-collaborator-user',
} as const;

export const TEST_WATCHLIST_IDS = {
  PERSONAL: 'personal-watchlist-1',
  SHARED: 'shared-watchlist-1',
  DOMAIN_PERSONAL: 'watchlist-1',
  E2E_PERSONAL: 'e2e-personal-watchlist',
} as const;

export const TEST_ITEM_IDS = {
  MATRIX: 'watchlist-item-1',
  INCEPTION: 'watchlist-item-2',
} as const;

export const TEST_MOVIE_DB_IDS = {
  MATRIX: 42,
} as const;

export const TEST_TMDB_IDS = {
  MATRIX: 603,
  INCEPTION: 27205,
} as const;

export const TEST_CALENDAR_TOKENS = {
  DEFAULT: 'test-calendar-token-default',
  SEED: 'test-calendar-token-seed',
} as const;

export interface TestMovieCatalogEntry {
  addedAt: string;
  dbId: number;
  detail: NormalizedMovieDetail;
  itemId: string;
}

const MATRIX_DETAIL: NormalizedMovieDetail = {
  tmdbId: TEST_TMDB_IDS.MATRIX,
  title: 'The Matrix',
  releaseDate: '1999-03-31',
  posterPath: '/matrix.jpg',
  overview: 'A hacker discovers the truth.',
  rawJson: {
    id: TEST_TMDB_IDS.MATRIX,
    title: 'The Matrix',
    release_date: '1999-03-31',
    poster_path: '/matrix.jpg',
    overview: 'A hacker discovers the truth.',
  },
};

const INCEPTION_DETAIL: NormalizedMovieDetail = {
  tmdbId: TEST_TMDB_IDS.INCEPTION,
  title: 'Inception',
  releaseDate: '2010-07-16',
  posterPath: '/inception.jpg',
  overview: 'A thief steals secrets through shared dreams.',
  rawJson: {
    id: TEST_TMDB_IDS.INCEPTION,
    title: 'Inception',
    release_date: '2010-07-16',
    poster_path: '/inception.jpg',
    overview: 'A thief steals secrets through shared dreams.',
  },
};

export const TEST_MOVIE_CATALOG: Record<number, TestMovieCatalogEntry> = {
  [TEST_TMDB_IDS.MATRIX]: {
    addedAt: TEST_TIMESTAMPS.ITEM_ADDED_AT,
    dbId: TEST_MOVIE_DB_IDS.MATRIX,
    detail: MATRIX_DETAIL,
    itemId: TEST_ITEM_IDS.MATRIX,
  },
  [TEST_TMDB_IDS.INCEPTION]: {
    addedAt: TEST_TIMESTAMPS.ITEM_ADDED_AT,
    dbId: TEST_MOVIE_DB_IDS.MATRIX + 1,
    detail: INCEPTION_DETAIL,
    itemId: TEST_ITEM_IDS.INCEPTION,
  },
};

export function getTestMovieCatalogEntry(
  tmdbId: number,
): TestMovieCatalogEntry | null {
  return TEST_MOVIE_CATALOG[tmdbId] ?? null;
}

export function listTestMovieTmdbIds(): number[] {
  return Object.keys(TEST_MOVIE_CATALOG).map(Number);
}
