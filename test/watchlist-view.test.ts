import { describe, expect, it } from 'vitest';

import {
  DEFAULT_WATCHLIST_VIEW,
  parseWatchlistView,
  selectWatchlistItems,
  serializeWatchlistView,
  WATCHLIST_FILTERS,
  WATCHLIST_SORTS,
} from '../src/lib/watchlist-view';
import { buildWatchlistItem, buildWatchlistMovie } from './support';

const today = '2026-06-20';
const items = [
  buildWatchlistItem({
    id: 'future', addedAt: '2026-06-19T12:00:00.000Z',
    movie: buildWatchlistMovie(undefined, { title: 'Bravo', releaseDate: '2026-06-21' }),
  }),
  buildWatchlistItem({
    id: 'past', addedAt: '2026-06-18T12:00:00.000Z',
    movie: buildWatchlistMovie(undefined, { title: 'Charlie', releaseDate: '2026-06-19' }),
  }),
  buildWatchlistItem({
    id: 'today', addedAt: '2026-06-20T12:00:00.000Z',
    movie: buildWatchlistMovie(undefined, { title: 'Alpha', releaseDate: today }),
  }),
  buildWatchlistItem({
    id: 'unknown', addedAt: '2026-06-17T12:00:00.000Z',
    movie: buildWatchlistMovie(undefined, { title: 'Delta', releaseDate: null }),
  }),
];

describe('watchlist view', () => {
  it.each([
    ['added-newest', ['today', 'future', 'past', 'unknown']],
    ['added-oldest', ['unknown', 'past', 'future', 'today']],
    ['release-soonest', ['past', 'today', 'future', 'unknown']],
    ['release-latest', ['future', 'today', 'past', 'unknown']],
    ['title', ['today', 'future', 'past', 'unknown']],
  ] as const)('orders by %s without mutating input', (sort, expected) => {
    const original = [...items];
    expect(selectWatchlistItems(items, { sort, filter: 'all' }, today).map((item) => item.id))
      .toEqual(expected);
    expect(items).toEqual(original);
  });

  it.each([
    ['all', ['today', 'future', 'past', 'unknown']],
    ['upcoming', ['future']],
    ['released', ['today', 'past']],
  ] as const)('filters %s at the injected UTC date', (filter, expected) => {
    expect(selectWatchlistItems(items, { sort: 'added-newest', filter }, today).map((item) => item.id))
      .toEqual(expected);
  });

  it('uses the injected date rather than the system clock', () => {
    expect(selectWatchlistItems(items, { sort: 'title', filter: 'upcoming' }, '2026-06-18'))
      .toHaveLength(3);
    expect(selectWatchlistItems(items, { sort: 'title', filter: 'upcoming' }, '2026-06-21'))
      .toEqual([]);
  });

  it.each(WATCHLIST_SORTS)('breaks equal keys deterministically by item ID for %s', (sort) => {
    const first = buildWatchlistItem({ id: 'first' });
    const second = buildWatchlistItem({ id: 'second' });
    expect(selectWatchlistItems([second, first], { sort, filter: 'all' }, today))
      .toEqual([first, second]);
    expect(selectWatchlistItems([first, second], { sort, filter: 'all' }, today))
      .toEqual([first, second]);
  });

  it.each(['release-soonest', 'release-latest'] as const)('groups multiple undated movies last for %s', (sort) => {
    const undated = buildWatchlistItem({
      id: 'another-unknown', movie: buildWatchlistMovie(undefined, { releaseDate: null }),
    });
    expect(selectWatchlistItems([items[3], undated, items[0]], { sort, filter: 'all' }, today)
      .map((item) => item.id)).toEqual(['future', 'another-unknown', 'unknown']);
  });

  it('sorts titles alphabetically without case sensitivity', () => {
    const lower = buildWatchlistItem({
      id: 'lower', movie: buildWatchlistMovie(undefined, { title: 'alpha' }),
    });
    expect(selectWatchlistItems([items[0], lower], { sort: 'title', filter: 'all' }, today))
      .toEqual([lower, items[0]]);
  });

  it('handles an empty watchlist', () => {
    expect(selectWatchlistItems([], DEFAULT_WATCHLIST_VIEW, today)).toEqual([]);
  });
});

describe('watchlist URL state', () => {
  it.each(['', 'sort=invalid&filter=invalid', 'sort=&filter=', 'sort=TITLE&filter=ALL'])
    ('falls back to defaults for %s', (query) => {
      expect(parseWatchlistView(new URLSearchParams(query))).toEqual(DEFAULT_WATCHLIST_VIEW);
    });

  it('validates each parameter independently', () => {
    expect(parseWatchlistView(new URLSearchParams('sort=title&filter=bad')))
      .toEqual({ sort: 'title', filter: 'all' });
    expect(parseWatchlistView(new URLSearchParams('sort=bad&filter=released')))
      .toEqual({ sort: 'added-newest', filter: 'released' });
  });

  it.each(WATCHLIST_SORTS)('round-trips every filter with %s', (sort) => {
    for (const filter of WATCHLIST_FILTERS) {
      const view = { sort, filter };
      expect(parseWatchlistView(serializeWatchlistView(view))).toEqual(view);
    }
  });

  it('omits defaults and preserves unrelated parameters without mutating the source', () => {
    const source = new URLSearchParams('sort=bad&filter=upcoming&other=keep');
    expect(serializeWatchlistView(DEFAULT_WATCHLIST_VIEW, source).toString()).toBe('other=keep');
    expect(source.toString()).toBe('sort=bad&filter=upcoming&other=keep');
    expect(serializeWatchlistView({ sort: 'title', filter: 'released' }, source).toString())
      .toBe('sort=title&filter=released&other=keep');
  });
});
