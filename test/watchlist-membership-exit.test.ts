import { describe, expect, it, vi } from 'vitest';

import {
  acceptWatchlistInvite,
  addWatchlistItem,
  getWatchlistDetail,
  hashWatchlistInviteToken,
  leaveSharedWatchlist,
  listCalendarWatchlistItems,
  listSharedWatchlistMemberProfiles,
  listSharedWatchlistMembers,
  listUserWatchlists,
  removeSharedWatchlistMember,
  WatchlistAccessError,
  WatchlistNotFoundError,
  type WatchlistInviteLink,
  type WatchlistMember,
  type WatchlistSummary,
} from '../src/lib/watchlist';
import { TEST_TMDB_IDS } from '../src/lib/test-data/catalog';
import {
  buildWatchlistInviteLink,
  buildWatchlistMember,
  buildWatchlistRow,
  buildWatchlistSummary,
  createWatchlistRepository,
  TEST_TIMESTAMPS,
  TEST_USER_IDS,
  TEST_WATCHLIST_IDS,
} from './support';

const OWNER_USER_ID = TEST_USER_IDS.OWNER;
const EDITOR_USER_ID = TEST_USER_IDS.COLLABORATOR;
const PENDING_USER_ID = 'user-3';
const OUTSIDER_USER_ID = 'user-4';

const SHARED_WATCHLIST_ID = TEST_WATCHLIST_IDS.SHARED;
const FOREIGN_WATCHLIST_ID = 'shared-watchlist-2';
const PERSONAL_WATCHLIST_IDS: Record<string, string> = {
  [OWNER_USER_ID]: 'personal-owner',
  [EDITOR_USER_ID]: 'personal-editor',
  [PENDING_USER_ID]: 'personal-pending',
  [OUTSIDER_USER_ID]: 'personal-outsider',
};

const OWNER_MEMBERSHIP_ID = 'membership-owner';
const EDITOR_MEMBERSHIP_ID = 'membership-editor';
const PENDING_MEMBERSHIP_ID = 'membership-pending';
const FOREIGN_MEMBERSHIP_ID = 'membership-foreign';

const INVITE_TOKEN = 'mov-374-invite-token';
const ACCESS_DENIED = {
  message: 'Watchlist access denied.',
  name: WatchlistAccessError.name,
  status: 403,
};
const MEMBER_NOT_FOUND = {
  message: 'Watchlist member not found.',
  name: WatchlistNotFoundError.name,
  status: 404,
};

function createSharedWatchlistWorld() {
  const sharedWatchlist = buildWatchlistSummary({
    id: SHARED_WATCHLIST_ID,
    kind: 'shared',
    name: 'Friday movie night',
    ownerUserId: OWNER_USER_ID,
  });
  const watchlistsById = new Map<string, WatchlistSummary>([
    [sharedWatchlist.id, sharedWatchlist],
    [
      FOREIGN_WATCHLIST_ID,
      buildWatchlistSummary({
        id: FOREIGN_WATCHLIST_ID,
        kind: 'shared',
        name: 'Someone else’s list',
        ownerUserId: OUTSIDER_USER_ID,
      }),
    ],
  ]);

  for (const [userId, watchlistId] of Object.entries(PERSONAL_WATCHLIST_IDS)) {
    watchlistsById.set(
      watchlistId,
      buildWatchlistSummary({ id: watchlistId, ownerUserId: userId }),
    );
  }

  let memberships: WatchlistMember[] = [
    buildWatchlistMember({
      id: OWNER_MEMBERSHIP_ID,
      invitedByUserId: OWNER_USER_ID,
      role: 'owner',
      userId: OWNER_USER_ID,
      watchlistId: SHARED_WATCHLIST_ID,
    }),
    buildWatchlistMember({
      id: EDITOR_MEMBERSHIP_ID,
      userId: EDITOR_USER_ID,
      watchlistId: SHARED_WATCHLIST_ID,
    }),
    buildWatchlistMember({
      acceptedAt: null,
      id: PENDING_MEMBERSHIP_ID,
      userId: PENDING_USER_ID,
      watchlistId: SHARED_WATCHLIST_ID,
    }),
    buildWatchlistMember({
      id: FOREIGN_MEMBERSHIP_ID,
      invitedByUserId: OUTSIDER_USER_ID,
      userId: EDITOR_USER_ID,
      watchlistId: FOREIGN_WATCHLIST_ID,
    }),
  ];

  const itemsByWatchlistId = new Map([
    [SHARED_WATCHLIST_ID, [buildWatchlistRow(TEST_TMDB_IDS.INCEPTION)]],
    [
      PERSONAL_WATCHLIST_IDS[EDITOR_USER_ID],
      [buildWatchlistRow(TEST_TMDB_IDS.MATRIX)],
    ],
  ]);

  let inviteLink: WatchlistInviteLink | null = buildWatchlistInviteLink({
    watchlistId: SHARED_WATCHLIST_ID,
  });

  const listMemberEmailsByUserId = vi.fn(async (userIds: string[]) =>
    Object.fromEntries(userIds.map((userId) => [userId, `${userId}@moviecal.test`])),
  );
  const removeMembershipFromWatchlist = vi.fn(
    async (watchlistId: string, membershipId: string) => {
      const remaining = memberships.filter(
        (member) =>
          !(member.watchlistId === watchlistId && member.id === membershipId),
      );
      const removed = remaining.length < memberships.length;

      memberships = remaining;

      return removed;
    },
  );
  const getMovieDetails = vi.fn(async () => {
    throw new Error('getMovieDetails should be unreachable for a denied actor.');
  });

  const repository = createWatchlistRepository({
    async acceptInviteMembership({ acceptedAt, invitedByUserId, userId, watchlistId }) {
      const existing = memberships.find(
        (member) => member.watchlistId === watchlistId && member.userId === userId,
      );

      if (existing) {
        existing.acceptedAt = acceptedAt;
        existing.invitedByUserId = invitedByUserId;
        existing.role = 'editor';

        return existing;
      }

      const member = buildWatchlistMember({
        acceptedAt,
        id: `membership-${userId}-rejoined`,
        invitedByUserId,
        role: 'editor',
        userId,
        watchlistId,
      });

      memberships.push(member);

      return member;
    },
    async ensurePersonalWatchlist(userId) {
      return watchlistsById.get(PERSONAL_WATCHLIST_IDS[userId])!;
    },
    async findInviteLinkByTokenHash(tokenHash) {
      return inviteLink && tokenHash === hashWatchlistInviteToken(INVITE_TOKEN)
        ? { inviteLink, watchlist: sharedWatchlist }
        : null;
    },
    async findMembershipByIdForWatchlist(watchlistId, membershipId) {
      return (
        memberships.find(
          (member) =>
            member.watchlistId === watchlistId && member.id === membershipId,
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
    async getWatchlistAccess(actorUserId, watchlistId) {
      const watchlist = watchlistsById.get(watchlistId);

      if (!watchlist) {
        return { status: 'not_found' as const };
      }

      if (watchlist.ownerUserId === actorUserId) {
        return {
          status: 'authorized' as const,
          watchlist: { ...watchlist, canEdit: true },
          canEdit: true,
        };
      }

      const membership = memberships.find(
        (member) =>
          member.watchlistId === watchlistId && member.userId === actorUserId,
      );

      if (!membership?.acceptedAt) {
        return { status: 'forbidden' as const };
      }

      const canEdit = membership.role === 'owner' || membership.role === 'editor';

      return {
        status: 'authorized' as const,
        watchlist: { ...watchlist, canEdit },
        canEdit,
      };
    },
    async listItemsForWatchlist(watchlistId) {
      return itemsByWatchlistId.get(watchlistId) ?? [];
    },
    listMemberEmailsByUserId,
    async listMembersForWatchlist(watchlistId) {
      return memberships.filter(
        (member) => member.watchlistId === watchlistId && member.acceptedAt !== null,
      );
    },
    async listWatchlistsForUser(userId) {
      const visible = new Map<string, WatchlistSummary>();

      for (const watchlist of watchlistsById.values()) {
        if (watchlist.ownerUserId === userId) {
          visible.set(watchlist.id, { ...watchlist, canEdit: true });
        }
      }

      for (const membership of memberships) {
        if (membership.userId !== userId || !membership.acceptedAt) {
          continue;
        }

        const watchlist = watchlistsById.get(membership.watchlistId);

        if (watchlist && !visible.has(watchlist.id)) {
          visible.set(watchlist.id, { ...watchlist, canEdit: true });
        }
      }

      return [...visible.values()];
    },
    removeMembershipFromWatchlist,
  });

  return {
    getMovieDetails,
    listMemberEmailsByUserId,
    memberships: () => memberships,
    removeMembershipFromWatchlist,
    repository,
    revokeInviteLink() {
      inviteLink = inviteLink
        ? { ...inviteLink, revokedAt: TEST_TIMESTAMPS.FIXED_NOW }
        : null;
    },
  };
}

type World = ReturnType<typeof createSharedWatchlistWorld>;

function actorArgs(world: World, actorUserId = EDITOR_USER_ID, watchlistId = SHARED_WATCHLIST_ID) {
  return { actorUserId, repository: world.repository, watchlistId };
}

function removeArgs(world: World, membershipId: string, actorUserId = OWNER_USER_ID) {
  return { ...actorArgs(world, actorUserId), membershipId };
}

describe('leaveSharedWatchlist', () => {
  it('deletes only the accepted editor membership on the selected list', async () => {
    const world = createSharedWatchlistWorld();
    await leaveSharedWatchlist(actorArgs(world));
    expect(world.removeMembershipFromWatchlist).toHaveBeenCalledWith(
      SHARED_WATCHLIST_ID, EDITOR_MEMBERSHIP_ID,
    );
    expect(world.memberships().map((member) => member.id)).toEqual([
      OWNER_MEMBERSHIP_ID, PENDING_MEMBERSHIP_ID, FOREIGN_MEMBERSHIP_ID,
    ]);
  });

  it.each([
    [OWNER_USER_ID, SHARED_WATCHLIST_ID, { status: 403, message: 'A watchlist owner cannot leave their own watchlist.' }],
    [OUTSIDER_USER_ID, SHARED_WATCHLIST_ID, ACCESS_DENIED],
    [PENDING_USER_ID, SHARED_WATCHLIST_ID, ACCESS_DENIED],
    [EDITOR_USER_ID, PERSONAL_WATCHLIST_IDS[EDITOR_USER_ID], ACCESS_DENIED],
    [EDITOR_USER_ID, 'missing', { status: 404, message: 'Watchlist not found.' }],
  ])('refuses actor %s on %s without writing', async (userId, watchlistId, error) => {
    const world = createSharedWatchlistWorld();
    await expect(leaveSharedWatchlist(actorArgs(world, userId, watchlistId)))
      .rejects.toMatchObject(error);
    expect(world.removeMembershipFromWatchlist).not.toHaveBeenCalled();
  });

  it('refuses a non-owner row claiming the owner role', async () => {
    const world = createSharedWatchlistWorld();
    world.memberships().find((member) => member.id === EDITOR_MEMBERSHIP_ID)!.role = 'owner';
    await expect(leaveSharedWatchlist(actorArgs(world))).rejects.toMatchObject(ACCESS_DENIED);
    expect(world.removeMembershipFromWatchlist).not.toHaveBeenCalled();
  });

  it('reports a concurrent membership removal without repeating a write', async () => {
    const world = createSharedWatchlistWorld();
    vi.spyOn(world.repository, 'findMembershipForUser').mockResolvedValueOnce(null);
    await expect(leaveSharedWatchlist(actorArgs(world))).rejects.toMatchObject(MEMBER_NOT_FOUND);
    expect(world.removeMembershipFromWatchlist).not.toHaveBeenCalled();
  });
});

describe('removeSharedWatchlistMember', () => {
  it.each([
    [EDITOR_USER_ID, PENDING_MEMBERSHIP_ID, ACCESS_DENIED],
    [EDITOR_USER_ID, EDITOR_MEMBERSHIP_ID, ACCESS_DENIED],
    [PENDING_USER_ID, EDITOR_MEMBERSHIP_ID, ACCESS_DENIED],
    [OUTSIDER_USER_ID, EDITOR_MEMBERSHIP_ID, ACCESS_DENIED],
    [OWNER_USER_ID, OWNER_MEMBERSHIP_ID, ACCESS_DENIED],
    [OWNER_USER_ID, `owner:${OWNER_USER_ID}`, MEMBER_NOT_FOUND],
    [OWNER_USER_ID, FOREIGN_MEMBERSHIP_ID, MEMBER_NOT_FOUND],
    [OWNER_USER_ID, 'missing', MEMBER_NOT_FOUND],
  ])('refuses actor %s targeting %s', async (userId, membershipId, error) => {
    const world = createSharedWatchlistWorld();
    await expect(removeSharedWatchlistMember(removeArgs(world, membershipId, userId)))
      .rejects.toMatchObject(error);
    expect(world.removeMembershipFromWatchlist).not.toHaveBeenCalled();
  });

  it('refuses a non-owner row claiming the owner role', async () => {
    const world = createSharedWatchlistWorld();
    world.memberships().find((member) => member.id === EDITOR_MEMBERSHIP_ID)!.role = 'owner';
    await expect(removeSharedWatchlistMember(removeArgs(world, EDITOR_MEMBERSHIP_ID)))
      .rejects.toMatchObject(ACCESS_DENIED);
    expect(world.removeMembershipFromWatchlist).not.toHaveBeenCalled();
  });

  it('reports a concurrent delete as not found', async () => {
    const world = createSharedWatchlistWorld();
    world.removeMembershipFromWatchlist.mockResolvedValueOnce(false);
    await expect(removeSharedWatchlistMember(removeArgs(world, EDITOR_MEMBERSHIP_ID)))
      .rejects.toMatchObject(MEMBER_NOT_FOUND);
  });
});

describe('shared member email privacy', () => {
  it('returns accepted member profiles to the owner and preserves the synthetic owner id', async () => {
    const world = createSharedWatchlistWorld();
    const members = await listSharedWatchlistMemberProfiles(actorArgs(world, OWNER_USER_ID));
    expect(members.map((member) => [member.role, member.email])).toEqual([
      ['owner', `${OWNER_USER_ID}@moviecal.test`],
      ['editor', `${EDITOR_USER_ID}@moviecal.test`],
    ]);
    expect(members[0].id).toBe(`owner:${OWNER_USER_ID}`);
    expect(world.listMemberEmailsByUserId).toHaveBeenCalledWith([OWNER_USER_ID, EDITOR_USER_ID]);
  });

  it.each([EDITOR_USER_ID, PENDING_USER_ID, OUTSIDER_USER_ID])(
    'refuses %s before reading emails or member metadata', async (userId) => {
      const world = createSharedWatchlistWorld();
      const readMembers = vi.spyOn(world.repository, 'listMembersForWatchlist');
      await expect(listSharedWatchlistMemberProfiles(actorArgs(world, userId)))
        .rejects.toMatchObject(ACCESS_DENIED);
      expect(world.listMemberEmailsByUserId).not.toHaveBeenCalled();
      expect(readMembers).not.toHaveBeenCalled();
    },
  );

  it('preserves the email-free listing and tolerates unresolved emails', async () => {
    const world = createSharedWatchlistWorld();
    const members = await listSharedWatchlistMembers(actorArgs(world, OWNER_USER_ID));
    expect(members).toHaveLength(2);
    expect(members.every((member) => !('email' in member))).toBe(true);
    expect(world.listMemberEmailsByUserId).not.toHaveBeenCalled();
    world.listMemberEmailsByUserId.mockResolvedValueOnce({});
    const profiles = await listSharedWatchlistMemberProfiles(actorArgs(world, OWNER_USER_ID));
    expect(profiles.every((member) => member.email === null)).toBe(true);
  });
});

describe.each(['leave', 'remove'] as const)('next-request access after %s', (operation) => {
  async function exit(world: World) {
    if (operation === 'leave') {
      await leaveSharedWatchlist(actorArgs(world));
    } else {
      await removeSharedWatchlistMember(removeArgs(world, EDITOR_MEMBERSHIP_ID));
    }
  }

  it('ends detail, mutation, targeting, and list-only calendar access while preserving other lists', async () => {
    const world = createSharedWatchlistWorld();
    const calendarArgs = { repository: world.repository, userId: EDITOR_USER_ID };
    expect((await listCalendarWatchlistItems(calendarArgs)).map((item) => item.movie.tmdbId))
      .toEqual([TEST_TMDB_IDS.MATRIX, TEST_TMDB_IDS.INCEPTION]);
    expect((await listUserWatchlists(calendarArgs)).map((list) => list.id))
      .toContain(SHARED_WATCHLIST_ID);
    await exit(world);
    await expect(getWatchlistDetail(actorArgs(world))).rejects.toMatchObject(ACCESS_DENIED);
    await expect(addWatchlistItem({
      ...actorArgs(world), getMovieDetails: world.getMovieDetails, tmdbId: TEST_TMDB_IDS.MATRIX,
    })).rejects.toMatchObject(ACCESS_DENIED);
    expect(world.getMovieDetails).not.toHaveBeenCalled();
    expect((await listUserWatchlists(calendarArgs)).map((list) => list.id))
      .not.toContain(SHARED_WATCHLIST_ID);
    expect((await listCalendarWatchlistItems(calendarArgs)).map((item) => item.movie.tmdbId))
      .toEqual([TEST_TMDB_IDS.MATRIX]);
    expect(world.memberships().some((member) => member.id === FOREIGN_MEMBERSHIP_ID)).toBe(true);
    await expect(getWatchlistDetail(actorArgs(world, OWNER_USER_ID)))
      .resolves.toMatchObject({ watchlist: { canEdit: true }, items: [expect.anything()] });
  });

  it('allows rejoin with a valid invite and refuses a revoked one', async () => {
    const world = createSharedWatchlistWorld();
    const inviteArgs = { actorUserId: EDITOR_USER_ID, repository: world.repository, token: INVITE_TOKEN };
    await exit(world);
    await expect(acceptWatchlistInvite(inviteArgs)).resolves.toMatchObject({ joined: true });
    await expect(getWatchlistDetail(actorArgs(world))).resolves.toMatchObject({ watchlist: { canEdit: true } });
    await leaveSharedWatchlist(actorArgs(world));
    world.revokeInviteLink();
    await expect(acceptWatchlistInvite(inviteArgs))
      .rejects.toMatchObject({ message: 'Invite link is invalid or expired.', status: 404 });
    await expect(getWatchlistDetail(actorArgs(world))).rejects.toMatchObject(ACCESS_DENIED);
  });
});
