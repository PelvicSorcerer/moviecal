import { describe, expect, it, vi } from 'vitest';

import {
  compareCalendarWatchlistItemCandidates,
  dedupeCalendarWatchlistItems,
  listCalendarWatchlistItems,
  WatchlistAccessError,
  WatchlistDataError,
  WatchlistNotFoundError,
  type WatchlistItem,
  type WatchlistRepository,
  type WatchlistSummary,
} from '../src/lib/watchlist';
import {
  buildWatchlistRow,
  buildWatchlistSummary,
  createWatchlistRepository,
  TEST_TMDB_IDS,
  TEST_USER_IDS,
  TEST_WATCHLIST_IDS,
} from './support';

function buildWatchlistItem(
  overrides: Partial<WatchlistItem> = {},
): WatchlistItem {
  return {
    addedAt: '2026-06-20T00:00:00.000Z',
    id: 'watchlist-item-1',
    movie: {
      id: 42,
      overview: 'Overview',
      posterPath: '/poster.jpg',
      releaseDate: '1999-03-31',
      title: 'The Matrix',
      tmdbId: 603,
    },
    ...overrides,
  };
}

describe('calendar watchlist aggregation', () => {
  it('prefers personal-watchlist items over shared-watchlist duplicates', () => {
    const deduped = dedupeCalendarWatchlistItems([
      {
        item: buildWatchlistItem({
          addedAt: '2026-06-22T00:00:00.000Z',
          id: 'shared-item',
          movie: {
            ...buildWatchlistItem().movie,
            title: 'Shared Matrix',
          },
        }),
        watchlistId: 'shared-watchlist-1',
        watchlistKind: 'shared',
      },
      {
        item: buildWatchlistItem({
          addedAt: '2026-06-21T00:00:00.000Z',
          id: 'personal-item',
          movie: {
            ...buildWatchlistItem().movie,
            title: 'Personal Matrix',
          },
        }),
        watchlistId: 'personal-watchlist-1',
        watchlistKind: 'personal',
      },
    ]);

    expect(deduped).toEqual([
      buildWatchlistItem({
        addedAt: '2026-06-21T00:00:00.000Z',
        id: 'personal-item',
        movie: {
          ...buildWatchlistItem().movie,
          title: 'Personal Matrix',
        },
      }),
    ]);
  });

  it('uses earliest addedAt and then item id as deterministic tie-breakers', () => {
    const earlier = {
      item: buildWatchlistItem({
        addedAt: '2026-06-20T00:00:00.000Z',
        id: 'shared-item-b',
        movie: {
          ...buildWatchlistItem().movie,
          title: 'Earlier Shared Matrix',
        },
      }),
      watchlistId: 'shared-watchlist-1',
      watchlistKind: 'shared' as const,
    };
    const later = {
      item: buildWatchlistItem({
        addedAt: '2026-06-21T00:00:00.000Z',
        id: 'shared-item-a',
        movie: {
          ...buildWatchlistItem().movie,
          title: 'Later Shared Matrix',
        },
      }),
      watchlistId: 'shared-watchlist-2',
      watchlistKind: 'shared' as const,
    };

    expect(compareCalendarWatchlistItemCandidates(earlier, later)).toBeLessThan(0);
    expect(dedupeCalendarWatchlistItems([later, earlier])).toEqual([earlier.item]);
  });

  it('aggregates accessible personal and shared watchlists for the token owner', async () => {
    const personalWatchlist: WatchlistSummary = {
      canEdit: true,
      id: 'personal-watchlist-1',
      kind: 'personal',
      name: 'My watchlist',
      ownerUserId: 'user-1',
    };
    const sharedWatchlist: WatchlistSummary = {
      canEdit: true,
      id: 'shared-watchlist-1',
      kind: 'shared',
      name: 'Household picks',
      ownerUserId: 'user-2',
    };
    const repository: WatchlistRepository = {
      async acceptInviteMembership() {
        throw new Error('not implemented');
      },
      async createInviteLink() {
        throw new Error('not implemented');
      },
      async createWatchlist() {
        throw new Error('not implemented');
      },
      async deleteItemByIdForWatchlist() {
        return false;
      },
      async deleteSharedWatchlistOwnedBy() {
        return false;
      },
      async ensurePersonalWatchlist() {
        return personalWatchlist;
      },
      async findInviteLinkByTokenHash() {
        return null;
      },
      async findItemByMovieIdForWatchlist() {
        return null;
      },
      async findMembershipForUser() {
        return null;
      },
      async getActiveInviteLinkForWatchlist() {
        return null;
      },
      async getWatchlistAccess(actorUserId, watchlistId) {
        if (actorUserId !== 'user-1') {
          return { status: 'forbidden' };
        }

        if (watchlistId === personalWatchlist.id) {
          return {
            status: 'authorized',
            canEdit: true,
            watchlist: personalWatchlist,
          };
        }

        if (watchlistId === sharedWatchlist.id) {
          return {
            status: 'authorized',
            canEdit: true,
            watchlist: sharedWatchlist,
          };
        }

        return { status: 'not_found' };
      },
      async insertItemForWatchlist() {
        return { errorCode: null, row: null };
      },
      async listItemsForWatchlist(watchlistId) {
        if (watchlistId === personalWatchlist.id) {
          return [
            {
              added_at: '2026-06-20T00:00:00.000Z',
              id: 'personal-item',
              movie: {
                id: 42,
                raw_json: { overview: 'Personal overview' },
                release_date: '1999-03-31',
                title: 'The Matrix',
                tmdb_id: 603,
                updated_at: '2026-06-20T00:00:00.000Z',
              },
            },
          ];
        }

        if (watchlistId === sharedWatchlist.id) {
          return [
            {
              added_at: '2026-06-21T00:00:00.000Z',
              id: 'shared-item',
              movie: {
                id: 43,
                raw_json: { overview: 'Shared overview' },
                release_date: '2010-07-16',
                title: 'Inception',
                tmdb_id: 27205,
                updated_at: '2026-06-21T00:00:00.000Z',
              },
            },
            {
              added_at: '2026-06-22T00:00:00.000Z',
              id: 'shared-duplicate',
              movie: {
                id: 44,
                raw_json: { overview: 'Shared duplicate overview' },
                release_date: '1999-03-31',
                title: 'Shared Matrix Duplicate',
                tmdb_id: 603,
                updated_at: '2026-06-22T00:00:00.000Z',
              },
            },
          ];
        }

        return [];
      },
      async listMembersForWatchlist() {
        return [];
      },
      async listTrackedMovies() {
        return [];
      },
      async listWatchlistsForUser(userId) {
        return userId === 'user-1' ? [personalWatchlist, sharedWatchlist] : [];
      },
      async removeMembershipFromWatchlist() {
        return false;
      },
      async revokeInviteLinksForWatchlist() {},
      async upsertMovie() {
        return { id: 42 };
      },
    };

    const items = await listCalendarWatchlistItems({
      repository,
      userId: 'user-1',
    });

    expect(items).toEqual([
      buildWatchlistItem({
        addedAt: '2026-06-20T00:00:00.000Z',
        id: 'personal-item',
        movie: {
          id: 42,
          overview: 'Personal overview',
          posterPath: null,
          releaseDate: '1999-03-31',
          title: 'The Matrix',
          tmdbId: 603,
        },
      }),
      buildWatchlistItem({
        addedAt: '2026-06-21T00:00:00.000Z',
        id: 'shared-item',
        movie: {
          id: 43,
          overview: 'Shared overview',
          posterPath: null,
          releaseDate: '2010-07-16',
          title: 'Inception',
          tmdbId: 27205,
        },
      }),
    ]);
  });
});

/**
 * MOV-373 — calendar access-loss semantics for a permanently deleted shared
 * list. The feed is rebuilt from the accessible set on every request, so a
 * former member's next request must simply stop seeing the deleted list's
 * movies while keeping any movie that another accessible list still sources.
 */
describe('calendar aggregation after a shared list is deleted', () => {
  const DELETED_ID = 'shared-watchlist-deleted';
  const RETAINED_ID = 'shared-watchlist-retained';
  const MEMBER_ID = TEST_USER_IDS.COLLABORATOR;

  const personalWatchlist = buildWatchlistSummary({
    id: TEST_WATCHLIST_IDS.PERSONAL,
    kind: 'personal',
    name: 'My watchlist',
    ownerUserId: MEMBER_ID,
  });
  const deletedWatchlist = buildWatchlistSummary({
    id: DELETED_ID,
    kind: 'shared',
    name: 'Deleted movie night',
    ownerUserId: TEST_USER_IDS.OWNER,
  });
  const retainedWatchlist = buildWatchlistSummary({
    id: RETAINED_ID,
    kind: 'shared',
    name: 'Still shared',
    ownerUserId: TEST_USER_IDS.OWNER,
  });

  // The Matrix is in both shared lists; Inception only in the deleted one.
  const itemsByWatchlist = new Map([
    [TEST_WATCHLIST_IDS.PERSONAL, []],
    [
      DELETED_ID,
      [
        buildWatchlistRow(TEST_TMDB_IDS.MATRIX, { id: 'deleted-matrix' }),
        buildWatchlistRow(TEST_TMDB_IDS.INCEPTION, { id: 'deleted-inception' }),
      ],
    ],
    [
      RETAINED_ID,
      [buildWatchlistRow(TEST_TMDB_IDS.MATRIX, { id: 'retained-matrix' })],
    ],
  ]);

  function createMemberRepository(accessible: WatchlistSummary[]) {
    const listItemsForWatchlist = vi.fn(async (watchlistId: string) =>
      itemsByWatchlist.get(watchlistId) ?? [],
    );

    return {
      listItemsForWatchlist,
      repository: createWatchlistRepository({
        async ensurePersonalWatchlist() {
          return personalWatchlist;
        },
        async getWatchlistAccess(actorUserId, watchlistId) {
          const watchlist = accessible.find((entry) => entry.id === watchlistId);

          if (actorUserId !== MEMBER_ID || !watchlist) {
            return { status: 'not_found' as const };
          }

          return { status: 'authorized' as const, canEdit: true, watchlist };
        },
        async listWatchlistsForUser() {
          return accessible;
        },
        listItemsForWatchlist,
      }),
    };
  }

  it('drops the deleted list\'s exclusive movie and keeps one sourced elsewhere', async () => {
    const before = await listCalendarWatchlistItems({
      repository: createMemberRepository([
        personalWatchlist,
        deletedWatchlist,
        retainedWatchlist,
      ]).repository,
      userId: MEMBER_ID,
    });

    // The next request after the delete: memberships went with the list, so it
    // is no longer in the accessible set at all.
    const after = await listCalendarWatchlistItems({
      repository: createMemberRepository([personalWatchlist, retainedWatchlist])
        .repository,
      userId: MEMBER_ID,
    });

    expect(before.map((item) => item.movie.tmdbId).sort()).toEqual([
      TEST_TMDB_IDS.MATRIX,
      TEST_TMDB_IDS.INCEPTION,
    ].sort());
    expect(after.map((item) => item.movie.tmdbId)).toEqual([
      TEST_TMDB_IDS.MATRIX,
    ]);
    expect(after.map((item) => item.id)).toEqual(['retained-matrix']);
  });

  it.each([
    ['deleted mid-request', new WatchlistNotFoundError('Watchlist not found.')],
    ['revoked mid-request', new WatchlistAccessError('Watchlist access denied.')],
  ])(
    'skips a list %s and still serves every other accessible list',
    async (_label, raised) => {
      // listWatchlistsForUser still reported the list, but the item read no
      // longer resolves it — a request racing the owner's delete.
      const { repository } = createMemberRepository([
        personalWatchlist,
        deletedWatchlist,
        retainedWatchlist,
      ]);
      const racingRepository = {
        ...repository,
        async getWatchlistAccess(actorUserId: string, watchlistId: string) {
          if (watchlistId === DELETED_ID) {
            throw raised;
          }

          return repository.getWatchlistAccess(actorUserId, watchlistId);
        },
      };

      const items = await listCalendarWatchlistItems({
        repository: racingRepository,
        userId: MEMBER_ID,
      });

      expect(items.map((item) => item.id)).toEqual(['retained-matrix']);
    },
  );

  it('still fails the feed when a watchlist read hits a real database fault', async () => {
    const { repository } = createMemberRepository([
      personalWatchlist,
      retainedWatchlist,
    ]);

    await expect(
      listCalendarWatchlistItems({
        repository: {
          ...repository,
          async listItemsForWatchlist() {
            throw new WatchlistDataError('Supabase request failed.');
          },
        },
        userId: MEMBER_ID,
      }),
    ).rejects.toThrow(WatchlistDataError);
  });
});
