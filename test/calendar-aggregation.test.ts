import { describe, expect, it } from 'vitest';

import {
  compareCalendarWatchlistItemCandidates,
  dedupeCalendarWatchlistItems,
  listCalendarWatchlistItems,
  type WatchlistItem,
  type WatchlistRepository,
  type WatchlistSummary,
} from '../src/lib/watchlist';

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
