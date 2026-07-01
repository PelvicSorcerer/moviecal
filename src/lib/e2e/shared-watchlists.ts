import type { CookieValueReader } from '../auth/cookies';
import {
  createE2EWatchlistInviteLink,
  createE2EWatchlistMember,
  readE2ESharedState,
  readStoredE2EWatchlists,
  setE2ESharedStateCookie,
  setE2EWatchlistsCookie,
  type E2ESharedState,
} from './fixtures';
import type {
  AcceptedWatchlistInviteResult,
  CreatedWatchlistInviteLinkResult,
  ResolvedWatchlistInvite,
  WatchlistInviteLink,
  WatchlistMember,
  WatchlistSummary,
} from '../watchlist';

interface CookieWriter {
  cookies: {
    set: (...args: any[]) => unknown;
  };
}

export interface E2EWatchlistAccessResult {
  membership: WatchlistMember | null;
  watchlist: WatchlistSummary;
}

function isInviteActive(inviteLink: WatchlistInviteLink): boolean {
  return !inviteLink.revokedAt
    && (
      inviteLink.expiresAt === null
      || Date.parse(inviteLink.expiresAt) > Date.now()
    );
}

export function getE2EWatchlistAccess(
  reader: CookieValueReader,
  actorUserId: string,
  watchlistId: string,
): E2EWatchlistAccessResult | null {
  const watchlist = readStoredE2EWatchlists(reader).find((entry) => entry.id === watchlistId);

  if (!watchlist || watchlist.kind !== 'shared') {
    return null;
  }

  if (watchlist.ownerUserId === actorUserId) {
    return {
      membership: null,
      watchlist,
    };
  }

  const membership = readE2ESharedState(reader).memberships.find(
    (entry) => entry.watchlistId === watchlistId
      && entry.userId === actorUserId
      && entry.acceptedAt,
  );

  if (!membership) {
    return null;
  }

  return {
    membership,
    watchlist,
  };
}

export function listE2EWatchlistMembers(
  reader: CookieValueReader,
  watchlistId: string,
): WatchlistMember[] {
  return readE2ESharedState(reader).memberships.filter(
    (member) => member.watchlistId === watchlistId && member.acceptedAt,
  );
}

export function getE2EActiveInviteLink(
  reader: CookieValueReader,
  watchlistId: string,
): WatchlistInviteLink | null {
  const inviteLink = readE2ESharedState(reader).inviteLinks.find(
    (entry) => entry.watchlistId === watchlistId && isInviteActive(entry),
  );

  return inviteLink ?? null;
}

export function resolveE2EWatchlistInvite(
  reader: CookieValueReader,
  token: string,
): ResolvedWatchlistInvite | null {
  const trimmedToken = token.trim();

  if (!trimmedToken) {
    return null;
  }

  const inviteLink = readE2ESharedState(reader).inviteLinks.find(
    (entry) => entry.token === trimmedToken && isInviteActive(entry),
  );

  if (!inviteLink) {
    return null;
  }

  const watchlist = readStoredE2EWatchlists(reader).find(
    (entry) => entry.id === inviteLink.watchlistId,
  );

  if (!watchlist || watchlist.kind !== 'shared') {
    return null;
  }

  return {
    inviteLink,
    watchlist,
  };
}

export function createE2EInviteLink(args: {
  actorUserId: string;
  baseUrl: string;
  reader: CookieValueReader;
  response: CookieWriter;
  token: string;
  watchlistId: string;
}): CreatedWatchlistInviteLinkResult | null {
  const access = getE2EWatchlistAccess(args.reader, args.actorUserId, args.watchlistId);

  if (!access || access.watchlist.ownerUserId !== args.actorUserId) {
    return null;
  }

  const sharedState = readE2ESharedState(args.reader);
  const nextSharedState: E2ESharedState = {
    memberships: sharedState.memberships,
    inviteLinks: [
      ...sharedState.inviteLinks
        .filter((inviteLink) => inviteLink.watchlistId !== args.watchlistId)
        .map((inviteLink) => ({
          ...inviteLink,
          revokedAt: inviteLink.revokedAt ?? new Date().toISOString(),
        })),
      createE2EWatchlistInviteLink({
        createdByUserId: args.actorUserId,
        token: args.token,
        watchlistId: args.watchlistId,
      }),
    ],
  };

  setE2ESharedStateCookie(args.response, nextSharedState);

  return {
    watchlist: access.watchlist,
    inviteUrl: new URL(`/watchlist/invite/${encodeURIComponent(args.token)}`, args.baseUrl).toString(),
  };
}

export function acceptE2EInvite(args: {
  actorUserId: string;
  reader: CookieValueReader;
  response: CookieWriter;
  token: string;
}): AcceptedWatchlistInviteResult | null {
  const resolvedInvite = resolveE2EWatchlistInvite(args.reader, args.token);

  if (!resolvedInvite) {
    return null;
  }

  if (resolvedInvite.watchlist.ownerUserId === args.actorUserId) {
    return {
      joined: false,
      watchlist: resolvedInvite.watchlist,
    };
  }

  const sharedState = readE2ESharedState(args.reader);
  const existingMembership = sharedState.memberships.find(
    (membership) => membership.watchlistId === resolvedInvite.watchlist.id
      && membership.userId === args.actorUserId
      && membership.acceptedAt,
  );

  const watchlists = readStoredE2EWatchlists(args.reader);
  const nextWatchlists = watchlists.some((watchlist) => watchlist.id === resolvedInvite.watchlist.id)
    ? watchlists
    : [...watchlists, resolvedInvite.watchlist];

  setE2EWatchlistsCookie(args.response, nextWatchlists);

  if (existingMembership) {
    return {
      joined: false,
      watchlist: resolvedInvite.watchlist,
    };
  }

  setE2ESharedStateCookie(args.response, {
    memberships: [
      ...sharedState.memberships,
      createE2EWatchlistMember({
        invitedByUserId: resolvedInvite.inviteLink.createdByUserId,
        userId: args.actorUserId,
        watchlistId: resolvedInvite.watchlist.id,
      }),
    ],
    inviteLinks: sharedState.inviteLinks,
  });

  return {
    joined: true,
    watchlist: resolvedInvite.watchlist,
  };
}

export function removeE2EWatchlistMember(args: {
  actorUserId: string;
  membershipId: string;
  reader: CookieValueReader;
  response: CookieWriter;
  watchlistId: string;
}): boolean {
  const access = getE2EWatchlistAccess(args.reader, args.actorUserId, args.watchlistId);

  if (!access || access.watchlist.ownerUserId !== args.actorUserId) {
    return false;
  }

  const sharedState = readE2ESharedState(args.reader);
  const memberToRemove = sharedState.memberships.find(
    (membership) => membership.watchlistId === args.watchlistId
      && membership.id === args.membershipId,
  );

  if (!memberToRemove) {
    return false;
  }

  setE2ESharedStateCookie(args.response, {
    memberships: sharedState.memberships.filter(
      (membership) => membership.id !== args.membershipId,
    ),
    inviteLinks: sharedState.inviteLinks,
  });

  return true;
}
