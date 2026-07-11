import { describe, expect, it } from 'vitest';

import { assertWatchlistSummary } from '../src/lib/supabase/watchlist/watchlists';

const VALID_WATCHLIST_ROW = {
  id: 'watchlist-1',
  owner_user_id: 'user-1',
  kind: 'personal' as const,
  name: 'My watchlist',
};

describe('assertWatchlistSummary', () => {
  it('accepts a valid watchlist row and returns a WatchlistSummary', () => {
    expect(assertWatchlistSummary(VALID_WATCHLIST_ROW)).toEqual({
      canEdit: true,
      id: 'watchlist-1',
      kind: 'personal',
      name: 'My watchlist',
      ownerUserId: 'user-1',
    });
  });

  it('accepts a shared kind', () => {
    const result = assertWatchlistSummary({ ...VALID_WATCHLIST_ROW, kind: 'shared' });
    expect(result.kind).toBe('shared');
  });

  it('preserves a boolean canEdit field when present', () => {
    const result = assertWatchlistSummary({ ...VALID_WATCHLIST_ROW, canEdit: false });
    expect(result.canEdit).toBe(false);
  });

  it('defaults canEdit to true when not present', () => {
    const result = assertWatchlistSummary(VALID_WATCHLIST_ROW);
    expect(result.canEdit).toBe(true);
  });

  it('throws when data is null', () => {
    expect(() => assertWatchlistSummary(null)).toThrow(
      'Supabase returned an invalid watchlist row.',
    );
  });

  it('throws when id is missing', () => {
    const { id: _, ...rest } = VALID_WATCHLIST_ROW;
    expect(() => assertWatchlistSummary(rest)).toThrow(
      'Supabase returned an invalid watchlist row.',
    );
  });

  it('throws when kind is invalid', () => {
    expect(() =>
      assertWatchlistSummary({ ...VALID_WATCHLIST_ROW, kind: 'unknown' }),
    ).toThrow('Supabase returned an invalid watchlist row.');
  });

  it('throws when name is not a string', () => {
    expect(() =>
      assertWatchlistSummary({ ...VALID_WATCHLIST_ROW, name: 42 }),
    ).toThrow('Supabase returned an invalid watchlist row.');
  });

  it('throws when owner_user_id is missing', () => {
    const { owner_user_id: _, ...rest } = VALID_WATCHLIST_ROW;
    expect(() => assertWatchlistSummary(rest)).toThrow(
      'Supabase returned an invalid watchlist row.',
    );
  });
});
