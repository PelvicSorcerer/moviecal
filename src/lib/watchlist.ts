import { createHash, randomBytes } from 'node:crypto';

import type { Json } from './supabase/database';
import type { NormalizedMovieDetail } from './tmdb/client';

export interface WatchlistMovie {
  id: number;
  overview: string | null;
  posterPath: string | null;
  releaseDate: string | null;
  title: string;
  tmdbId: number;
}

export interface WatchlistItem {
  addedAt: string;
  id: string;
  movie: WatchlistMovie;
}

export type WatchlistKind = 'personal' | 'shared';
export type WatchlistMembershipRole = 'owner' | 'editor';

export interface WatchlistSummary {
  canEdit: boolean;
  id: string;
  kind: WatchlistKind;
  name: string;
  ownerUserId: string;
}

export interface WatchlistMember {
  acceptedAt: string | null;
  id: string;
  invitedByUserId: string | null;
  role: WatchlistMembershipRole;
  userId: string;
  watchlistId: string;
}

export interface WatchlistInviteLink {
  createdAt: string;
  createdByUserId: string;
  expiresAt: string | null;
  id: string;
  revokedAt: string | null;
  watchlistId: string;
}

export interface ResolvedWatchlistInvite {
  inviteLink: WatchlistInviteLink;
  watchlist: WatchlistSummary;
}

export interface WatchlistMovieRow {
  id: number;
  raw_json: Json;
  release_date: string | null;
  title: string;
  tmdb_id: number;
  updated_at: string;
}

export interface WatchlistRow {
  added_at: string;
  id: string;
  movie: WatchlistMovieRow | null;
}

export interface AuthorizedWatchlistAccess {
  canEdit: boolean;
  status: 'authorized';
  watchlist: WatchlistSummary;
}

export type WatchlistAccessResult =
  | AuthorizedWatchlistAccess
  | { status: 'forbidden' }
  | { status: 'not_found' };

export interface AcceptedWatchlistInviteResult {
  joined: boolean;
  watchlist: WatchlistSummary;
}

export interface CreatedWatchlistInviteLinkResult {
  inviteUrl: string;
  watchlist: WatchlistSummary;
}

export interface WatchlistRepository {
  createWatchlist(args: {
    kind: WatchlistKind;
    name: string;
    ownerUserId: string;
  }): Promise<WatchlistSummary>;
  deleteItemByIdForWatchlist(
    watchlistId: string,
    itemId: string,
  ): Promise<boolean>;
  ensurePersonalWatchlist(userId: string): Promise<WatchlistSummary>;
  acceptInviteMembership(args: {
    acceptedAt: string;
    invitedByUserId: string | null;
    userId: string;
    watchlistId: string;
  }): Promise<WatchlistMember>;
  createInviteLink(args: {
    createdByUserId: string;
    expiresAt: string | null;
    tokenHash: string;
    watchlistId: string;
  }): Promise<WatchlistInviteLink>;
  findItemByMovieIdForWatchlist(
    watchlistId: string,
    movieId: number,
  ): Promise<WatchlistRow | null>;
  findMembershipForUser(
    watchlistId: string,
    userId: string,
  ): Promise<WatchlistMember | null>;
  findInviteLinkByTokenHash(
    tokenHash: string,
  ): Promise<ResolvedWatchlistInvite | null>;
  getActiveInviteLinkForWatchlist(
    watchlistId: string,
  ): Promise<WatchlistInviteLink | null>;
  getWatchlistAccess(
    actorUserId: string,
    watchlistId: string,
  ): Promise<WatchlistAccessResult>;
  insertItemForWatchlist(
    watchlistId: string,
    movieId: number,
  ): Promise<{ errorCode: string | null; row: WatchlistRow | null }>;
  listItemsForWatchlist(watchlistId: string): Promise<WatchlistRow[]>;
  listMembersForWatchlist(watchlistId: string): Promise<WatchlistMember[]>;
  listTrackedMovies(): Promise<WatchlistMovieRow[]>;
  listWatchlistsForUser(userId: string): Promise<WatchlistSummary[]>;
  revokeInviteLinksForWatchlist(watchlistId: string): Promise<void>;
  removeMembershipFromWatchlist(
    watchlistId: string,
    membershipId: string,
  ): Promise<boolean>;
  upsertMovie(detail: NormalizedMovieDetail): Promise<{ id: number }>;
}

export class WatchlistInputError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = 'WatchlistInputError';
  }
}

export class WatchlistNotFoundError extends Error {
  readonly status = 404;

  constructor(message: string) {
    super(message);
    this.name = 'WatchlistNotFoundError';
  }
}

export class WatchlistAccessError extends Error {
  readonly status = 403;

  constructor(
    message: string,
    readonly reason: 'forbidden' | 'not_found' = 'forbidden',
  ) {
    super(message);
    this.name = 'WatchlistAccessError';
  }
}

export class WatchlistDataError extends Error {
  readonly status = 500;

  constructor(message: string) {
    super(message);
    this.name = 'WatchlistDataError';
  }
}

export function hashWatchlistInviteToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function createWatchlistInviteToken(): string {
  return randomBytes(24).toString('base64url');
}

export interface AddWatchlistItemResult {
  created: boolean;
  item: WatchlistItem;
  watchlist: WatchlistSummary;
}

export interface WatchlistDetail {
  items: WatchlistItem[];
  watchlist: WatchlistSummary;
}

function readOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmedValue = value.trim();

  return trimmedValue ? trimmedValue : null;
}

function assertTmdbId(tmdbId: number): void {
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) {
    throw new WatchlistInputError('A valid tmdb_id is required.');
  }
}

function normalizeSharedWatchlistName(name: string): string {
  const normalizedName = name.trim().replace(/\s+/g, ' ');

  if (!normalizedName) {
    throw new WatchlistInputError('A shared watchlist name is required.');
  }

  if (normalizedName.length > 80) {
    throw new WatchlistInputError(
      'Shared watchlist names must be 80 characters or fewer.',
    );
  }

  return normalizedName;
}

export function mapWatchlistRow(row: WatchlistRow): WatchlistItem {
  if (!row.movie) {
    throw new WatchlistDataError('Watchlist item is missing movie metadata.');
  }

  const metadata =
    typeof row.movie.raw_json === 'object' &&
    row.movie.raw_json !== null &&
    !Array.isArray(row.movie.raw_json)
      ? row.movie.raw_json
      : {};

  return {
    id: row.id,
    addedAt: row.added_at,
    movie: {
      id: row.movie.id,
      tmdbId: row.movie.tmdb_id,
      title: row.movie.title,
      releaseDate: row.movie.release_date,
      posterPath: readOptionalString(metadata.poster_path),
      overview: readOptionalString(metadata.overview),
    },
  };
}

export async function listWatchlistItems(args: {
  actorUserId: string;
  repository: WatchlistRepository;
  watchlistId: string;
}): Promise<WatchlistItem[]> {
  await requireWatchlistAccess({
    actorUserId: args.actorUserId,
    repository: args.repository,
    watchlistId: args.watchlistId,
  });
  const rows = await args.repository.listItemsForWatchlist(args.watchlistId);

  return rows.map(mapWatchlistRow);
}

export async function getWatchlistDetail(args: {
  actorUserId: string;
  repository: WatchlistRepository;
  watchlistId: string;
}): Promise<WatchlistDetail> {
  const watchlistAccess = await requireWatchlistAccess({
    actorUserId: args.actorUserId,
    repository: args.repository,
    watchlistId: args.watchlistId,
  });
  const rows = await args.repository.listItemsForWatchlist(
    watchlistAccess.watchlist.id,
  );

  return {
    watchlist: watchlistAccess.watchlist,
    items: rows.map(mapWatchlistRow),
  };
}

export async function addWatchlistItem(args: {
  actorUserId: string;
  getMovieDetails(tmdbId: number): Promise<NormalizedMovieDetail>;
  repository: WatchlistRepository;
  tmdbId: number;
  watchlistId: string;
}): Promise<AddWatchlistItemResult> {
  assertTmdbId(args.tmdbId);
  const watchlistAccess = await requireWatchlistAccess({
    actorUserId: args.actorUserId,
    repository: args.repository,
    requireEdit: true,
    watchlistId: args.watchlistId,
  });

  const detail = await args.getMovieDetails(args.tmdbId);
  const movie = await args.repository.upsertMovie(detail);
  const insertResult = await args.repository.insertItemForWatchlist(
    watchlistAccess.watchlist.id,
    movie.id,
  );

  if (insertResult.row) {
    return {
      created: true,
      item: mapWatchlistRow(insertResult.row),
      watchlist: watchlistAccess.watchlist,
    };
  }

  if (insertResult.errorCode === '23505') {
    const existingRow = await args.repository.findItemByMovieIdForWatchlist(
      watchlistAccess.watchlist.id,
      movie.id,
    );

    if (existingRow) {
      return {
        created: false,
        item: mapWatchlistRow(existingRow),
        watchlist: watchlistAccess.watchlist,
      };
    }
  }

  throw new WatchlistDataError('Could not save watchlist item.');
}

export async function removeWatchlistItem(args: {
  actorUserId: string;
  itemId: string;
  repository: WatchlistRepository;
  watchlistId: string;
}): Promise<void> {
  const watchlistAccess = await requireWatchlistAccess({
    actorUserId: args.actorUserId,
    repository: args.repository,
    requireEdit: true,
    watchlistId: args.watchlistId,
  });
  const deleted = await args.repository.deleteItemByIdForWatchlist(
    watchlistAccess.watchlist.id,
    args.itemId,
  );

  if (!deleted) {
    throw new WatchlistNotFoundError('Watchlist item not found.');
  }
}

export type CalendarWatchlistItemCandidate = {
  item: WatchlistItem;
  watchlistId: string;
  watchlistKind: WatchlistKind;
};

export function compareCalendarWatchlistItemCandidates(
  left: CalendarWatchlistItemCandidate,
  right: CalendarWatchlistItemCandidate,
): number {
  if (left.watchlistKind !== right.watchlistKind) {
    if (left.watchlistKind === 'personal') {
      return -1;
    }

    if (right.watchlistKind === 'personal') {
      return 1;
    }
  }

  const addedAtCompare = left.item.addedAt.localeCompare(right.item.addedAt);

  if (addedAtCompare !== 0) {
    return addedAtCompare;
  }

  return left.item.id.localeCompare(right.item.id);
}

export function dedupeCalendarWatchlistItems(
  candidates: CalendarWatchlistItemCandidate[],
): WatchlistItem[] {
  const winnersByTmdbId = new Map<number, CalendarWatchlistItemCandidate>();

  for (const candidate of candidates) {
    const existing = winnersByTmdbId.get(candidate.item.movie.tmdbId);

    if (
      !existing
      || compareCalendarWatchlistItemCandidates(candidate, existing) < 0
    ) {
      winnersByTmdbId.set(candidate.item.movie.tmdbId, candidate);
    }
  }

  return [...winnersByTmdbId.values()].map((candidate) => candidate.item);
}

export async function listCalendarWatchlistItems(args: {
  repository: WatchlistRepository;
  userId: string;
}): Promise<WatchlistItem[]> {
  const watchlists = await listUserWatchlists(args);
  const candidates: CalendarWatchlistItemCandidate[] = [];

  for (const watchlist of watchlists) {
    const items = await listWatchlistItems({
      actorUserId: args.userId,
      repository: args.repository,
      watchlistId: watchlist.id,
    });

    for (const item of items) {
      candidates.push({
        item,
        watchlistId: watchlist.id,
        watchlistKind: watchlist.kind,
      });
    }
  }

  return dedupeCalendarWatchlistItems(candidates);
}

export async function listPersonalWatchlistItems(args: {
  repository: WatchlistRepository;
  userId: string;
}): Promise<WatchlistItem[]> {
  const watchlist = await args.repository.ensurePersonalWatchlist(args.userId);

  return listWatchlistItems({
    actorUserId: args.userId,
    repository: args.repository,
    watchlistId: watchlist.id,
  });
}

export async function addPersonalWatchlistItem(args: {
  getMovieDetails(tmdbId: number): Promise<NormalizedMovieDetail>;
  repository: WatchlistRepository;
  tmdbId: number;
  userId: string;
}): Promise<AddWatchlistItemResult> {
  const watchlist = await args.repository.ensurePersonalWatchlist(args.userId);

  return addWatchlistItem({
    actorUserId: args.userId,
    getMovieDetails: args.getMovieDetails,
    repository: args.repository,
    tmdbId: args.tmdbId,
    watchlistId: watchlist.id,
  });
}

export async function removePersonalWatchlistItem(args: {
  itemId: string;
  repository: WatchlistRepository;
  userId: string;
}): Promise<void> {
  const watchlist = await args.repository.ensurePersonalWatchlist(args.userId);

  return removeWatchlistItem({
    actorUserId: args.userId,
    itemId: args.itemId,
    repository: args.repository,
    watchlistId: watchlist.id,
  });
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

async function requireWatchlistAccess(args: {
  actorUserId: string;
  repository: WatchlistRepository;
  requireEdit?: boolean;
  watchlistId: string;
}): Promise<AuthorizedWatchlistAccess> {
  const access = await args.repository.getWatchlistAccess(
    args.actorUserId,
    args.watchlistId,
  );

  if (access.status === 'not_found') {
    throw new WatchlistNotFoundError('Watchlist not found.');
  }

  if (access.status === 'forbidden') {
    throw new WatchlistAccessError('Watchlist access denied.');
  }

  if (args.requireEdit && !access.canEdit) {
    throw new WatchlistAccessError('Watchlist access denied.');
  }

  return access;
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
