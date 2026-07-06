import type {
  NormalizedMovieDetail,
  NormalizedMovieSummary,
} from '../../../src/lib/tmdb/client';
import {
  getTestMovieCatalogEntry,
  TEST_MOVIE_CATALOG,
  TEST_TMDB_IDS,
} from '../../../src/lib/test-data/catalog';

export function buildNormalizedMovieDetail(
  tmdbId: number = TEST_TMDB_IDS.MATRIX,
  overrides: Partial<NormalizedMovieDetail> = {},
): NormalizedMovieDetail {
  const catalogEntry = getTestMovieCatalogEntry(tmdbId);

  if (!catalogEntry) {
    throw new Error(`Missing test movie catalog entry for tmdbId ${tmdbId}.`);
  }

  return {
    ...catalogEntry.detail,
    ...overrides,
    rawJson: {
      ...catalogEntry.detail.rawJson,
      ...(overrides.rawJson ?? {}),
    },
  };
}

export function buildNormalizedMovieSummary(
  tmdbId: number = TEST_TMDB_IDS.MATRIX,
  overrides: Partial<NormalizedMovieSummary> = {},
): NormalizedMovieSummary {
  const detail = buildNormalizedMovieDetail(tmdbId);

  return {
    overview: detail.overview,
    posterPath: detail.posterPath,
    releaseDate: detail.releaseDate,
    title: detail.title,
    tmdbId: detail.tmdbId,
    ...overrides,
  };
}

export function buildNormalizedMovieSummaries(
  tmdbIds: number[] = [TEST_TMDB_IDS.MATRIX],
): NormalizedMovieSummary[] {
  return tmdbIds.map((tmdbId) => buildNormalizedMovieSummary(tmdbId));
}

export function buildTmdbSearchResponse(
  tmdbIds: number[] = [TEST_TMDB_IDS.MATRIX],
): { results: NormalizedMovieSummary[] } {
  return {
    results: buildNormalizedMovieSummaries(tmdbIds),
  };
}

export { TEST_MOVIE_CATALOG, TEST_TMDB_IDS };
