import type {
  WatchlistRepository,
  WatchlistRow,
  WatchlistSummary,
} from '../../../src/lib/watchlist';
import {
  TEST_ITEM_IDS,
  TEST_TIMESTAMPS,
  TEST_TMDB_IDS,
  TEST_USER_IDS,
  TEST_WATCHLIST_IDS,
} from '../../../src/lib/test-data/catalog';
import { buildWatchlistMember } from '../factories/memberships';
import { buildWatchlistRow, buildWatchlistSummary } from '../factories/watchlists';

import { createWatchlistRepository } from './watchlist-repository';


export const SHARED_WATCHLIST_NAME = 'Friday movie night';

const PERSONAL_WATCHLIST_IDS: Record<string, string> = {
  [TEST_USER_IDS.OWNER]: TEST_WATCHLIST_IDS.PERSONAL,
  [TEST_USER_IDS.COLLABORATOR]: TEST_WATCHLIST_IDS.COLLABORATOR_PERSONAL,
  [TEST_USER_IDS.PENDING_INVITEE]: TEST_WATCHLIST_IDS.PENDING_INVITEE_PERSONAL,
  [TEST_USER_IDS.OUTSIDER]: TEST_WATCHLIST_IDS.OUTSIDER_PERSONAL,
};

export const NEWEST_SHARED_ITEM_ID = 'watchlist-item-3';

export function personalWatchlistIdFor(userId: string): string {
  return PERSONAL_WATCHLIST_IDS[userId] ?? `personal-watchlist-for-${userId}`;
}

function personalWatchlistFor(userId: string): WatchlistSummary {
  return buildWatchlistSummary({
    canEdit: true,
    id: personalWatchlistIdFor(userId),
    kind: 'personal',
    name: 'My watchlist',
    ownerUserId: userId,
  });
}

function sharedWatchlist(canEdit: boolean): WatchlistSummary {
  return buildWatchlistSummary({
    canEdit,
    id: TEST_WATCHLIST_IDS.SHARED,
    kind: 'shared',
    name: SHARED_WATCHLIST_NAME,
    ownerUserId: TEST_USER_IDS.OWNER,
  });
}

function sharedWatchlistRows(): WatchlistRow[] {
  return [
    buildWatchlistRow(TEST_TMDB_IDS.INCEPTION, { id: TEST_ITEM_IDS.INCEPTION }),
    buildWatchlistRow(TEST_TMDB_IDS.MATRIX, {
      added_at: '2026-06-18T12:00:00+00:00',
      id: NEWEST_SHARED_ITEM_ID,
    }),
    buildWatchlistRow(TEST_TMDB_IDS.MATRIX, { id: TEST_ITEM_IDS.MATRIX }),
  ];
}

export function createSharedWatchlistReadRepository(
  overrides: Partial<WatchlistRepository> = {},
): WatchlistRepository {
  return createWatchlistRepository({
    async ensurePersonalWatchlist(userId) {
      return personalWatchlistFor(userId);
    },

    async findMembershipForUser(watchlistId, userId) {
      if (watchlistId !== TEST_WATCHLIST_IDS.SHARED) {
        return null;
      }

      if (userId === TEST_USER_IDS.COLLABORATOR) {
        return buildWatchlistMember({
          acceptedAt: TEST_TIMESTAMPS.MEMBERSHIP_ACCEPTED,
          userId,
        });
      }

      if (userId === TEST_USER_IDS.PENDING_INVITEE) {
        return buildWatchlistMember({
          acceptedAt: null,
          id: 'membership-2',
          userId,
        });
      }

      return null;
    },

    async getWatchlistAccess(actorUserId, watchlistId) {
      if (watchlistId === TEST_WATCHLIST_IDS.SHARED) {
        if (actorUserId === TEST_USER_IDS.OWNER) {
          return {
            canEdit: true,
            status: 'authorized' as const,
            watchlist: sharedWatchlist(true),
          };
        }

        // Only an accepted membership is authorized; a pending invitee is not a
        // member yet, and an outsider never was.
        if (actorUserId === TEST_USER_IDS.COLLABORATOR) {
          return {
            canEdit: true,
            status: 'authorized' as const,
            watchlist: sharedWatchlist(true),
          };
        }

        return { status: 'forbidden' as const };
      }

      if (watchlistId === personalWatchlistIdFor(actorUserId)) {
        return {
          canEdit: true,
          status: 'authorized' as const,
          watchlist: personalWatchlistFor(actorUserId),
        };
      }

      if (Object.values(PERSONAL_WATCHLIST_IDS).includes(watchlistId)) {
        return { status: 'forbidden' as const };
      }

      return { status: 'not_found' as const };
    },

    async listItemsForWatchlist(watchlistId) {
      if (watchlistId === TEST_WATCHLIST_IDS.SHARED) {
        return sharedWatchlistRows();
      }

      if (watchlistId === TEST_WATCHLIST_IDS.PERSONAL) {
        return [buildWatchlistRow(TEST_TMDB_IDS.MATRIX)];
      }

      return [];
    },

    async listWatchlistsForUser(userId) {
      const watchlists = [personalWatchlistFor(userId)];

      if (userId === TEST_USER_IDS.OWNER) {
        watchlists.push(sharedWatchlist(true));
      }

      if (userId === TEST_USER_IDS.COLLABORATOR) {
        watchlists.push(sharedWatchlist(true));
      }

      return watchlists;
    },

    ...overrides,
  });
}
