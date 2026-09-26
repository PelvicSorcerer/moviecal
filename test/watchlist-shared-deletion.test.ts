/**
 * MOV-373 — authorization and failure paths for the shared-domain owner-only
 * permanent deletion operation (`deleteSharedWatchlist`).
 *
 * These cover the invariants a transport must not have to reimplement: who may
 * delete, what a refusal is allowed to say, and how a repeated delete reports.
 * Cascade atomicity, invite invalidation, and calendar access loss are covered
 * against real Postgres by test/shared-watchlist-deletion.real-stack.test.ts;
 * the feed's handling of a list deleted mid-request is in
 * test/calendar-aggregation.test.ts.
 *
 * Lane: unit (npm run lane:unit)
 */

import { describe, expect, it, vi } from 'vitest';

import {
  deleteSharedWatchlist,
  WatchlistAccessError,
  WatchlistNotFoundError,
  type WatchlistSummary,
} from '../src/lib/watchlist';
import {
  buildWatchlistSummary,
  createWatchlistRepository,
  TEST_USER_IDS,
  TEST_WATCHLIST_IDS,
} from './support';

const SHARED_NAME = 'Friday movie night';
const MEMBER_ID = TEST_USER_IDS.COLLABORATOR;
const OUTSIDER_ID = 'user-outsider';

const ownedShared = (): WatchlistSummary =>
  buildWatchlistSummary({
    id: TEST_WATCHLIST_IDS.SHARED,
    kind: 'shared',
    name: SHARED_NAME,
    ownerUserId: TEST_USER_IDS.OWNER,
  });

const ownedPersonal = (): WatchlistSummary =>
  buildWatchlistSummary({
    id: TEST_WATCHLIST_IDS.PERSONAL,
    kind: 'personal',
    name: 'My watchlist',
    ownerUserId: TEST_USER_IDS.OWNER,
  });

/**
 * A repository whose access answers mirror the real aggregate: the owner and an
 * accepted editor are both `authorized` with `canEdit`, and everybody else is
 * `forbidden`. Only ownership separates them, which is exactly what the domain
 * operation has to notice.
 */
function createRepository(options?: { deleted?: boolean }) {
  const watchlists = [ownedShared(), ownedPersonal()];
  const deleteSharedWatchlistOwnedBy = vi.fn(async () => options?.deleted ?? true);

  return {
    deleteSharedWatchlistOwnedBy,
    repository: createWatchlistRepository({
      async getWatchlistAccess(actorUserId, watchlistId) {
        const watchlist = watchlists.find((entry) => entry.id === watchlistId);

        if (!watchlist) {
          return { status: 'not_found' as const };
        }

        if (watchlist.ownerUserId === actorUserId) {
          return { status: 'authorized' as const, canEdit: true, watchlist };
        }

        if (watchlist.kind === 'shared' && actorUserId === MEMBER_ID) {
          return { status: 'authorized' as const, canEdit: true, watchlist };
        }

        return { status: 'forbidden' as const };
      },
      deleteSharedWatchlistOwnedBy,
    }),
  };
}

describe('deleteSharedWatchlist — owner authorization', () => {
  it('deletes the owner\'s shared list through an owner-scoped repository call', async () => {
    const { deleteSharedWatchlistOwnedBy, repository } = createRepository();

    await expect(
      deleteSharedWatchlist({
        actorUserId: TEST_USER_IDS.OWNER,
        repository,
        watchlistId: TEST_WATCHLIST_IDS.SHARED,
      }),
    ).resolves.toEqual({ deleted: true, watchlist: ownedShared() });

    // The owner is pinned into the persistence call, so the statement itself
    // stays owner-scoped rather than trusting the id alone.
    expect(deleteSharedWatchlistOwnedBy).toHaveBeenCalledTimes(1);
    expect(deleteSharedWatchlistOwnedBy).toHaveBeenCalledWith({
      ownerUserId: TEST_USER_IDS.OWNER,
      watchlistId: TEST_WATCHLIST_IDS.SHARED,
    });
  });
});

describe('deleteSharedWatchlist — refusals change nothing', () => {
  it.each([
    ['an accepted editor', MEMBER_ID, TEST_WATCHLIST_IDS.SHARED],
    ['an outsider', OUTSIDER_ID, TEST_WATCHLIST_IDS.SHARED],
    ["the owner's own personal list", TEST_USER_IDS.OWNER, TEST_WATCHLIST_IDS.PERSONAL],
    ['an outsider aimed at a personal list', OUTSIDER_ID, TEST_WATCHLIST_IDS.PERSONAL],
  ])('refuses %s with no persistence write', async (_label, actorUserId, watchlistId) => {
    const { deleteSharedWatchlistOwnedBy, repository } = createRepository();

    await expect(
      deleteSharedWatchlist({ actorUserId, repository, watchlistId }),
    ).rejects.toMatchObject({
      message: 'Watchlist access denied.',
      name: WatchlistAccessError.name,
      status: 403,
    });

    expect(deleteSharedWatchlistOwnedBy).not.toHaveBeenCalled();
  });

  it('discloses no list metadata in a refusal', async () => {
    const { repository } = createRepository();
    const error = await deleteSharedWatchlist({
      actorUserId: OUTSIDER_ID,
      repository,
      watchlistId: TEST_WATCHLIST_IDS.SHARED,
    }).catch((raised: unknown) => raised);

    expect(error).toBeInstanceOf(WatchlistAccessError);
    expect(JSON.stringify({ message: (error as Error).message })).not.toContain(
      SHARED_NAME,
    );
    expect((error as Error).message).not.toContain(TEST_WATCHLIST_IDS.SHARED);
    expect((error as Error).message).not.toContain(TEST_USER_IDS.OWNER);
  });
});

describe('deleteSharedWatchlist — unavailable lists', () => {
  it('reports an unknown or already-deleted list as not found, without a write', async () => {
    const { deleteSharedWatchlistOwnedBy, repository } = createRepository();

    await expect(
      deleteSharedWatchlist({
        actorUserId: TEST_USER_IDS.OWNER,
        repository,
        watchlistId: 'shared-watchlist-already-gone',
      }),
    ).rejects.toMatchObject({
      message: 'Watchlist not found.',
      name: WatchlistNotFoundError.name,
      status: 404,
    });

    expect(deleteSharedWatchlistOwnedBy).not.toHaveBeenCalled();
  });

  it('reports a persistence layer that matched no row as not found, never as a partial delete', async () => {
    // What a database-side refusal looks like from here: RLS filtered the row,
    // so the delete matched nothing even though the access lookup resolved.
    const { deleteSharedWatchlistOwnedBy, repository } = createRepository({
      deleted: false,
    });

    await expect(
      deleteSharedWatchlist({
        actorUserId: TEST_USER_IDS.OWNER,
        repository,
        watchlistId: TEST_WATCHLIST_IDS.SHARED,
      }),
    ).rejects.toMatchObject({
      message: 'Watchlist not found.',
      name: WatchlistNotFoundError.name,
      status: 404,
    });

    expect(deleteSharedWatchlistOwnedBy).toHaveBeenCalledTimes(1);
  });
});
