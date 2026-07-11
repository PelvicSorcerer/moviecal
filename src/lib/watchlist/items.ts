import type { NormalizedMovieDetail } from '../tmdb/client';

import {
  WatchlistAccessError,
  WatchlistDataError,
  WatchlistInputError,
  WatchlistNotFoundError,
} from './errors';
import type {
  AddWatchlistItemResult,
  AuthorizedWatchlistAccess,
  WatchlistDetail,
  WatchlistItem,
  WatchlistRepository,
  WatchlistRow,
} from './types';

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

export function normalizeSharedWatchlistName(name: string): string {
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

export async function requireWatchlistAccess(args: {
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
