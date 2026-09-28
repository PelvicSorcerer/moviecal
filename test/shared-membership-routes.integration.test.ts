import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

import type { WatchlistMember } from '../src/lib/watchlist';
import {
  buildWatchlistMember,
  buildWatchlistSummary,
  createWatchlistRepository,
  TEST_USER_IDS,
  TEST_WATCHLIST_IDS,
} from './support';

const mocks = vi.hoisted(() => ({
  authenticateApiRequest: vi.fn(),
  createSupabaseWatchlistRepository: vi.fn(),
  hasE2EAuthenticatedSession: vi.fn(),
}));

vi.mock('../src/lib/auth/session', () => ({
  authenticateApiRequest: mocks.authenticateApiRequest,
}));

vi.mock('../src/lib/supabase/server', () => ({
  createServerSupabaseClient: vi.fn(() => ({})),
  createServerSupabaseServiceRoleClient: vi.fn(() => ({})),
}));

vi.mock('../src/lib/supabase/watchlist', () => ({
  createSupabaseWatchlistRepository: mocks.createSupabaseWatchlistRepository,
}));

vi.mock('../src/lib/e2e/fixtures', () => ({
  hasE2EAuthenticatedSession: mocks.hasE2EAuthenticatedSession,
}));

const OWNER = TEST_USER_IDS.OWNER;
const EDITOR = TEST_USER_IDS.COLLABORATOR;
const OUTSIDER = 'user-outsider';
const WATCHLIST_ID = TEST_WATCHLIST_IDS.SHARED;
const OWNER_MEMBERSHIP_ID = 'membership-owner';
const EDITOR_MEMBERSHIP_ID = 'membership-editor';

function setup(actorUserId: string) {
  const watchlist = buildWatchlistSummary({
    id: WATCHLIST_ID,
    kind: 'shared',
    ownerUserId: OWNER,
  });
  let memberships: WatchlistMember[] = [
    buildWatchlistMember({ id: OWNER_MEMBERSHIP_ID, role: 'owner', userId: OWNER }),
    buildWatchlistMember({ id: EDITOR_MEMBERSHIP_ID, userId: EDITOR }),
  ];

  const repository = createWatchlistRepository({
    async findMembershipByIdForWatchlist(watchlistId, membershipId) {
      return (
        memberships.find(
          (member) => member.watchlistId === watchlistId && member.id === membershipId,
        ) ?? null
      );
    },
    async findMembershipForUser(watchlistId, userId) {
      return (
        memberships.find(
          (member) => member.watchlistId === watchlistId && member.userId === userId,
        ) ?? null
      );
    },
    async getWatchlistAccess(userId, watchlistId) {
      const isMember = memberships.some(
        (member) =>
          member.watchlistId === watchlistId
          && member.userId === userId
          && member.acceptedAt,
      );

      return watchlistId === watchlist.id && (userId === OWNER || isMember)
        ? { status: 'authorized' as const, watchlist, canEdit: true }
        : { status: 'forbidden' as const };
    },
    async removeMembershipFromWatchlist(watchlistId, membershipId) {
      const before = memberships.length;

      memberships = memberships.filter(
        (member) => !(member.watchlistId === watchlistId && member.id === membershipId),
      );

      return memberships.length < before;
    },
  });

  mocks.authenticateApiRequest.mockResolvedValue({
    accessToken: 'access-token',
    user: { id: actorUserId },
    applyAuthCookies(response: NextResponse) {
      response.cookies.set('sb-access-token', 'refreshed');
    },
  });
  mocks.createSupabaseWatchlistRepository.mockReturnValue(repository);
  mocks.hasE2EAuthenticatedSession.mockReturnValue(false);

  return { memberships: () => memberships };
}

async function removeMember(membershipId: string) {
  const { DELETE } = await import(
    '../src/app/api/watchlist/shared/[watchlistId]/members/[membershipId]/route'
  );

  return DELETE(
    new NextRequest(
      `https://moviecal.test/api/watchlist/shared/${WATCHLIST_ID}/members/${membershipId}`,
      { method: 'DELETE' },
    ),
    { params: Promise.resolve({ membershipId, watchlistId: WATCHLIST_ID }) },
  );
}

async function leave() {
  const { DELETE } = await import(
    '../src/app/api/watchlist/shared/[watchlistId]/membership/route'
  );

  return DELETE(
    new NextRequest(
      `https://moviecal.test/api/watchlist/shared/${WATCHLIST_ID}/membership`,
      { method: 'DELETE' },
    ),
    { params: Promise.resolve({ watchlistId: WATCHLIST_ID }) },
  );
}

describe('shared membership exit routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lets an editor leave and refreshes auth cookies', async () => {
    const world = setup(EDITOR);
    const response = await leave();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      left: true,
      watchlistId: WATCHLIST_ID,
    });
    expect(response.cookies.get('sb-access-token')?.value).toBe('refreshed');
    expect(world.memberships().map((member) => member.id)).toEqual([
      OWNER_MEMBERSHIP_ID,
    ]);

    // The next request finds no membership, so access is gone.
    const second = await leave();

    expect(second.status).toBe(403);
  });

  it('refuses owner self-leave without changing data', async () => {
    const world = setup(OWNER);
    const response = await leave();

    expect(response.status).toBe(403);
    expect(world.memberships()).toHaveLength(2);
  });

  it('refuses an outsider leaving without changing data', async () => {
    const world = setup(OUTSIDER);
    const response = await leave();

    expect(response.status).toBe(403);
    expect(world.memberships()).toHaveLength(2);
  });

  it('lets the owner remove an editor', async () => {
    const world = setup(OWNER);
    const response = await removeMember(EDITOR_MEMBERSHIP_ID);

    expect(response.status).toBe(200);
    expect(world.memberships().map((member) => member.id)).toEqual([
      OWNER_MEMBERSHIP_ID,
    ]);
  });

  it('refuses owner self-removal through the real membership id', async () => {
    const world = setup(OWNER);
    const response = await removeMember(OWNER_MEMBERSHIP_ID);

    expect(response.status).toBe(403);
    expect(world.memberships()).toHaveLength(2);
  });

  it('refuses an editor or outsider removing members', async () => {
    for (const actor of [EDITOR, OUTSIDER]) {
      const world = setup(actor);
      const response = await removeMember(EDITOR_MEMBERSHIP_ID);

      expect(response.status).toBe(403);
      expect(world.memberships()).toHaveLength(2);
    }
  });
});
