import { describe, expect, it, vi } from 'vitest';
import type { PostgrestError } from '@supabase/supabase-js';

import type { ServerSupabaseClient } from '../src/lib/supabase/server';
import { createMembershipsAggregate } from '../src/lib/supabase/watchlist/memberships';
import { WatchlistDataError } from '../src/lib/watchlist';

const SUPABASE_ERROR: PostgrestError = {
  code: 'P0001',
  message: 'DB error',
  details: '',
  hint: '',
  name: 'PostgrestError',
};

const VALID_MEMBERSHIP_ROW = {
  accepted_at: '2026-06-20T00:00:00.000Z',
  id: 'membership-1',
  invited_by_user_id: 'user-1',
  role: 'editor',
  user_id: 'user-2',
  watchlist_id: 'watchlist-1',
};

/**
 * Build a minimal mock Supabase query-builder chain that resolves the final
 * await to `result`.  All chaining methods return `this` so callers can use
 * `.from().select().eq().maybeSingle()` etc.  The chain is also directly
 * thenable for callers that await the builder without `.single()`.
 */
function makeChain(result: { data: unknown; error: PostgrestError | null }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: Record<string, any> = {
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    not: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
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
  } as unknown as ServerSupabaseClient;
}

describe('createMembershipsAggregate — findMembershipForUser', () => {
  it('returns a mapped WatchlistMember when a row is found', async () => {
    const adminClient = mockClient({ data: VALID_MEMBERSHIP_ROW, error: null });
    const { findMembershipForUser } = createMembershipsAggregate({
      adminClient,
      userClient: adminClient,
    });

    const result = await findMembershipForUser('watchlist-1', 'user-2');

    expect(result).toEqual({
      acceptedAt: '2026-06-20T00:00:00.000Z',
      id: 'membership-1',
      invitedByUserId: 'user-1',
      role: 'editor',
      userId: 'user-2',
      watchlistId: 'watchlist-1',
    });
    expect(adminClient.from).toHaveBeenCalledWith('watchlist_memberships');
  });

  it('returns null when no row is found', async () => {
    const adminClient = mockClient({ data: null, error: null });
    const { findMembershipForUser } = createMembershipsAggregate({
      adminClient,
      userClient: adminClient,
    });

    await expect(findMembershipForUser('watchlist-1', 'user-2')).resolves.toBeNull();
  });

  it('throws WatchlistDataError on a PostgrestError', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const adminClient = mockClient({ data: null, error: SUPABASE_ERROR });
    const { findMembershipForUser } = createMembershipsAggregate({
      adminClient,
      userClient: adminClient,
    });

    await expect(findMembershipForUser('watchlist-1', 'user-2')).rejects.toThrow(
      WatchlistDataError,
    );
    consoleSpy.mockRestore();
  });
});

describe('createMembershipsAggregate — listMembersForWatchlist', () => {
  it('returns mapped WatchlistMember array', async () => {
    const adminClient = mockClient({ data: [VALID_MEMBERSHIP_ROW], error: null });
    const { listMembersForWatchlist } = createMembershipsAggregate({
      adminClient,
      userClient: adminClient,
    });

    const result = await listMembersForWatchlist('watchlist-1');

    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('editor');
    expect(adminClient.from).toHaveBeenCalledWith('watchlist_memberships');
  });

  it('throws WatchlistDataError on a PostgrestError', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const adminClient = mockClient({ data: null, error: SUPABASE_ERROR });
    const { listMembersForWatchlist } = createMembershipsAggregate({
      adminClient,
      userClient: adminClient,
    });

    await expect(listMembersForWatchlist('watchlist-1')).rejects.toThrow(WatchlistDataError);
    consoleSpy.mockRestore();
  });
});

describe('createMembershipsAggregate — removeMembershipFromWatchlist', () => {
  it('returns true when a row was deleted', async () => {
    const adminClient = mockClient({ data: { id: 'membership-1' }, error: null });
    const { removeMembershipFromWatchlist } = createMembershipsAggregate({
      adminClient,
      userClient: adminClient,
    });

    await expect(
      removeMembershipFromWatchlist('watchlist-1', 'membership-1'),
    ).resolves.toBe(true);
    expect(adminClient.from).toHaveBeenCalledWith('watchlist_memberships');
  });

  it('returns false when no row matched', async () => {
    const adminClient = mockClient({ data: null, error: null });
    const { removeMembershipFromWatchlist } = createMembershipsAggregate({
      adminClient,
      userClient: adminClient,
    });

    await expect(
      removeMembershipFromWatchlist('watchlist-1', 'membership-1'),
    ).resolves.toBe(false);
  });

  it('throws WatchlistDataError on a PostgrestError', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const adminClient = mockClient({ data: null, error: SUPABASE_ERROR });
    const { removeMembershipFromWatchlist } = createMembershipsAggregate({
      adminClient,
      userClient: adminClient,
    });

    await expect(
      removeMembershipFromWatchlist('watchlist-1', 'membership-1'),
    ).rejects.toThrow(WatchlistDataError);
    consoleSpy.mockRestore();
  });
});

describe('createMembershipsAggregate — acceptInviteMembership (no existing)', () => {
  it('inserts a new membership when none exists and returns the mapped member', async () => {
    // First call: maybeSingle → no existing row
    // Second call: single → inserted row
    const fromMock = vi.fn();
    fromMock
      .mockReturnValueOnce(makeChain({ data: null, error: null }))  // lookup
      .mockReturnValueOnce(makeChain({ data: VALID_MEMBERSHIP_ROW, error: null })); // insert

    const adminClient = { from: fromMock } as unknown as ServerSupabaseClient;
    const { acceptInviteMembership } = createMembershipsAggregate({
      adminClient,
      userClient: adminClient,
    });

    const result = await acceptInviteMembership({
      acceptedAt: '2026-06-20T00:00:00.000Z',
      invitedByUserId: 'user-1',
      userId: 'user-2',
      watchlistId: 'watchlist-1',
    });

    expect(result.id).toBe('membership-1');
    expect(result.role).toBe('editor');
  });

  it('throws WatchlistDataError when the initial lookup fails', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const adminClient = mockClient({ data: null, error: SUPABASE_ERROR });
    const { acceptInviteMembership } = createMembershipsAggregate({
      adminClient,
      userClient: adminClient,
    });

    await expect(
      acceptInviteMembership({
        acceptedAt: '2026-06-20T00:00:00.000Z',
        invitedByUserId: null,
        userId: 'user-2',
        watchlistId: 'watchlist-1',
      }),
    ).rejects.toThrow(WatchlistDataError);
    consoleSpy.mockRestore();
  });
});

describe('createMembershipsAggregate — acceptInviteMembership (already accepted)', () => {
  it('returns the existing member when already accepted', async () => {
    const adminClient = mockClient({ data: VALID_MEMBERSHIP_ROW, error: null });
    const { acceptInviteMembership } = createMembershipsAggregate({
      adminClient,
      userClient: adminClient,
    });

    const result = await acceptInviteMembership({
      acceptedAt: '2026-06-20T00:00:00.000Z',
      invitedByUserId: 'user-1',
      userId: 'user-2',
      watchlistId: 'watchlist-1',
    });

    // Already accepted — just return the existing mapped member
    expect(result.id).toBe('membership-1');
  });
});

describe('createMembershipsAggregate — acceptInviteMembership (update path)', () => {
  it('updates and returns the membership when an existing row has accepted_at: null', async () => {
    const PENDING_MEMBERSHIP_ROW = {
      accepted_at: null,
      id: 'membership-1',
      invited_by_user_id: null,
      role: 'editor',
      user_id: 'user-2',
      watchlist_id: 'watchlist-1',
    };

    const UPDATED_MEMBERSHIP_ROW = {
      ...PENDING_MEMBERSHIP_ROW,
      accepted_at: '2026-06-20T00:00:00.000Z',
      invited_by_user_id: 'user-1',
    };

    const fromMock = vi.fn();
    fromMock
      .mockReturnValueOnce(makeChain({ data: PENDING_MEMBERSHIP_ROW, error: null })) // lookup
      .mockReturnValueOnce(makeChain({ data: UPDATED_MEMBERSHIP_ROW, error: null })); // update

    const adminClient = { from: fromMock } as unknown as ServerSupabaseClient;
    const { acceptInviteMembership } = createMembershipsAggregate({
      adminClient,
      userClient: adminClient,
    });

    const result = await acceptInviteMembership({
      acceptedAt: '2026-06-20T00:00:00.000Z',
      invitedByUserId: 'user-1',
      userId: 'user-2',
      watchlistId: 'watchlist-1',
    });

    expect(result.id).toBe('membership-1');
    expect(result.acceptedAt).toBe('2026-06-20T00:00:00.000Z');
    expect(result.invitedByUserId).toBe('user-1');
    // from() should have been called twice: once for the lookup, once for the update
    expect(fromMock).toHaveBeenCalledTimes(2);
    expect(fromMock).toHaveBeenNthCalledWith(1, 'watchlist_memberships');
    expect(fromMock).toHaveBeenNthCalledWith(2, 'watchlist_memberships');
  });
});

describe('createMembershipsAggregate — findMembershipByIdForWatchlist', () => {
  it('scopes the lookup to the watchlist and maps the row', async () => {
    const fromMock = vi.fn(() => makeChain({ data: VALID_MEMBERSHIP_ROW, error: null }));
    const adminClient = { from: fromMock } as unknown as ServerSupabaseClient;
    const { findMembershipByIdForWatchlist } = createMembershipsAggregate({
      adminClient,
      userClient: adminClient,
    });

    const result = await findMembershipByIdForWatchlist('watchlist-1', 'membership-1');

    expect(result?.id).toBe('membership-1');
    expect(fromMock).toHaveBeenCalledWith('watchlist_memberships');

    const chain = fromMock.mock.results[0].value;

    expect(chain.eq).toHaveBeenNthCalledWith(1, 'watchlist_id', 'watchlist-1');
    expect(chain.eq).toHaveBeenNthCalledWith(2, 'id', 'membership-1');
  });

  it('returns null when no row matches', async () => {
    const adminClient = mockClient({ data: null, error: null });
    const { findMembershipByIdForWatchlist } = createMembershipsAggregate({
      adminClient,
      userClient: adminClient,
    });

    await expect(
      findMembershipByIdForWatchlist('watchlist-1', 'membership-1'),
    ).resolves.toBeNull();
  });

  it('treats a non-uuid membership id as a miss rather than a data error', async () => {
    const adminClient = mockClient({
      data: null,
      error: {
        ...SUPABASE_ERROR,
        code: '22P02',
        message: 'invalid input syntax for type uuid',
      },
    });
    const { findMembershipByIdForWatchlist } = createMembershipsAggregate({
      adminClient,
      userClient: adminClient,
    });

    await expect(
      findMembershipByIdForWatchlist('watchlist-1', 'owner:user-1'),
    ).resolves.toBeNull();
  });

  it('still surfaces any other Supabase error', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const adminClient = mockClient({ data: null, error: SUPABASE_ERROR });
    const { findMembershipByIdForWatchlist } = createMembershipsAggregate({
      adminClient,
      userClient: adminClient,
    });

    await expect(
      findMembershipByIdForWatchlist('watchlist-1', 'membership-1'),
    ).rejects.toThrow(WatchlistDataError);
    consoleSpy.mockRestore();
  });
});

describe('createMembershipsAggregate — listMemberEmailsByUserId', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function adminClientWithUsers(getUserById: any): ServerSupabaseClient {
    return {
      auth: { admin: { getUserById } },
      from: vi.fn(() => makeChain({ data: null, error: null })),
    } as unknown as ServerSupabaseClient;
  }

  it('resolves each unique user id exactly once', async () => {
    const getUserById = vi.fn(async (userId: string) => ({
      data: { user: { email: `${userId}@moviecal.test` } },
      error: null,
    }));
    const adminClient = adminClientWithUsers(getUserById);
    const { listMemberEmailsByUserId } = createMembershipsAggregate({
      adminClient,
      userClient: adminClient,
    });

    const emails = await listMemberEmailsByUserId(['user-1', 'user-2', 'user-1']);

    expect(emails).toEqual({
      'user-1': 'user-1@moviecal.test',
      'user-2': 'user-2@moviecal.test',
    });
    expect(getUserById).toHaveBeenCalledTimes(2);
  });

  it('maps an unreadable account to null instead of failing the whole listing', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const getUserById = vi.fn(async (userId: string) =>
      userId === 'user-2'
        ? { data: { user: null }, error: { message: 'User not found' } }
        : { data: { user: { email: `${userId}@moviecal.test` } }, error: null },
    );
    const adminClient = adminClientWithUsers(getUserById);
    const { listMemberEmailsByUserId } = createMembershipsAggregate({
      adminClient,
      userClient: adminClient,
    });

    await expect(listMemberEmailsByUserId(['user-1', 'user-2'])).resolves.toEqual({
      'user-1': 'user-1@moviecal.test',
      'user-2': null,
    });
    consoleSpy.mockRestore();
  });

  it('reads no account at all for an empty member list', async () => {
    const getUserById = vi.fn();
    const adminClient = adminClientWithUsers(getUserById);
    const { listMemberEmailsByUserId } = createMembershipsAggregate({
      adminClient,
      userClient: adminClient,
    });

    await expect(listMemberEmailsByUserId([])).resolves.toEqual({});
    expect(getUserById).not.toHaveBeenCalled();
  });
});
