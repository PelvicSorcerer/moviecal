import { createHash, randomBytes } from 'node:crypto';

import { WatchlistAccessError, WatchlistNotFoundError } from './errors';
import { normalizeSharedWatchlistName, requireWatchlistAccess } from './items';
import type {
  AcceptedWatchlistInviteResult,
  CreatedWatchlistInviteLinkResult,
  ResolvedWatchlistInvite,
  WatchlistInviteLink,
  WatchlistMember,
  WatchlistRepository,
  WatchlistSummary,
} from './types';

export function hashWatchlistInviteToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function createWatchlistInviteToken(): string {
  return randomBytes(24).toString('base64url');
}

async function requireOwnedSharedWatchlist(args: {
  actorUserId: string;
  repository: WatchlistRepository;
  watchlistId: string;
}): Promise<WatchlistSummary> {
  const access = await requireWatchlistAccess(args);

  if (
    access.watchlist.kind !== 'shared'
    || access.watchlist.ownerUserId !== args.actorUserId
  ) {
    throw new WatchlistAccessError('Watchlist access denied.');
  }

  return access.watchlist;
}

export async function listUserWatchlists(args: {
  repository: WatchlistRepository;
  userId: string;
}): Promise<WatchlistSummary[]> {
  const personalWatchlist = await args.repository.ensurePersonalWatchlist(args.userId);
  const watchlists = await args.repository.listWatchlistsForUser(args.userId);

  return [...watchlists].sort((left, right) => {
    if (left.id === personalWatchlist.id) {
      return -1;
    }

    if (right.id === personalWatchlist.id) {
      return 1;
    }

    return 0;
  });
}

export async function createSharedWatchlist(args: {
  name: string;
  repository: WatchlistRepository;
  userId: string;
}): Promise<WatchlistSummary> {
  return args.repository.createWatchlist({
    ownerUserId: args.userId,
    kind: 'shared',
    name: normalizeSharedWatchlistName(args.name),
  });
}

export async function resolveWatchlistInvite(args: {
  repository: WatchlistRepository;
  token: string;
}): Promise<ResolvedWatchlistInvite | null> {
  const token = args.token.trim();

  if (!token) {
    return null;
  }

  const resolvedInvite = await args.repository.findInviteLinkByTokenHash(
    hashWatchlistInviteToken(token),
  );

  if (!resolvedInvite) {
    return null;
  }

  if (
    resolvedInvite.watchlist.kind !== 'shared'
    || resolvedInvite.inviteLink.revokedAt
    || (
      resolvedInvite.inviteLink.expiresAt !== null
      && Date.parse(resolvedInvite.inviteLink.expiresAt) <= Date.now()
    )
  ) {
    return null;
  }

  return resolvedInvite;
}

export async function acceptWatchlistInvite(args: {
  actorUserId: string;
  repository: WatchlistRepository;
  token: string;
}): Promise<AcceptedWatchlistInviteResult> {
  const resolvedInvite = await resolveWatchlistInvite({
    repository: args.repository,
    token: args.token,
  });

  if (!resolvedInvite) {
    throw new WatchlistNotFoundError('Invite link is invalid or expired.');
  }

  if (resolvedInvite.watchlist.ownerUserId === args.actorUserId) {
    return {
      joined: false,
      watchlist: resolvedInvite.watchlist,
    };
  }

  const existingMembership = await args.repository.findMembershipForUser(
    resolvedInvite.watchlist.id,
    args.actorUserId,
  );

  if (existingMembership?.acceptedAt) {
    return {
      joined: false,
      watchlist: resolvedInvite.watchlist,
    };
  }

  await args.repository.acceptInviteMembership({
    acceptedAt: new Date().toISOString(),
    invitedByUserId: resolvedInvite.inviteLink.createdByUserId,
    userId: args.actorUserId,
    watchlistId: resolvedInvite.watchlist.id,
  });

  return {
    joined: true,
    watchlist: resolvedInvite.watchlist,
  };
}

export async function createSharedWatchlistInviteLink(args: {
  actorUserId: string;
  baseUrl: string;
  repository: WatchlistRepository;
  watchlistId: string;
}): Promise<CreatedWatchlistInviteLinkResult> {
  const watchlist = await requireOwnedSharedWatchlist({
    actorUserId: args.actorUserId,
    repository: args.repository,
    watchlistId: args.watchlistId,
  });
  const inviteToken = createWatchlistInviteToken();

  await args.repository.revokeInviteLinksForWatchlist(watchlist.id);
  await args.repository.createInviteLink({
    createdByUserId: args.actorUserId,
    expiresAt: null,
    tokenHash: hashWatchlistInviteToken(inviteToken),
    watchlistId: watchlist.id,
  });

  return {
    watchlist,
    inviteUrl: new URL(
      `/watchlist/invite/${encodeURIComponent(inviteToken)}`,
      args.baseUrl,
    ).toString(),
  };
}

export async function listSharedWatchlistMembers(args: {
  actorUserId: string;
  repository: WatchlistRepository;
  watchlistId: string;
}): Promise<WatchlistMember[]> {
  const watchlist = await requireOwnedSharedWatchlist({
    actorUserId: args.actorUserId,
    repository: args.repository,
    watchlistId: args.watchlistId,
  });
  const members = await args.repository.listMembersForWatchlist(watchlist.id);
  const dedupedMembers = new Map<string, WatchlistMember>();

  dedupedMembers.set(watchlist.ownerUserId, {
    acceptedAt: null,
    id: `owner:${watchlist.ownerUserId}`,
    invitedByUserId: null,
    role: 'owner',
    userId: watchlist.ownerUserId,
    watchlistId: watchlist.id,
  });

  for (const member of members) {
    dedupedMembers.set(member.userId, member);
  }

  return [...dedupedMembers.values()].sort((left, right) => {
    if (left.role === 'owner') {
      return -1;
    }

    if (right.role === 'owner') {
      return 1;
    }

    return left.acceptedAt?.localeCompare(right.acceptedAt ?? '') ?? 0;
  });
}

export async function removeSharedWatchlistMember(args: {
  actorUserId: string;
  membershipId: string;
  repository: WatchlistRepository;
  watchlistId: string;
}): Promise<void> {
  await requireOwnedSharedWatchlist({
    actorUserId: args.actorUserId,
    repository: args.repository,
    watchlistId: args.watchlistId,
  });
  const removed = await args.repository.removeMembershipFromWatchlist(
    args.watchlistId,
    args.membershipId,
  );

  if (!removed) {
    throw new WatchlistNotFoundError('Watchlist member not found.');
  }
}

export async function getSharedWatchlistInviteLinkStatus(args: {
  actorUserId: string;
  repository: WatchlistRepository;
  watchlistId: string;
}): Promise<WatchlistInviteLink | null> {
  const watchlist = await requireOwnedSharedWatchlist({
    actorUserId: args.actorUserId,
    repository: args.repository,
    watchlistId: args.watchlistId,
  });

  return args.repository.getActiveInviteLinkForWatchlist(watchlist.id);
}
