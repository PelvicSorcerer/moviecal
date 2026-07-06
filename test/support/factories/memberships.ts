import type {
  WatchlistInviteLink,
  WatchlistMember,
} from '../../../src/lib/watchlist';
import {
  TEST_TIMESTAMPS,
  TEST_USER_IDS,
  TEST_WATCHLIST_IDS,
} from '../../../src/lib/test-data/catalog';

export function buildWatchlistMember(
  overrides: Partial<WatchlistMember> = {},
): WatchlistMember {
  return {
    acceptedAt: TEST_TIMESTAMPS.MEMBERSHIP_ACCEPTED,
    id: 'membership-1',
    invitedByUserId: TEST_USER_IDS.OWNER,
    role: 'editor',
    userId: TEST_USER_IDS.COLLABORATOR,
    watchlistId: TEST_WATCHLIST_IDS.SHARED,
    ...overrides,
  };
}

export function buildWatchlistInviteLink(
  overrides: Partial<WatchlistInviteLink> = {},
): WatchlistInviteLink {
  return {
    createdAt: TEST_TIMESTAMPS.INVITE_CREATED,
    createdByUserId: TEST_USER_IDS.OWNER,
    expiresAt: null,
    id: 'invite-1',
    revokedAt: null,
    watchlistId: TEST_WATCHLIST_IDS.SHARED,
    ...overrides,
  };
}
