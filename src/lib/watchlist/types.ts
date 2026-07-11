import type { Json } from '../supabase/database';
import type { NormalizedMovieDetail } from '../tmdb/client';

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

export interface AddWatchlistItemResult {
  created: boolean;
  item: WatchlistItem;
  watchlist: WatchlistSummary;
}

export interface WatchlistDetail {
  items: WatchlistItem[];
  watchlist: WatchlistSummary;
}

export type CalendarWatchlistItemCandidate = {
  item: WatchlistItem;
  watchlistId: string;
  watchlistKind: WatchlistKind;
};
