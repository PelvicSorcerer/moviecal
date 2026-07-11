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
