import { describe, expect, it } from 'vitest';

import {
  assertTrackedMovieRows,
  assertWatchlistMovieRow,
  assertWatchlistRow,
  assertWatchlistRows,
} from '../src/lib/supabase/watchlist/items';

const VALID_MOVIE_ROW = {
  id: 42,
  tmdb_id: 603,
  title: 'The Matrix',
  release_date: '1999-03-31',
  raw_json: { id: 603 },
  updated_at: '2026-06-13T05:00:00.000Z',
};

const VALID_WATCHLIST_ROW = {
  id: 'item-1',
  added_at: '2026-06-13T05:00:00.000Z',
  movie: VALID_MOVIE_ROW,
};

describe('assertWatchlistMovieRow', () => {
  it('accepts a valid movie row', () => {
    expect(assertWatchlistMovieRow(VALID_MOVIE_ROW)).toEqual(VALID_MOVIE_ROW);
  });

  it('accepts a null release_date', () => {
    const row = { ...VALID_MOVIE_ROW, release_date: null };
    expect(assertWatchlistMovieRow(row)).toEqual(row);
  });

  it('throws when data is null', () => {
    expect(() => assertWatchlistMovieRow(null)).toThrow(
      'Supabase returned an invalid movie row.',
    );
  });

  it('throws when id is not a number', () => {
    expect(() =>
      assertWatchlistMovieRow({ ...VALID_MOVIE_ROW, id: 'not-a-number' }),
    ).toThrow('Supabase returned an invalid movie row.');
  });

  it('throws when tmdb_id is not a number', () => {
    expect(() =>
      assertWatchlistMovieRow({ ...VALID_MOVIE_ROW, tmdb_id: null }),
    ).toThrow('Supabase returned an invalid movie row.');
  });

  it('throws when title is not a string', () => {
    expect(() =>
      assertWatchlistMovieRow({ ...VALID_MOVIE_ROW, title: 123 }),
    ).toThrow('Supabase returned an invalid movie row.');
  });

  it('throws when updated_at is missing', () => {
    const { updated_at: _, ...rest } = VALID_MOVIE_ROW;
    expect(() => assertWatchlistMovieRow(rest)).toThrow(
      'Supabase returned an invalid movie row.',
    );
  });
});

describe('assertWatchlistRow', () => {
  it('accepts a valid watchlist row with a movie', () => {
    const result = assertWatchlistRow(VALID_WATCHLIST_ROW);
    expect(result.id).toBe('item-1');
    expect(result.added_at).toBe('2026-06-13T05:00:00.000Z');
    expect(result.movie).toEqual(VALID_MOVIE_ROW);
  });

  it('accepts a watchlist row with null movie', () => {
    const row = { ...VALID_WATCHLIST_ROW, movie: null };
    const result = assertWatchlistRow(row);
    expect(result.movie).toBeNull();
  });

  it('throws when data is null', () => {
    expect(() => assertWatchlistRow(null)).toThrow(
      'Supabase returned an invalid watchlist row.',
    );
  });

  it('throws when id is not a string', () => {
    expect(() =>
      assertWatchlistRow({ ...VALID_WATCHLIST_ROW, id: 42 }),
    ).toThrow('Supabase returned an invalid watchlist row.');
  });

  it('throws when added_at is missing', () => {
    const { added_at: _, ...rest } = VALID_WATCHLIST_ROW;
    expect(() => assertWatchlistRow(rest)).toThrow(
      'Supabase returned an invalid watchlist row.',
    );
  });
});

describe('assertWatchlistRows', () => {
  it('maps an array of valid rows', () => {
    expect(assertWatchlistRows([VALID_WATCHLIST_ROW])).toHaveLength(1);
  });

  it('accepts an empty array', () => {
    expect(assertWatchlistRows([])).toEqual([]);
  });

  it('throws when data is not an array', () => {
    expect(() => assertWatchlistRows(null)).toThrow(
      'Supabase returned an invalid watchlist response.',
    );
  });
});

describe('assertTrackedMovieRows', () => {
  it('returns unique movies keyed by tmdb_id', () => {
    const rows = [
      { movie: VALID_MOVIE_ROW },
      { movie: { ...VALID_MOVIE_ROW, id: 43, tmdb_id: 27205, title: 'Inception' } },
      // duplicate — should be deduplicated
      { movie: VALID_MOVIE_ROW },
    ];
    const result = assertTrackedMovieRows(rows);
    expect(result).toHaveLength(2);
  });

  it('skips rows with null movie', () => {
    const result = assertTrackedMovieRows([{ movie: null }, { movie: VALID_MOVIE_ROW }]);
    expect(result).toHaveLength(1);
  });

  it('throws when data is not an array', () => {
    expect(() => assertTrackedMovieRows('invalid')).toThrow(
      'Supabase returned an invalid tracked movies response.',
    );
  });

  it('throws when a row is not an object', () => {
    expect(() => assertTrackedMovieRows([42])).toThrow(
      'Supabase returned an invalid tracked movie row.',
    );
  });
});
