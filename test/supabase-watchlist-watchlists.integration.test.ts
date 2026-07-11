import { describe, expect, it, vi } from 'vitest';
import type { PostgrestError } from '@supabase/supabase-js';

import type { ServerSupabaseClient } from '../src/lib/supabase/server';
import { createWatchlistsAggregate } from '../src/lib/supabase/watchlist/watchlists';
import { WatchlistDataError } from '../src/lib/watchlist';

const SUPABASE_ERROR: PostgrestError = {
  code: 'P0001',
  message: 'DB error',
  details: '',
  hint: '',
  name: 'PostgrestError',
};

const VALID_WATCHLIST_ROW = {
  id: 'watchlist-1',
  owner_user_id: 'user-1',
  kind: 'personal',
  name: 'My watchlist',
};

const VALID_MEMBERSHIP_ROW = {
  accepted_at: '2026-06-20T00:00:00.000Z',
  id: 'membership-1',
  invited_by_user_id: 'user-3',
  role: 'editor',
  user_id: 'user-2',
  watchlist_id: 'watchlist-1',
};

function makeChain(result: { data: unknown; error: PostgrestError | null }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: Record<string, any> = {
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    not: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
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
    rpc: vi.fn().mockResolvedValue(result),
  } as unknown as ServerSupabaseClient;
}

describe('createWatchlistsAggregate — createWatchlist', () => {
  it('returns the created WatchlistSummary', async () => {
    const userClient = mockClient({ data: VALID_WATCHLIST_ROW, error: null });
    const { createWatchlist } = createWatchlistsAggregate({
      adminClient: userClient,
      userClient,
    });

    const result = await createWatchlist({
      kind: 'personal',
      name: 'My watchlist',
      ownerUserId: 'user-1',
    });

    expect(result).toEqual({
      canEdit: true,
      id: 'watchlist-1',
      kind: 'personal',
      name: 'My watchlist',
      ownerUserId: 'user-1',
    });
    expect(userClient.from).toHaveBeenCalledWith('watchlists');
  });

  it('throws WatchlistDataError on a PostgrestError', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const userClient = mockClient({ data: null, error: SUPABASE_ERROR });
    const { createWatchlist } = createWatchlistsAggregate({
      adminClient: userClient,
      userClient,
    });

    await expect(
      createWatchlist({ kind: 'personal', name: 'My watchlist', ownerUserId: 'user-1' }),
    ).rejects.toThrow(WatchlistDataError);
    consoleSpy.mockRestore();
  });
});

describe('createWatchlistsAggregate — ensurePersonalWatchlist', () => {
  it('returns the WatchlistSummary from the admin-client select after the RPC call', async () => {
    const fromMock = vi.fn(() => makeChain({ data: VALID_WATCHLIST_ROW, error: null }));
    const rpcMock = vi.fn().mockResolvedValue({ data: 'watchlist-1', error: null });

    const client = {
      from: fromMock,
      rpc: rpcMock,
    } as unknown as ServerSupabaseClient;

    const { ensurePersonalWatchlist } = createWatchlistsAggregate({
      adminClient: client,
      userClient: client,
    });

    const result = await ensurePersonalWatchlist('user-1');

    expect(rpcMock).toHaveBeenCalledWith('ensure_personal_watchlist_for_user', {
      target_user_id: 'user-1',
    });
    expect(result.id).toBe('watchlist-1');
  });

  it('throws WatchlistDataError when the RPC call returns an error', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = {
      from: vi.fn(() => makeChain({ data: null, error: null })),
      rpc: vi.fn().mockResolvedValue({ data: null, error: SUPABASE_ERROR }),
    } as unknown as ServerSupabaseClient;

    const { ensurePersonalWatchlist } = createWatchlistsAggregate({
      adminClient: client,
      userClient: client,
    });

    await expect(ensurePersonalWatchlist('user-1')).rejects.toThrow(WatchlistDataError);
    consoleSpy.mockRestore();
  });
});

describe('createWatchlistsAggregate — getWatchlistAccess', () => {
  it('returns not_found when the watchlist does not exist', async () => {
    const adminClient = mockClient({ data: null, error: null });
    const { getWatchlistAccess } = createWatchlistsAggregate({
      adminClient,
      userClient: adminClient,
    });

    const result = await getWatchlistAccess('user-1', 'watchlist-1');

    expect(result).toEqual({ status: 'not_found' });
  });

  it('returns authorized with canEdit true for the owner', async () => {
    const adminClient = mockClient({ data: VALID_WATCHLIST_ROW, error: null });
    const { getWatchlistAccess } = createWatchlistsAggregate({
      adminClient,
      userClient: adminClient,
    });

    const result = await getWatchlistAccess('user-1', 'watchlist-1');

    expect(result).toMatchObject({ status: 'authorized', canEdit: true });
  });

  it('returns forbidden when user has no membership', async () => {
    // First from call: returns the watchlist; second: returns null membership
    const fromMock = vi.fn();
    fromMock
      .mockReturnValueOnce(makeChain({ data: VALID_WATCHLIST_ROW, error: null }))
      .mockReturnValueOnce(makeChain({ data: null, error: null }));

    const adminClient = { from: fromMock } as unknown as ServerSupabaseClient;
    const { getWatchlistAccess } = createWatchlistsAggregate({
      adminClient,
      userClient: adminClient,
    });

    const result = await getWatchlistAccess('non-owner', 'watchlist-1');

    expect(result).toEqual({ status: 'forbidden' });
  });

  it('returns authorized for an accepted-membership user with editor role', async () => {
    const fromMock = vi.fn();
    fromMock
      .mockReturnValueOnce(makeChain({ data: VALID_WATCHLIST_ROW, error: null }))
      .mockReturnValueOnce(makeChain({ data: VALID_MEMBERSHIP_ROW, error: null }));

    const adminClient = { from: fromMock } as unknown as ServerSupabaseClient;
    const { getWatchlistAccess } = createWatchlistsAggregate({
      adminClient,
      userClient: adminClient,
    });

    const result = await getWatchlistAccess('user-2', 'watchlist-1');

    expect(result).toMatchObject({ status: 'authorized', canEdit: true });
  });

  it('throws WatchlistDataError when the watchlist query fails', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const adminClient = mockClient({ data: null, error: SUPABASE_ERROR });
    const { getWatchlistAccess } = createWatchlistsAggregate({
      adminClient,
      userClient: adminClient,
    });

    await expect(getWatchlistAccess('user-1', 'watchlist-1')).rejects.toThrow(
      WatchlistDataError,
    );
    consoleSpy.mockRestore();
  });
});

describe('createWatchlistsAggregate — listWatchlistsForUser', () => {
  it('returns owned watchlists with canEdit true', async () => {
    // Owned watchlists query, then membership query (no memberships)
    const fromMock = vi.fn();
    fromMock
      .mockReturnValueOnce(makeChain({ data: [VALID_WATCHLIST_ROW], error: null }))
      .mockReturnValueOnce(makeChain({ data: [], error: null }));

    const userClient = { from: fromMock } as unknown as ServerSupabaseClient;
    const { listWatchlistsForUser } = createWatchlistsAggregate({
      adminClient: userClient,
      userClient,
    });

    const result = await listWatchlistsForUser('user-1');

    expect(result).toHaveLength(1);
    expect(result[0].canEdit).toBe(true);
  });

  it('throws WatchlistDataError when the owned-watchlist query fails', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const userClient = mockClient({ data: null, error: SUPABASE_ERROR });
    const { listWatchlistsForUser } = createWatchlistsAggregate({
      adminClient: userClient,
      userClient,
    });

    await expect(listWatchlistsForUser('user-1')).rejects.toThrow(WatchlistDataError);
    consoleSpy.mockRestore();
  });
});
