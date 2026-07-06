import type {
  WatchlistItem,
  WatchlistMovie,
  WatchlistMovieRow,
  WatchlistRow,
  WatchlistSummary,
} from '../../../src/lib/watchlist';
import {
  getTestMovieCatalogEntry,
  TEST_TIMESTAMPS,
  TEST_TMDB_IDS,
  TEST_USER_IDS,
  TEST_WATCHLIST_IDS,
} from '../../../src/lib/test-data/catalog';
import { buildNormalizedMovieDetail } from './movies';

export function buildWatchlistMovie(
  tmdbId: number = TEST_TMDB_IDS.MATRIX,
  overrides: Partial<WatchlistMovie> = {},
): WatchlistMovie {
  const catalogEntry = getTestMovieCatalogEntry(tmdbId);

  if (!catalogEntry) {
    throw new Error(`Missing test movie catalog entry for tmdbId ${tmdbId}.`);
  }

  const detail = catalogEntry.detail;

  return {
    id: catalogEntry.dbId,
    overview: detail.overview,
    posterPath: detail.posterPath,
    releaseDate: detail.releaseDate,
    title: detail.title,
    tmdbId: detail.tmdbId,
    ...overrides,
  };
}

export function buildWatchlistItem(
  tmdbIdOrOverrides: number | Partial<WatchlistItem> = TEST_TMDB_IDS.MATRIX,
  overrides: Partial<WatchlistItem> = {},
): WatchlistItem {
  const tmdbId = typeof tmdbIdOrOverrides === 'number'
    ? tmdbIdOrOverrides
    : TEST_TMDB_IDS.MATRIX;
  const resolvedOverrides = typeof tmdbIdOrOverrides === 'number'
    ? overrides
    : tmdbIdOrOverrides;
  const catalogEntry = getTestMovieCatalogEntry(tmdbId);

  if (!catalogEntry) {
    throw new Error(`Missing test movie catalog entry for tmdbId ${tmdbId}.`);
  }

  return {
    addedAt: catalogEntry.addedAt,
    id: catalogEntry.itemId,
    movie: buildWatchlistMovie(tmdbId),
    ...resolvedOverrides,
    movie: {
      ...buildWatchlistMovie(tmdbId),
      ...(resolvedOverrides.movie ?? {}),
    },
  };
}

export function buildWatchlistSummary(
  overrides: Partial<WatchlistSummary> = {},
): WatchlistSummary {
  return {
    canEdit: true,
    id: TEST_WATCHLIST_IDS.PERSONAL,
    kind: 'personal',
    name: 'My watchlist',
    ownerUserId: TEST_USER_IDS.OWNER,
    ...overrides,
  };
}

export function buildWatchlistMovieRow(
  tmdbId: number = TEST_TMDB_IDS.MATRIX,
  overrides: Partial<WatchlistMovieRow> = {},
): WatchlistMovieRow {
  const catalogEntry = getTestMovieCatalogEntry(tmdbId);

  if (!catalogEntry) {
    throw new Error(`Missing test movie catalog entry for tmdbId ${tmdbId}.`);
  }

  const detail = buildNormalizedMovieDetail(tmdbId);

  return {
    id: catalogEntry.dbId,
    raw_json: detail.rawJson,
    release_date: detail.releaseDate,
    title: detail.title,
    tmdb_id: detail.tmdbId,
    updated_at: TEST_TIMESTAMPS.MOVIE_UPDATED,
    ...overrides,
  };
}

export function buildWatchlistRow(
  tmdbId: number = TEST_TMDB_IDS.MATRIX,
  overrides: Partial<WatchlistRow> = {},
): WatchlistRow {
  const catalogEntry = getTestMovieCatalogEntry(tmdbId);

  if (!catalogEntry) {
    throw new Error(`Missing test movie catalog entry for tmdbId ${tmdbId}.`);
  }

  return {
    added_at: catalogEntry.addedAt,
    id: catalogEntry.itemId,
    movie: buildWatchlistMovieRow(tmdbId),
    ...overrides,
    movie: overrides.movie === null
      ? null
      : {
          ...buildWatchlistMovieRow(tmdbId),
          ...(overrides.movie ?? {}),
        },
  };
}
