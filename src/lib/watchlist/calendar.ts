import { WatchlistAccessError, WatchlistNotFoundError } from './errors';
import { listWatchlistItems } from './items';
import { listUserWatchlists } from './shared';
import type {
  CalendarWatchlistItemCandidate,
  WatchlistItem,
  WatchlistRepository,
} from './types';

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

/**
 * Collects the items of one contributing watchlist, or `null` when the feed
 * owner's access to it ended between the accessible-list lookup and this read.
 *
 * A permanently deleted shared list (or a membership removed in the same
 * window) is an expected outcome of a request racing an owner's deletion, not a
 * feed failure: the list simply stops contributing, exactly as it will on every
 * later request. A `WatchlistDataError` is deliberately **not** caught — a
 * database fault must surface rather than silently shrink somebody's calendar.
 */
async function listContributingItems(args: {
  repository: WatchlistRepository;
  userId: string;
  watchlistId: string;
}): Promise<WatchlistItem[] | null> {
  try {
    return await listWatchlistItems({
      actorUserId: args.userId,
      repository: args.repository,
      watchlistId: args.watchlistId,
    });
  } catch (error) {
    if (
      error instanceof WatchlistNotFoundError
      || error instanceof WatchlistAccessError
    ) {
      return null;
    }

    throw error;
  }
}

export async function listCalendarWatchlistItems(args: {
  repository: WatchlistRepository;
  userId: string;
}): Promise<WatchlistItem[]> {
  const watchlists = await listUserWatchlists(args);
  const candidates: CalendarWatchlistItemCandidate[] = [];

  for (const watchlist of watchlists) {
    const items = await listContributingItems({
      repository: args.repository,
      userId: args.userId,
      watchlistId: watchlist.id,
    });

    if (!items) {
      continue;
    }

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
