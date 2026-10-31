import type { WatchlistItem } from './watchlist';

export const WATCHLIST_SORTS = [
  'added-newest', 'added-oldest', 'release-soonest', 'release-latest', 'title',
] as const;
export const WATCHLIST_FILTERS = ['all', 'upcoming', 'released'] as const;

export interface WatchlistView {
  sort: typeof WATCHLIST_SORTS[number];
  filter: typeof WATCHLIST_FILTERS[number];
}

export const DEFAULT_WATCHLIST_VIEW: WatchlistView = {
  sort: 'added-newest',
  filter: 'all',
};

export function parseWatchlistView(params: URLSearchParams): WatchlistView {
  const sort = params.get('sort');
  const filter = params.get('filter');

  return {
    sort: WATCHLIST_SORTS.find((value) => value === sort) ?? DEFAULT_WATCHLIST_VIEW.sort,
    filter: WATCHLIST_FILTERS.find((value) => value === filter) ?? DEFAULT_WATCHLIST_VIEW.filter,
  };
}

export function serializeWatchlistView(
  view: WatchlistView,
  currentParams = new URLSearchParams(),
): URLSearchParams {
  const params = new URLSearchParams(currentParams);

  for (const key of ['sort', 'filter'] as const) {
    if (view[key] === DEFAULT_WATCHLIST_VIEW[key]) {
      params.delete(key);
    } else {
      params.set(key, view[key]);
    }
  }

  return params;
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

export function selectWatchlistItems(
  items: readonly WatchlistItem[],
  view: WatchlistView,
  today: string,
): WatchlistItem[] {
  return items.filter((item) => {
    const releaseDate = item.movie.releaseDate;

    if (view.filter === 'all') return true;
    if (!releaseDate) return false;
    return view.filter === 'upcoming' ? releaseDate > today : releaseDate <= today;
  }).sort((left, right) => {
    let comparison = 0;

    switch (view.sort) {
      case 'added-newest':
        comparison = compareText(right.addedAt, left.addedAt);
        break;
      case 'added-oldest':
        comparison = compareText(left.addedAt, right.addedAt);
        break;
      case 'title':
        comparison = left.movie.title.localeCompare(right.movie.title, 'en', { sensitivity: 'base' });
        break;
      case 'release-soonest':
      case 'release-latest': {
        const leftDate = left.movie.releaseDate;
        const rightDate = right.movie.releaseDate;

        if (!leftDate && rightDate) return 1;
        if (leftDate && !rightDate) return -1;
        comparison = compareText(leftDate ?? '', rightDate ?? '');
        if (view.sort === 'release-latest') comparison *= -1;
        break;
      }
    }

    return comparison || compareText(left.id, right.id);
  });
}
