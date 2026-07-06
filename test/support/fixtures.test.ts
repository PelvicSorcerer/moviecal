import { describe, expect, it } from 'vitest';

import { mapWatchlistRow } from '../../src/lib/watchlist';
import {
  buildNormalizedMovieSummaries,
  buildTmdbSearchResponse,
  buildWatchlistItem,
  buildWatchlistRow,
  buildWatchlistSummary,
  createWatchlistRepository,
  TEST_TMDB_IDS,
  TEST_USER_IDS,
} from './index';

describe('shared test-data foundation', () => {
  it('builds consistent watchlist rows and items from the movie catalog', () => {
    const row = buildWatchlistRow(TEST_TMDB_IDS.MATRIX);
    const item = buildWatchlistItem(TEST_TMDB_IDS.MATRIX);

    expect(mapWatchlistRow(row)).toEqual(item);
  });

  it('builds deterministic TMDb search payloads for route stubs', () => {
    expect(buildTmdbSearchResponse([TEST_TMDB_IDS.MATRIX, TEST_TMDB_IDS.INCEPTION])).toEqual({
      results: buildNormalizedMovieSummaries([
        TEST_TMDB_IDS.MATRIX,
        TEST_TMDB_IDS.INCEPTION,
      ]),
    });
  });

  it('provides a reusable watchlist repository mock for domain tests', async () => {
    const repository = createWatchlistRepository();
    const watchlists = await repository.listWatchlistsForUser(TEST_USER_IDS.OWNER);

    expect(watchlists).toEqual([
      buildWatchlistSummary({
        id: 'personal-watchlist-1',
        kind: 'personal',
      }),
      buildWatchlistSummary({
        id: 'shared-watchlist-1',
        kind: 'shared',
        name: 'Friday movie night',
      }),
    ]);
  });
});
