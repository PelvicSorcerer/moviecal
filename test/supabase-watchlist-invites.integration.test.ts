import { describe, expect, it, vi } from 'vitest';
import type { PostgrestError } from '@supabase/supabase-js';

import type { ServerSupabaseClient } from '../src/lib/supabase/server';
import { createInvitesAggregate } from '../src/lib/supabase/watchlist/invites';
import { WatchlistDataError } from '../src/lib/watchlist';

const SUPABASE_ERROR: PostgrestError = {
  code: 'P0001',
  message: 'DB error',
  details: '',
  hint: '',
  name: 'PostgrestError',
};

const VALID_INVITE_ROW = {
  id: 'invite-1',
  watchlist_id: 'watchlist-1',
  created_by_user_id: 'user-1',
  token_hash: 'abc123hash',
  created_at: '2026-06-20T00:00:00.000Z',
  expires_at: '2026-07-20T00:00:00.000Z',
  revoked_at: null,
};

const VALID_WATCHLIST_ROW = {
  id: 'watchlist-1',
  owner_user_id: 'user-1',
  kind: 'shared',
  name: 'Shared list',
};

function makeChain(result: { data: unknown; error: PostgrestError | null }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: Record<string, any> = {
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue(result),
    maybeSingle: vi.fn().mockResolvedValue(result),
    then: (resolve: (v: typeof result) => void) => Promise.resolve(result).then(resolve),
    catch: (reject: (e: unknown) => void) => Promise.resolve(result).catch(reject),
  };
  return chain;
}

function mockClient(result: { data: unknown; error: PostgrestError | null }) {
  return {
    from: vi.fn(() => makeChain(result)),
  } as unknown as ServerSupabaseClient;
}

describe('createInvitesAggregate — createInviteLink', () => {
  it('returns a mapped WatchlistInviteLink', async () => {
    const adminClient = mockClient({ data: VALID_INVITE_ROW, error: null });
    const { createInviteLink } = createInvitesAggregate({
      adminClient,
      userClient: adminClient,
    });

    const result = await createInviteLink({
      createdByUserId: 'user-1',
      expiresAt: '2026-07-20T00:00:00.000Z',
      tokenHash: 'abc123hash',
      watchlistId: 'watchlist-1',
    });

    expect(result).toEqual({
      createdAt: '2026-06-20T00:00:00.000Z',
      createdByUserId: 'user-1',
      expiresAt: '2026-07-20T00:00:00.000Z',
      id: 'invite-1',
      revokedAt: null,
      watchlistId: 'watchlist-1',
    });
    expect(adminClient.from).toHaveBeenCalledWith('watchlist_invite_links');
  });

  it('throws WatchlistDataError on a PostgrestError', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const adminClient = mockClient({ data: null, error: SUPABASE_ERROR });
    const { createInviteLink } = createInvitesAggregate({
      adminClient,
      userClient: adminClient,
    });

    await expect(
      createInviteLink({
        createdByUserId: 'user-1',
        expiresAt: null,
        tokenHash: 'abc123hash',
        watchlistId: 'watchlist-1',
      }),
    ).rejects.toThrow(WatchlistDataError);
    consoleSpy.mockRestore();
  });
});

describe('createInvitesAggregate — getActiveInviteLinkForWatchlist', () => {
  it('returns a mapped WatchlistInviteLink when found', async () => {
    const adminClient = mockClient({ data: VALID_INVITE_ROW, error: null });
    const { getActiveInviteLinkForWatchlist } = createInvitesAggregate({
      adminClient,
      userClient: adminClient,
    });

    const result = await getActiveInviteLinkForWatchlist('watchlist-1');

    expect(result).not.toBeNull();
    expect(result!.id).toBe('invite-1');
    expect(adminClient.from).toHaveBeenCalledWith('watchlist_invite_links');
  });

  it('returns null when no active invite link found', async () => {
    const adminClient = mockClient({ data: null, error: null });
    const { getActiveInviteLinkForWatchlist } = createInvitesAggregate({
      adminClient,
      userClient: adminClient,
    });

    await expect(getActiveInviteLinkForWatchlist('watchlist-1')).resolves.toBeNull();
  });

  it('throws WatchlistDataError on a PostgrestError', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const adminClient = mockClient({ data: null, error: SUPABASE_ERROR });
    const { getActiveInviteLinkForWatchlist } = createInvitesAggregate({
      adminClient,
      userClient: adminClient,
    });

    await expect(getActiveInviteLinkForWatchlist('watchlist-1')).rejects.toThrow(
      WatchlistDataError,
    );
    consoleSpy.mockRestore();
  });
});

describe('createInvitesAggregate — revokeInviteLinksForWatchlist', () => {
  it('resolves without error on success', async () => {
    const adminClient = mockClient({ data: null, error: null });
    const { revokeInviteLinksForWatchlist } = createInvitesAggregate({
      adminClient,
      userClient: adminClient,
    });

    await expect(revokeInviteLinksForWatchlist('watchlist-1')).resolves.toBeUndefined();
    expect(adminClient.from).toHaveBeenCalledWith('watchlist_invite_links');
  });

  it('throws WatchlistDataError on a PostgrestError', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const adminClient = mockClient({ data: null, error: SUPABASE_ERROR });
    const { revokeInviteLinksForWatchlist } = createInvitesAggregate({
      adminClient,
      userClient: adminClient,
    });

    await expect(revokeInviteLinksForWatchlist('watchlist-1')).rejects.toThrow(
      WatchlistDataError,
    );
    consoleSpy.mockRestore();
  });
});

describe('createInvitesAggregate — findInviteLinkByTokenHash', () => {
  it('returns null when no invite link matches the token hash', async () => {
    const adminClient = mockClient({ data: null, error: null });
    const { findInviteLinkByTokenHash } = createInvitesAggregate({
      adminClient,
      userClient: adminClient,
    });

    await expect(findInviteLinkByTokenHash('unknown-hash')).resolves.toBeNull();
  });

  it('returns the resolved invite with invite link and watchlist', async () => {
    const fromMock = vi.fn();
    fromMock
      .mockReturnValueOnce(makeChain({ data: VALID_INVITE_ROW, error: null }))
      .mockReturnValueOnce(makeChain({ data: VALID_WATCHLIST_ROW, error: null }));

    const adminClient = { from: fromMock } as unknown as ServerSupabaseClient;
    const { findInviteLinkByTokenHash } = createInvitesAggregate({
      adminClient,
      userClient: adminClient,
    });

    const result = await findInviteLinkByTokenHash('abc123hash');

    expect(result).not.toBeNull();
    expect(result!.inviteLink.id).toBe('invite-1');
    expect(result!.watchlist.id).toBe('watchlist-1');
  });

  it('returns null when the watchlist is not found for the invite', async () => {
    const fromMock = vi.fn();
    fromMock
      .mockReturnValueOnce(makeChain({ data: VALID_INVITE_ROW, error: null }))
      .mockReturnValueOnce(makeChain({ data: null, error: null }));

    const adminClient = { from: fromMock } as unknown as ServerSupabaseClient;
    const { findInviteLinkByTokenHash } = createInvitesAggregate({
      adminClient,
      userClient: adminClient,
    });

    await expect(findInviteLinkByTokenHash('abc123hash')).resolves.toBeNull();
  });

  it('throws WatchlistDataError when the invite lookup fails', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const adminClient = mockClient({ data: null, error: SUPABASE_ERROR });
    const { findInviteLinkByTokenHash } = createInvitesAggregate({
      adminClient,
      userClient: adminClient,
    });

    await expect(findInviteLinkByTokenHash('abc123hash')).rejects.toThrow(
      WatchlistDataError,
    );
    consoleSpy.mockRestore();
  });

  it('throws WatchlistDataError when the watchlist lookup fails after finding invite', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fromMock = vi.fn();
    fromMock
      .mockReturnValueOnce(makeChain({ data: VALID_INVITE_ROW, error: null }))
      .mockReturnValueOnce(makeChain({ data: null, error: SUPABASE_ERROR }));

    const adminClient = { from: fromMock } as unknown as ServerSupabaseClient;
    const { findInviteLinkByTokenHash } = createInvitesAggregate({
      adminClient,
      userClient: adminClient,
    });

    await expect(findInviteLinkByTokenHash('abc123hash')).rejects.toThrow(WatchlistDataError);
    consoleSpy.mockRestore();
  });
});
