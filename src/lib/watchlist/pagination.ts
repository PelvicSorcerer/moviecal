import { WatchlistInputError } from './errors';


export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 100;

export interface PageRequest {
  cursor: string | null;
  limit: number;
}

export interface Page<TEntry> {
  entries: TEntry[];
  limit: number;
  nextCursor: string | null;
}

export interface PageParamReader {
  get(name: string): string | null;
}

export function encodePageCursor(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}

export function decodePageCursor(cursor: string): string {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');

  if (!decoded || encodePageCursor(decoded) !== cursor) {
    throw new WatchlistInputError('Invalid pagination cursor.');
  }

  return decoded;
}

export function parsePageRequest(params: PageParamReader): PageRequest {
  const rawLimit = params.get('limit')?.trim() ?? '';
  const rawCursor = params.get('cursor')?.trim() ?? '';

  if (rawLimit && !/^\d+$/.test(rawLimit)) {
    throw new WatchlistInputError(
      `Pagination limit must be an integer between 1 and ${MAX_PAGE_LIMIT}.`,
    );
  }

  const limit = rawLimit ? Number.parseInt(rawLimit, 10) : DEFAULT_PAGE_LIMIT;

  if (limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new WatchlistInputError(
      `Pagination limit must be an integer between 1 and ${MAX_PAGE_LIMIT}.`,
    );
  }

  return {
    cursor: rawCursor || null,
    limit,
  };
}

export function paginateById<TEntry>(
  entries: TEntry[],
  idOf: (entry: TEntry) => string,
  request: PageRequest,
): Page<TEntry> {
  let start = 0;

  if (request.cursor) {
    const cursorId = decodePageCursor(request.cursor);
    const cursorIndex = entries.findIndex((entry) => idOf(entry) === cursorId);

    if (cursorIndex === -1) {
      throw new WatchlistInputError('Invalid pagination cursor.');
    }

    start = cursorIndex + 1;
  }

  const end = start + request.limit;
  const pageEntries = entries.slice(start, end);
  const lastEntry = pageEntries.length
    ? pageEntries[pageEntries.length - 1]
    : undefined;

  return {
    entries: pageEntries,
    limit: request.limit,
    nextCursor:
      lastEntry && end < entries.length ? encodePageCursor(idOf(lastEntry)) : null,
  };
}
