import { describe, expect, it } from 'vitest';

import {
  assertInviteLinkRow,
  mapInviteLinkRow,
} from '../src/lib/supabase/watchlist/invites';

const VALID_INVITE_LINK_ROW = {
  id: 'invite-1',
  watchlist_id: 'watchlist-1',
  created_by_user_id: 'user-1',
  token_hash: 'abc123hash',
  created_at: '2026-06-20T00:00:00.000Z',
  expires_at: '2026-07-20T00:00:00.000Z',
  revoked_at: null,
};

describe('assertInviteLinkRow', () => {
  it('accepts a valid invite link row', () => {
    expect(assertInviteLinkRow(VALID_INVITE_LINK_ROW)).toEqual(VALID_INVITE_LINK_ROW);
  });

  it('accepts a row with null expires_at and null revoked_at', () => {
    const row = { ...VALID_INVITE_LINK_ROW, expires_at: null, revoked_at: null };
    expect(assertInviteLinkRow(row)).toEqual(row);
  });

  it('accepts a row with a non-null revoked_at', () => {
    const row = { ...VALID_INVITE_LINK_ROW, revoked_at: '2026-06-21T00:00:00.000Z' };
    expect(assertInviteLinkRow(row)).toEqual(row);
  });

  it('throws when data is null', () => {
    expect(() => assertInviteLinkRow(null)).toThrow(
      'Supabase returned an invalid watchlist invite link row.',
    );
  });

  it('throws when id is missing', () => {
    const { id: _, ...rest } = VALID_INVITE_LINK_ROW;
    expect(() => assertInviteLinkRow(rest)).toThrow(
      'Supabase returned an invalid watchlist invite link row.',
    );
  });

  it('throws when watchlist_id is not a string', () => {
    expect(() =>
      assertInviteLinkRow({ ...VALID_INVITE_LINK_ROW, watchlist_id: 42 }),
    ).toThrow('Supabase returned an invalid watchlist invite link row.');
  });

  it('throws when created_by_user_id is missing', () => {
    const { created_by_user_id: _, ...rest } = VALID_INVITE_LINK_ROW;
    expect(() => assertInviteLinkRow(rest)).toThrow(
      'Supabase returned an invalid watchlist invite link row.',
    );
  });

  it('throws when token_hash is not a string', () => {
    expect(() =>
      assertInviteLinkRow({ ...VALID_INVITE_LINK_ROW, token_hash: null }),
    ).toThrow('Supabase returned an invalid watchlist invite link row.');
  });

  it('throws when created_at is missing', () => {
    const { created_at: _, ...rest } = VALID_INVITE_LINK_ROW;
    expect(() => assertInviteLinkRow(rest)).toThrow(
      'Supabase returned an invalid watchlist invite link row.',
    );
  });
});

describe('mapInviteLinkRow', () => {
  it('maps snake_case fields to camelCase WatchlistInviteLink', () => {
    expect(mapInviteLinkRow(VALID_INVITE_LINK_ROW)).toEqual({
      createdAt: '2026-06-20T00:00:00.000Z',
      createdByUserId: 'user-1',
      expiresAt: '2026-07-20T00:00:00.000Z',
      id: 'invite-1',
      revokedAt: null,
      watchlistId: 'watchlist-1',
    });
  });

  it('maps null expires_at and null revoked_at', () => {
    const result = mapInviteLinkRow({
      ...VALID_INVITE_LINK_ROW,
      expires_at: null,
      revoked_at: null,
    });
    expect(result.expiresAt).toBeNull();
    expect(result.revokedAt).toBeNull();
  });
});
