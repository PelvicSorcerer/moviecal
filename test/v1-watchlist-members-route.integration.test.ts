import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  TEST_USER_IDS,
  TEST_WATCHLIST_IDS,
} from '../src/lib/test-data/catalog';
import type { WatchlistMember, WatchlistRepository } from '../src/lib/watchlist';
import {
  createSharedWatchlistReadRepository,
  SHARED_WATCHLIST_NAME,
} from './support';

const mocks = vi.hoisted(() => ({
  resolveAuthTokensWithClient: vi.fn(),
  createServerSupabaseClient: vi.fn(),
  createServerSupabaseServiceRoleClient: vi.fn(),
  createSupabaseWatchlistRepository: vi.fn(),
}));

vi.mock('../src/lib/auth/identity', () => ({
  resolveAuthTokensWithClient: mocks.resolveAuthTokensWithClient,
}));

vi.mock('../src/lib/supabase/server', () => ({
  createServerSupabaseClient: mocks.createServerSupabaseClient,
  createServerSupabaseServiceRoleClient:
    mocks.createServerSupabaseServiceRoleClient,
}));

vi.mock('../src/lib/supabase/watchlist', () => ({
  createSupabaseWatchlistRepository: mocks.createSupabaseWatchlistRepository,
}));

const SHARED = TEST_WATCHLIST_IDS.SHARED;
const OWNER_ROW_ID = 'membership-owner';
const EDITOR_ROW_ID = 'membership-editor';
const PENDING_ROW_ID = 'membership-pending';
const EMAILS: Record<string, string> = {
  [TEST_USER_IDS.OWNER]: 'owner@private.test',
  [TEST_USER_IDS.COLLABORATOR]: 'editor@private.test',
  [TEST_USER_IDS.PENDING_INVITEE]: 'pending@private.test',
};

function member(
  id: string,
  userId: string,
  role: WatchlistMember['role'],
  accepted: boolean,
): WatchlistMember {
  return {
    acceptedAt: accepted ? '2026-06-01T00:00:00.000Z' : null,
    id,
    invitedByUserId: TEST_USER_IDS.OWNER,
    role,
    userId,
    watchlistId: SHARED,
  };
}

/** A shared list whose membership rows are mutable, so removal is observable. */
function createMembershipRepository() {
  let rows = [
    member(OWNER_ROW_ID, TEST_USER_IDS.OWNER, 'owner', true),
    member(EDITOR_ROW_ID, TEST_USER_IDS.COLLABORATOR, 'editor', true),
    member(PENDING_ROW_ID, TEST_USER_IDS.PENDING_INVITEE, 'editor', false),
  ];
  const base = createSharedWatchlistReadRepository();
  const removeMembershipFromWatchlist = vi.fn(
    async (watchlistId: string, membershipId: string) => {
      const before = rows.length;

      rows = rows.filter(
        (row) => !(row.watchlistId === watchlistId && row.id === membershipId),
      );

      return rows.length < before;
    },
  );
  const repository: WatchlistRepository = {
    ...base,
    async findMembershipByIdForWatchlist(watchlistId, membershipId) {
      return rows.find(
        (row) => row.watchlistId === watchlistId && row.id === membershipId,
      ) ?? null;
    },
    async findMembershipForUser(watchlistId, userId) {
      return rows.find(
        (row) => row.watchlistId === watchlistId && row.userId === userId,
      ) ?? null;
    },
    async getWatchlistAccess(actorUserId, watchlistId) {
      const isAcceptedMember = rows.some(
        (row) => row.userId === actorUserId && row.acceptedAt !== null,
      );

      if (watchlistId === SHARED && actorUserId !== TEST_USER_IDS.OWNER) {
        return isAcceptedMember
          ? base.getWatchlistAccess(TEST_USER_IDS.COLLABORATOR, watchlistId)
          : { status: 'forbidden' as const };
      }

      return base.getWatchlistAccess(actorUserId, watchlistId);
    },
    async listMemberEmailsByUserId(userIds) {
      return Object.fromEntries(userIds.map((id) => [id, EMAILS[id] ?? null]));
    },
    async listMembersForWatchlist() {
      return rows;
    },
    removeMembershipFromWatchlist,
  };

  return { removeMembershipFromWatchlist, repository, rows: () => rows };
}

let world = createMembershipRepository();

function setup(userId: string | null): void {
  mocks.resolveAuthTokensWithClient.mockResolvedValue({
    refreshedSession: null,
    shouldClearCookies: false,
    user: userId ? { id: userId } : null,
  });
  mocks.createServerSupabaseClient.mockReturnValue({ name: 'user-client' });
  mocks.createServerSupabaseServiceRoleClient.mockReturnValue({});
  mocks.createSupabaseWatchlistRepository.mockReturnValue(world.repository);
}

function bearer(method: string, path: string, token = 'valid-token'): Request {
  return new Request(`https://moviecal.test${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    method,
  });
}

async function listMembers(watchlistId = SHARED, token?: string) {
  const { GET } = await import('../src/app/api/v1/watchlists/[watchlistId]/members/route');

  return GET(bearer('GET', `/api/v1/watchlists/${watchlistId}/members`, token), {
    params: Promise.resolve({ watchlistId }),
  });
}

async function removeMember(
  membershipId: string,
  watchlistId = SHARED,
  token?: string,
) {
  const { DELETE } = await import(
    '../src/app/api/v1/watchlists/[watchlistId]/members/[membershipId]/route'
  );

  return DELETE(
    bearer('DELETE', `/api/v1/watchlists/${watchlistId}/members/${membershipId}`, token),
    { params: Promise.resolve({ membershipId, watchlistId }) },
  );
}

async function leave(watchlistId = SHARED, token?: string) {
  const { DELETE } = await import(
    '../src/app/api/v1/watchlists/[watchlistId]/membership/route'
  );

  return DELETE(bearer('DELETE', `/api/v1/watchlists/${watchlistId}/membership`, token), {
    params: Promise.resolve({ watchlistId }),
  });
}

describe('v1 shared watchlist member routes (mobile Bearer surface)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    world = createMembershipRepository();
    setup(TEST_USER_IDS.OWNER);
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns 401 without touching data for a missing or invalid bearer', async () => {
    const missing = [
      await listMembers(SHARED, ''),
      await removeMember(EDITOR_ROW_ID, SHARED, ''),
      await leave(SHARED, ''),
    ];

    setup(null);

    const invalid = [
      await listMembers(),
      await removeMember(EDITOR_ROW_ID),
      await leave(),
    ];

    expect([...missing, ...invalid].map((response) => response.status))
      .toEqual([401, 401, 401, 401, 401, 401]);
    expect(world.removeMembershipFromWatchlist).not.toHaveBeenCalled();
  }, 30_000);

  describe('GET members', () => {
    it('lists members with emails for the owner, hiding the real owner row id', async () => {
      const response = await listMembers();
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.members).toEqual([
        {
          acceptedAt: '2026-06-01T00:00:00.000Z',
          email: EMAILS[TEST_USER_IDS.OWNER],
          id: `owner:${TEST_USER_IDS.OWNER}`,
          role: 'owner',
          userId: TEST_USER_IDS.OWNER,
        },
        {
          acceptedAt: '2026-06-01T00:00:00.000Z',
          email: EMAILS[TEST_USER_IDS.COLLABORATOR],
          id: EDITOR_ROW_ID,
          role: 'editor',
          userId: TEST_USER_IDS.COLLABORATOR,
        },
        {
          acceptedAt: null,
          email: EMAILS[TEST_USER_IDS.PENDING_INVITEE],
          id: PENDING_ROW_ID,
          role: 'editor',
          userId: TEST_USER_IDS.PENDING_INVITEE,
        },
      ]);
      expect(JSON.stringify(body)).not.toContain(OWNER_ROW_ID);
    });

    it('refuses an editor with 403 and no emails', async () => {
      setup(TEST_USER_IDS.COLLABORATOR);

      const response = await listMembers();
      const text = await response.text();

      expect(response.status).toBe(403);
      expect(text).not.toContain('private.test');
    });

    it.each([TEST_USER_IDS.PENDING_INVITEE, TEST_USER_IDS.OUTSIDER])(
      'answers %s with the same 404 as an unknown list',
      async (userId) => {
        setup(userId);

        const denied = await listMembers();
        const unknown = await listMembers(TEST_WATCHLIST_IDS.UNKNOWN);
        const text = await denied.text();

        expect([denied.status, unknown.status]).toEqual([404, 404]);
        expect(text).toBe(await unknown.text());
        expect(text).not.toContain('private.test');
        expect(text).not.toContain(SHARED_WATCHLIST_NAME);
      },
    );
  });

  describe('DELETE members/{membershipId}', () => {
    it('lets the owner remove an editor, who then loses access', async () => {
      const response = await removeMember(EDITOR_ROW_ID);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        deleted: true,
        membershipId: EDITOR_ROW_ID,
      });

      // The removed editor's very next request sees nothing.
      setup(TEST_USER_IDS.COLLABORATOR);

      expect((await listMembers()).status).toBe(404);
      expect((await leave()).status).toBe(404);
    });

    it('refuses owner self-removal, even with the real owner row id', async () => {
      const responses = [
        await removeMember(OWNER_ROW_ID),
        await removeMember(`owner:${TEST_USER_IDS.OWNER}`),
      ];

      expect(responses.map((response) => response.status)).toEqual([403, 404]);
      expect(world.removeMembershipFromWatchlist).not.toHaveBeenCalled();
      expect(world.rows()).toHaveLength(3);
    });

    it('refuses an editor removing anyone, themself included', async () => {
      setup(TEST_USER_IDS.COLLABORATOR);

      const responses = [
        await removeMember(EDITOR_ROW_ID),
        await removeMember(PENDING_ROW_ID),
      ];

      expect(responses.map((response) => response.status)).toEqual([403, 403]);
      expect(world.removeMembershipFromWatchlist).not.toHaveBeenCalled();
    });

    it.each([TEST_USER_IDS.PENDING_INVITEE, TEST_USER_IDS.OUTSIDER])(
      'refuses %s with a 404 and no change',
      async (userId) => {
        setup(userId);

        const response = await removeMember(EDITOR_ROW_ID);

        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toEqual({
          error: 'Watchlist not found.',
        });
        expect(world.removeMembershipFromWatchlist).not.toHaveBeenCalled();
        expect(world.rows()).toHaveLength(3);
      },
    );

    it('returns 404 for a membership id that is not on the list', async () => {
      const response = await removeMember('membership-elsewhere');

      expect(response.status).toBe(404);
      expect(world.removeMembershipFromWatchlist).not.toHaveBeenCalled();
    });
  });

  describe('DELETE membership (editor leave)', () => {
    it('lets an accepted editor leave and lose access', async () => {
      setup(TEST_USER_IDS.COLLABORATOR);

      const response = await leave();

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        left: true,
        watchlistId: SHARED,
      });
      expect(world.rows().map((row) => row.id)).toEqual([
        OWNER_ROW_ID,
        PENDING_ROW_ID,
      ]);
      expect((await leave()).status).toBe(404);
    });

    it('refuses the owner leaving their own list', async () => {
      const response = await leave();

      expect(response.status).toBe(403);
      expect(world.removeMembershipFromWatchlist).not.toHaveBeenCalled();
    });

    it.each([TEST_USER_IDS.PENDING_INVITEE, TEST_USER_IDS.OUTSIDER])(
      'answers %s with the same 404 as an unknown list',
      async (userId) => {
        setup(userId);

        const denied = await leave();
        const unknown = await leave(TEST_WATCHLIST_IDS.UNKNOWN);

        expect([denied.status, unknown.status]).toEqual([404, 404]);
        expect(await denied.text()).toBe(await unknown.text());
        expect(world.removeMembershipFromWatchlist).not.toHaveBeenCalled();
      },
    );
  });
});
