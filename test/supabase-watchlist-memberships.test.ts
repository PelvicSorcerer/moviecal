import { describe, expect, it } from 'vitest';

import {
  assertMembershipLookupRows,
  assertMembershipRow,
  mapMembershipRow,
} from '../src/lib/supabase/watchlist/memberships';

const VALID_MEMBERSHIP_ROW = {
  accepted_at: '2026-06-20T00:00:00.000Z',
  id: 'membership-1',
  invited_by_user_id: 'user-1',
  role: 'editor',
  user_id: 'user-2',
  watchlist_id: 'watchlist-1',
};

describe('assertMembershipRow', () => {
  it('accepts a valid membership row', () => {
    expect(assertMembershipRow(VALID_MEMBERSHIP_ROW)).toEqual(VALID_MEMBERSHIP_ROW);
  });

  it('accepts a membership row with null accepted_at', () => {
    const row = { ...VALID_MEMBERSHIP_ROW, accepted_at: null };
    expect(assertMembershipRow(row)).toEqual(row);
  });

  it('accepts a membership row with null invited_by_user_id', () => {
    const row = { ...VALID_MEMBERSHIP_ROW, invited_by_user_id: null };
    expect(assertMembershipRow(row)).toEqual(row);
  });

  it('throws when data is null', () => {
    expect(() => assertMembershipRow(null)).toThrow(
      'Supabase returned an invalid watchlist membership row.',
    );
  });

  it('throws when id is missing', () => {
    const { id: _, ...rest } = VALID_MEMBERSHIP_ROW;
    expect(() => assertMembershipRow(rest)).toThrow(
      'Supabase returned an invalid watchlist membership row.',
    );
  });

  it('throws when user_id is not a string', () => {
    expect(() => assertMembershipRow({ ...VALID_MEMBERSHIP_ROW, user_id: 42 })).toThrow(
      'Supabase returned an invalid watchlist membership row.',
    );
  });

  it('throws when role is not a string', () => {
    expect(() => assertMembershipRow({ ...VALID_MEMBERSHIP_ROW, role: true })).toThrow(
      'Supabase returned an invalid watchlist membership row.',
    );
  });

  it('throws when watchlist_id is missing', () => {
    expect(() =>
      assertMembershipRow({ ...VALID_MEMBERSHIP_ROW, watchlist_id: undefined }),
    ).toThrow('Supabase returned an invalid watchlist membership row.');
  });
});

describe('mapMembershipRow', () => {
  it('maps snake_case row fields to camelCase WatchlistMember', () => {
    expect(mapMembershipRow(VALID_MEMBERSHIP_ROW)).toEqual({
      acceptedAt: '2026-06-20T00:00:00.000Z',
      id: 'membership-1',
      invitedByUserId: 'user-1',
      role: 'editor',
      userId: 'user-2',
      watchlistId: 'watchlist-1',
    });
  });

  it('maps null accepted_at and null invited_by_user_id', () => {
    const result = mapMembershipRow({
      ...VALID_MEMBERSHIP_ROW,
      accepted_at: null,
      invited_by_user_id: null,
    });
    expect(result.acceptedAt).toBeNull();
    expect(result.invitedByUserId).toBeNull();
  });
});

describe('assertMembershipLookupRows', () => {
  it('accepts an array of valid lookup rows', () => {
    const rows = [
      { role: 'editor', watchlist_id: 'watchlist-1' },
      { role: 'owner', watchlist_id: 'watchlist-2' },
    ];
    expect(assertMembershipLookupRows(rows)).toEqual(rows);
  });

  it('accepts an empty array', () => {
    expect(assertMembershipLookupRows([])).toEqual([]);
  });

  it('throws when data is not an array', () => {
    expect(() => assertMembershipLookupRows(null)).toThrow(
      'Supabase returned an invalid watchlist membership lookup.',
    );
  });

  it('throws when a row is missing the role field', () => {
    expect(() =>
      assertMembershipLookupRows([{ watchlist_id: 'watchlist-1' }]),
    ).toThrow('Supabase returned an invalid watchlist membership lookup row.');
  });

  it('throws when a row is missing the watchlist_id field', () => {
    expect(() =>
      assertMembershipLookupRows([{ role: 'editor' }]),
    ).toThrow('Supabase returned an invalid watchlist membership lookup row.');
  });
});
