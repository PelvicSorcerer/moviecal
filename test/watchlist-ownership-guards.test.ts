/**
 * MOV-330 — domain guards for shared-watchlist ownership invariants.
 *
 * Migration 20260924000000 is the authoritative boundary, proved by
 * test/watchlist-ownership-invariants.real-stack.test.ts. These tests cover the
 * matching guards in the domain and E2E-fixture layers, which refuse a crafted
 * owner-removal request before it reaches Supabase at all.
 *
 * Lane: unit (npm run lane:unit)
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { E2E_SHARED_STATE_COOKIE, E2E_WATCHLISTS_COOKIE } from '../src/lib/e2e/fixtures';
import { removeE2EWatchlistMember } from '../src/lib/e2e/shared-watchlists';
import {
  listSharedWatchlistMembers,
  removeSharedWatchlistMember,
  WatchlistAccessError,
  type WatchlistMember,
  type WatchlistSummary,
} from '../src/lib/watchlist';
import {
  buildWatchlistMember,
  buildWatchlistSummary,
  createWatchlistRepository,
  TEST_USER_IDS,
  TEST_WATCHLIST_IDS,
} from './support';

const OWNER_MEMBERSHIP_ID = 'membership-owner';
const EDITOR_MEMBERSHIP_ID = 'membership-editor';
const OWNER_ACCEPTED_AT = '2026-06-19T00:00:00.000Z';

const ownerMembership = (): WatchlistMember =>
  buildWatchlistMember({
    acceptedAt: OWNER_ACCEPTED_AT,
    id: OWNER_MEMBERSHIP_ID,
    invitedByUserId: TEST_USER_IDS.OWNER,
    role: 'owner',
    userId: TEST_USER_IDS.OWNER,
    watchlistId: TEST_WATCHLIST_IDS.SHARED,
  });

const editorMembership = (): WatchlistMember =>
  buildWatchlistMember({
    id: EDITOR_MEMBERSHIP_ID,
    userId: TEST_USER_IDS.COLLABORATOR,
    watchlistId: TEST_WATCHLIST_IDS.SHARED,
  });

function createOwnedSharedRepository() {
  const members = [ownerMembership(), editorMembership()];
  const sharedWatchlist = buildWatchlistSummary({
    id: TEST_WATCHLIST_IDS.SHARED,
    kind: 'shared',
    name: 'Friday movie night',
    ownerUserId: TEST_USER_IDS.OWNER,
  });
  const removeMembershipFromWatchlist = vi.fn(async () => true);

  return {
    removeMembershipFromWatchlist,
    repository: createWatchlistRepository({
      async getWatchlistAccess(actorUserId, watchlistId) {
        return actorUserId === TEST_USER_IDS.OWNER && watchlistId === sharedWatchlist.id
          ? { status: 'authorized' as const, watchlist: sharedWatchlist, canEdit: true }
          : { status: 'forbidden' as const };
      },
      async findMembershipForUser(watchlistId, userId) {
        return (
          members.find(
            (member) => member.watchlistId === watchlistId && member.userId === userId,
          ) ?? null
        );
      },
      async listMembersForWatchlist(watchlistId) {
        return members.filter((member) => member.watchlistId === watchlistId);
      },
      removeMembershipFromWatchlist,
    }),
  };
}

describe('shared watchlist owner-membership guards', () => {
  it('refuses to remove the owner membership, with no repository write and no metadata', async () => {
    const { removeMembershipFromWatchlist, repository } = createOwnedSharedRepository();

    await expect(
      removeSharedWatchlistMember({
        actorUserId: TEST_USER_IDS.OWNER,
        membershipId: OWNER_MEMBERSHIP_ID,
        repository,
        watchlistId: TEST_WATCHLIST_IDS.SHARED,
      }),
    ).rejects.toMatchObject({
      message: 'Watchlist access denied.',
      name: WatchlistAccessError.name,
      status: 403,
    });

    expect(removeMembershipFromWatchlist).not.toHaveBeenCalled();
  });

  it('still removes an accepted editor membership for the owner', async () => {
    const { removeMembershipFromWatchlist, repository } = createOwnedSharedRepository();

    await expect(
      removeSharedWatchlistMember({
        actorUserId: TEST_USER_IDS.OWNER,
        membershipId: EDITOR_MEMBERSHIP_ID,
        repository,
        watchlistId: TEST_WATCHLIST_IDS.SHARED,
      }),
    ).resolves.toBeUndefined();

    expect(removeMembershipFromWatchlist).toHaveBeenCalledWith(
      TEST_WATCHLIST_IDS.SHARED,
      EDITOR_MEMBERSHIP_ID,
    );
  });

  it('never exposes the real owner membership id through the member list', async () => {
    const { repository } = createOwnedSharedRepository();
    const members = await listSharedWatchlistMembers({
      actorUserId: TEST_USER_IDS.OWNER,
      repository,
      watchlistId: TEST_WATCHLIST_IDS.SHARED,
    });
    const owner = members.find((member) => member.role === 'owner');

    expect(members).toHaveLength(2);
    expect(owner?.id).toBe(`owner:${TEST_USER_IDS.OWNER}`);
    expect(owner?.acceptedAt).toBe(OWNER_ACCEPTED_AT);
    expect(members.map((member) => member.id)).not.toContain(OWNER_MEMBERSHIP_ID);
  });
});

describe('E2E fixture owner-membership guard', () => {
  const sharedWatchlist: WatchlistSummary = {
    canEdit: true,
    id: 'e2e-shared-watchlist',
    kind: 'shared',
    name: 'E2E shared list',
    ownerUserId: TEST_USER_IDS.E2E_OWNER,
  };

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function removeMember(membership: WatchlistMember) {
    vi.stubEnv('MOVIECAL_E2E_TEST_MODE', '1');

    const writes: string[] = [];
    const entries: Record<string, string> = {
      [E2E_WATCHLISTS_COOKIE]: JSON.stringify([sharedWatchlist]),
      [E2E_SHARED_STATE_COOKIE]: JSON.stringify({
        inviteLinks: [],
        memberships: [membership],
      }),
    };

    const removed = removeE2EWatchlistMember({
      actorUserId: TEST_USER_IDS.E2E_OWNER,
      membershipId: membership.id,
      reader: {
        get: (name: string) =>
          entries[name] === undefined ? undefined : { value: entries[name] },
      },
      response: { cookies: { set: (name: string) => writes.push(name) } },
      watchlistId: sharedWatchlist.id,
    });

    return { removed, writes };
  }

  it('refuses to remove a membership row belonging to the owner', () => {
    expect(
      removeMember({
        acceptedAt: OWNER_ACCEPTED_AT,
        id: OWNER_MEMBERSHIP_ID,
        invitedByUserId: null,
        role: 'owner',
        userId: TEST_USER_IDS.E2E_OWNER,
        watchlistId: sharedWatchlist.id,
      }),
    ).toEqual({ removed: false, writes: [] });
  });

  it('still removes an accepted collaborator membership', () => {
    const result = removeMember({
      acceptedAt: '2026-06-20T00:00:00.000Z',
      id: EDITOR_MEMBERSHIP_ID,
      invitedByUserId: TEST_USER_IDS.E2E_OWNER,
      role: 'editor',
      userId: TEST_USER_IDS.E2E_COLLABORATOR,
      watchlistId: sharedWatchlist.id,
    });

    expect(result.removed).toBe(true);
    expect(result.writes).toHaveLength(1);
  });
});
