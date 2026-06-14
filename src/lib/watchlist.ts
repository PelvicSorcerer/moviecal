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

export interface WatchlistRepository {
  deleteItemByIdForUser(userId: string, itemId: string): Promise<boolean>;
  findItemByMovieIdForUser(
    userId: string,
    movieId: number,
  ): Promise<WatchlistRow | null>;
  insertItemForUser(
    userId: string,
    movieId: number,
  ): Promise<{ errorCode: string | null; row: WatchlistRow | null }>;
  listItemsForUser(userId: string): Promise<WatchlistRow[]>;
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

export class WatchlistDataError extends Error {
  readonly status = 500;

  constructor(message: string) {
    super(message);
    this.name = 'WatchlistDataError';
  }
}

export interface AddWatchlistItemResult {
  created: boolean;
  item: WatchlistItem;
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
  repository: WatchlistRepository;
  userId: string;
}): Promise<WatchlistItem[]> {
  const rows = await args.repository.listItemsForUser(args.userId);

  return rows.map(mapWatchlistRow);
}

export async function addWatchlistItem(args: {
  getMovieDetails(tmdbId: number): Promise<NormalizedMovieDetail>;
  repository: WatchlistRepository;
  tmdbId: number;
  userId: string;
}): Promise<AddWatchlistItemResult> {
  assertTmdbId(args.tmdbId);

  const detail = await args.getMovieDetails(args.tmdbId);
  const movie = await args.repository.upsertMovie(detail);
  const insertResult = await args.repository.insertItemForUser(
    args.userId,
    movie.id,
  );

  if (insertResult.row) {
    return {
      created: true,
      item: mapWatchlistRow(insertResult.row),
    };
  }

  if (insertResult.errorCode === '23505') {
    const existingRow = await args.repository.findItemByMovieIdForUser(
      args.userId,
      movie.id,
    );

    if (existingRow) {
      return {
        created: false,
        item: mapWatchlistRow(existingRow),
      };
    }
  }

  throw new WatchlistDataError('Could not save watchlist item.');
}

export async function removeWatchlistItem(args: {
  itemId: string;
  repository: WatchlistRepository;
  userId: string;
}): Promise<void> {
  const deleted = await args.repository.deleteItemByIdForUser(
    args.userId,
    args.itemId,
  );

  if (!deleted) {
    throw new WatchlistNotFoundError('Watchlist item not found.');
  }
}
