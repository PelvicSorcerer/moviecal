import type { WatchlistRepository } from '../../../src/lib/watchlist';
import {
  TEST_TIMESTAMPS,
  TEST_USER_IDS,
  TEST_WATCHLIST_IDS,
} from '../../../src/lib/test-data/catalog';
import { buildWatchlistInviteLink, buildWatchlistMember } from '../factories/memberships';
import { buildWatchlistRow, buildWatchlistSummary } from '../factories/watchlists';

export function createWatchlistRepository(
  overrides: Partial<WatchlistRepository> = {},
): WatchlistRepository {
  const personalWatchlist = buildWatchlistSummary({
    id: TEST_WATCHLIST_IDS.PERSONAL,
    kind: 'personal',
    ownerUserId: TEST_USER_IDS.OWNER,
  });
  const sharedWatchlist = buildWatchlistSummary({
    id: TEST_WATCHLIST_IDS.SHARED,
    kind: 'shared',
    name: 'Friday movie night',
    ownerUserId: TEST_USER_IDS.OWNER,
  });

  return {
    async acceptInviteMembership() {
      return buildWatchlistMember();
    },
    async createInviteLink() {
      return buildWatchlistInviteLink();
    },
    async createWatchlist() {
      return sharedWatchlist;
    },
    async deleteItemByIdForWatchlist() {
      return true;
    },
    async ensurePersonalWatchlist(userId) {
      return userId === TEST_USER_IDS.OWNER
        ? personalWatchlist
        : buildWatchlistSummary({
            id: 'personal-watchlist-2',
            ownerUserId: userId,
          });
    },
    async findInviteLinkByTokenHash() {
      return null;
    },
    async findItemByMovieIdForWatchlist() {
      return buildWatchlistRow();
    },
    async findMembershipForUser() {
      return null;
    },
    async getActiveInviteLinkForWatchlist() {
      return null;
    },
    async getWatchlistAccess(actorUserId, watchlistId) {
      if (
        actorUserId === TEST_USER_IDS.OWNER
        && watchlistId === personalWatchlist.id
      ) {
        return {
          status: 'authorized' as const,
          watchlist: personalWatchlist,
          canEdit: true,
        };
      }

      if (
        actorUserId === TEST_USER_IDS.OWNER
        && watchlistId === sharedWatchlist.id
      ) {
        return {
          status: 'authorized' as const,
          watchlist: sharedWatchlist,
          canEdit: true,
        };
      }

      if (
        actorUserId !== TEST_USER_IDS.OWNER
        && watchlistId === 'personal-watchlist-2'
      ) {
        return {
          status: 'authorized' as const,
          watchlist: buildWatchlistSummary({
            id: 'personal-watchlist-2',
            ownerUserId: actorUserId,
          }),
          canEdit: true,
        };
      }

      return {
        status: 'forbidden' as const,
      };
    },
    async insertItemForWatchlist() {
      return {
        row: buildWatchlistRow(),
        errorCode: null,
      };
    },
    async listItemsForWatchlist() {
      return [];
    },
    async listMembersForWatchlist() {
      return [];
    },
    async listTrackedMovies() {
      return [];
    },
    async listWatchlistsForUser(userId) {
      return userId === TEST_USER_IDS.OWNER
        ? [personalWatchlist, sharedWatchlist]
        : [
            buildWatchlistSummary({
              id: 'personal-watchlist-2',
              ownerUserId: userId,
            }),
          ];
    },
    async revokeInviteLinksForWatchlist() {
      return undefined;
    },
    async removeMembershipFromWatchlist() {
      return true;
    },
    async upsertMovie() {
      return { id: buildWatchlistRow().movie?.id ?? 42 };
    },
    ...overrides,
  };
}

export { TEST_TIMESTAMPS, TEST_USER_IDS, TEST_WATCHLIST_IDS };
