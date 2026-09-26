import { createHash, randomBytes } from 'node:crypto';

import { WatchlistAccessError, WatchlistNotFoundError } from './errors';
import { normalizeSharedWatchlistName, requireWatchlistAccess } from './items';
import type {
  AcceptedWatchlistInviteResult,
  CreatedWatchlistInviteLinkResult,
  DeletedSharedWatchlistResult,
  ResolvedWatchlistInvite,
  WatchlistInviteLink,
  WatchlistMember,
  WatchlistMemberProfile,
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

/**
 * The one rename rule for shared lists, called by every transport (cookie and
 * bearer routes). The owner and accepted editors may rename; pending invitees,
 * outsiders, and personal lists are refused before anything is written, and
 * the refusal carries no list metadata.
 */
export async function renameSharedWatchlist(args: {
  actorUserId: string;
  name: string;
  repository: WatchlistRepository;
  watchlistId: string;
}): Promise<WatchlistSummary> {
  const access = await requireWatchlistAccess({
    actorUserId: args.actorUserId,
    repository: args.repository,
    requireEdit: true,
    watchlistId: args.watchlistId,
  });

  if (access.watchlist.kind !== 'shared') {
    throw new WatchlistAccessError('Watchlist access denied.');
  }

  const renamed = await args.repository.renameWatchlist({
    name: normalizeSharedWatchlistName(args.name),
    watchlistId: access.watchlist.id,
  });

  // Access was revoked (or the list removed) between the check and the write.
  if (!renamed) {
    throw new WatchlistAccessError('Watchlist access denied.');
  }

  return { ...renamed, canEdit: access.canEdit };
}

/**
 * Permanently deletes a shared watchlist the actor owns, together with its
 * items, memberships, and invite-link hashes.
 *
 * This is the single place the deletion invariants live. Cookie-session and
 * bearer-token transports are expected to call it rather than reimplementing
 * any part of the authorization or cascade contract:
 *
 * - **Owner only.** An accepted editor, an outsider, and the owner of a
 *   *personal* list all fail before any write is attempted, and the refusal
 *   carries nothing but a fixed message — no name, member, or item metadata.
 * - **Personal lists are never deletable here.** `requireOwnedSharedWatchlist`
 *   rejects `kind !== 'shared'`, and the persistence layer constrains the
 *   statement to a shared row as well, so the owner's personal list survives a
 *   request that targets it.
 * - **Repeat deletion is a not-found.** Once the row is gone the access lookup
 *   cannot resolve it, so a second call raises `WatchlistNotFoundError` (404)
 *   rather than reporting a second success.
 * - **Atomic, or nothing.** The repository removes the list and every dependent
 *   row in one operation; a persistence layer that matched no row resolves
 *   `false` and is surfaced as the same not-found response, never as a partial
 *   delete.
 *
 * Former members lose access as a consequence of the membership rows going with
 * the list: the next `listUserWatchlists` (and therefore the next private
 * calendar-feed request) no longer sees it. See
 * `docs/technical/calendar-feed-design.md`.
 */
export async function deleteSharedWatchlist(args: {
  actorUserId: string;
  repository: WatchlistRepository;
  watchlistId: string;
}): Promise<DeletedSharedWatchlistResult> {
  const watchlist = await requireOwnedSharedWatchlist({
    actorUserId: args.actorUserId,
    repository: args.repository,
    watchlistId: args.watchlistId,
  });

  const deleted = await args.repository.deleteSharedWatchlistOwnedBy({
    ownerUserId: watchlist.ownerUserId,
    watchlistId: watchlist.id,
  });

  if (!deleted) {
    throw new WatchlistNotFoundError('Watchlist not found.');
  }

  return {
    deleted: true,
    watchlist,
  };
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

async function readMembersWithOwnerAnchor(args: {
  repository: WatchlistRepository;
  watchlist: WatchlistSummary;
}): Promise<WatchlistMember[]> {
  const { watchlist } = args;
  const members = await args.repository.listMembersForWatchlist(watchlist.id);
  const dedupedMembers = new Map<string, WatchlistMember>();

  for (const member of members) {
    dedupedMembers.set(member.userId, member);
  }

  // The owner row is always rendered from the watchlist's own ownership anchor
  // and keeps a synthetic id, so the real owner membership id never reaches a
  // client that could then aim a member-removal request at it.
  dedupedMembers.set(watchlist.ownerUserId, {
    acceptedAt: dedupedMembers.get(watchlist.ownerUserId)?.acceptedAt ?? null,
    id: `owner:${watchlist.ownerUserId}`,
    invitedByUserId: null,
    role: 'owner',
    userId: watchlist.ownerUserId,
    watchlistId: watchlist.id,
  });

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

  return readMembersWithOwnerAnchor({
    repository: args.repository,
    watchlist,
  });
}

/**
 * Owner-only member listing that also resolves each member's account email.
 *
 * Member emails are the one piece of private metadata a shared list holds about
 * accounts other than the actor's own, so the ownership check runs first and
 * the email lookup is unreachable for an editor, a pending invitee, or an
 * outsider — all three fail in `requireOwnedSharedWatchlist` before any account
 * is read. Consumers that only need roles should keep using
 * `listSharedWatchlistMembers`.
 */
export async function listSharedWatchlistMemberProfiles(args: {
  actorUserId: string;
  repository: WatchlistRepository;
  watchlistId: string;
}): Promise<WatchlistMemberProfile[]> {
  const watchlist = await requireOwnedSharedWatchlist({
    actorUserId: args.actorUserId,
    repository: args.repository,
    watchlistId: args.watchlistId,
  });
  const members = await readMembersWithOwnerAnchor({
    repository: args.repository,
    watchlist,
  });
  const emailsByUserId = await args.repository.listMemberEmailsByUserId(
    members.map((member) => member.userId),
  );

  return members.map((member) => ({
    ...member,
    email: emailsByUserId[member.userId] ?? null,
  }));
}

export async function removeSharedWatchlistMember(args: {
  actorUserId: string;
  membershipId: string;
  repository: WatchlistRepository;
  watchlistId: string;
}): Promise<void> {
  const watchlist = await requireOwnedSharedWatchlist({
    actorUserId: args.actorUserId,
    repository: args.repository,
    watchlistId: args.watchlistId,
  });

  // A caller can craft a removal request with the real membership id even
  // though the member list exposes only a synthetic owner id. Removing it
  // would strip the owner's edit access, because can_edit_watchlist reads memberships.
  const ownerMembership = await args.repository.findMembershipForUser(
    watchlist.id,
    watchlist.ownerUserId,
  );

  if (ownerMembership && ownerMembership.id === args.membershipId) {
    throw new WatchlistAccessError('Watchlist access denied.');
  }

  // Resolve the target before deleting anything. Scoping the lookup to this
  // watchlist means a membership id crafted from another list reads as "not
  // found" rather than reaching the delete, and a row that still claims the
  // owner role is refused even if the ownership anchor above disagreed with it.
  const targetMembership = await args.repository.findMembershipByIdForWatchlist(
    watchlist.id,
    args.membershipId,
  );

  if (!targetMembership) {
    throw new WatchlistNotFoundError('Watchlist member not found.');
  }

  if (
    targetMembership.role === 'owner'
    || targetMembership.userId === watchlist.ownerUserId
  ) {
    throw new WatchlistAccessError('Watchlist access denied.');
  }

  const removed = await args.repository.removeMembershipFromWatchlist(
    watchlist.id,
    targetMembership.id,
  );

  if (!removed) {
    throw new WatchlistNotFoundError('Watchlist member not found.');
  }
}

/**
 * An accepted editor removes their own membership from a shared list.
 *
 * The owner is refused: their membership row is the list's ownership anchor,
 * and `can_edit_watchlist` reads memberships, so "leaving" would silently strip
 * the owner's own edit access and leave the list with nobody able to manage it.
 * Migration 20260924000000 refuses the same delete at the database boundary,
 * including for the service-role client this repository uses.
 */
export async function leaveSharedWatchlist(args: {
  actorUserId: string;
  repository: WatchlistRepository;
  watchlistId: string;
}): Promise<void> {
  // An outsider and a pending invitee both fail here, with the same error the
  // rest of the domain gives them and no list metadata attached.
  const access = await requireWatchlistAccess({
    actorUserId: args.actorUserId,
    repository: args.repository,
    watchlistId: args.watchlistId,
  });

  if (access.watchlist.kind !== 'shared') {
    throw new WatchlistAccessError('Watchlist access denied.');
  }

  if (access.watchlist.ownerUserId === args.actorUserId) {
    throw new WatchlistAccessError(
      'A watchlist owner cannot leave their own watchlist.',
    );
  }

  const membership = await args.repository.findMembershipForUser(
    access.watchlist.id,
    args.actorUserId,
  );

  if (!membership || !membership.acceptedAt) {
    throw new WatchlistNotFoundError('Watchlist member not found.');
  }

  // The actor is not the owner, so a row still holding the owner role here is
  // inconsistent data rather than a membership this operation may delete.
  if (membership.role === 'owner' || membership.userId !== args.actorUserId) {
    throw new WatchlistAccessError('Watchlist access denied.');
  }

  const removed = await args.repository.removeMembershipFromWatchlist(
    access.watchlist.id,
    membership.id,
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
