import { describe, expect, it } from 'vitest';

import {
  TEST_ITEM_IDS,
  TEST_TIMESTAMPS,
  TEST_TMDB_IDS,
  TEST_USER_IDS,
  TEST_WATCHLIST_IDS,
} from '../src/lib/test-data/catalog';
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  decodePageCursor,
  encodePageCursor,
  listAuthorizedWatchlists,
  mapWatchlistRow,
  orderWatchlistItemsForRead,
  paginateById,
  parsePageRequest,
  toUtcIsoString,
  WatchlistInputError,
  type WatchlistItem,
} from '../src/lib/watchlist';
import {
  buildWatchlistItem,
  buildWatchlistRow,
  createSharedWatchlistReadRepository,
} from './support';

const FIRST_PAGE = { cursor: null, limit: DEFAULT_PAGE_LIMIT };

function item(id: string, addedAt: string): WatchlistItem {
  return buildWatchlistItem({ addedAt, id });
}

describe('watchlist read views shared by the cookie and bearer surfaces', () => {
  describe('orderWatchlistItemsForRead', () => {
    it('orders newest first and breaks an addedAt tie by ascending id', () => {
      const ordered = orderWatchlistItemsForRead([
        item('item-b', TEST_TIMESTAMPS.ITEM_ADDED_AT),
        item('item-c', TEST_TIMESTAMPS.MATRIX_ADDED_AT),
        item('item-a', TEST_TIMESTAMPS.ITEM_ADDED_AT),
      ]);

      expect(ordered.map((entry) => entry.id)).toEqual([
        'item-c',
        'item-a',
        'item-b',
      ]);
    });

    it('does not mutate the caller list', () => {
      const items = [
        item('item-b', TEST_TIMESTAMPS.ITEM_ADDED_AT),
        item('item-a', TEST_TIMESTAMPS.MATRIX_ADDED_AT),
      ];

      orderWatchlistItemsForRead(items);

      expect(items.map((entry) => entry.id)).toEqual(['item-b', 'item-a']);
    });
  });

  describe('toUtcIsoString', () => {
    it('normalizes a Postgres +00:00 timestamp to UTC ISO-8601', () => {
      expect(toUtcIsoString('2026-06-18T12:00:00+00:00')).toBe(
        TEST_TIMESTAMPS.MATRIX_ADDED_AT,
      );
    });

    it('leaves an already-normalized timestamp unchanged', () => {
      expect(toUtcIsoString(TEST_TIMESTAMPS.ITEM_ADDED_AT)).toBe(
        TEST_TIMESTAMPS.ITEM_ADDED_AT,
      );
    });

    it('passes an unparseable value through instead of throwing on a read', () => {
      expect(toUtcIsoString('not-a-timestamp')).toBe('not-a-timestamp');
    });

    it('preserves the personal API timestamp spelling when mapping a row', () => {
      const mapped = mapWatchlistRow(
        buildWatchlistRow(TEST_TMDB_IDS.MATRIX, {
          added_at: '2026-06-18T12:00:00+00:00',
        }),
      );

      expect(mapped.addedAt).toBe('2026-06-18T12:00:00+00:00');
    });
  });
});

describe('cursor pagination', () => {
  const entries = ['a', 'b', 'c', 'd'].map((id) => ({ id }));
  const idOf = (entry: { id: string }) => entry.id;

  it('defaults to the documented page size with no cursor', () => {
    expect(parsePageRequest(new URLSearchParams())).toEqual({
      cursor: null,
      limit: DEFAULT_PAGE_LIMIT,
    });
  });

  it('accepts an explicit in-range limit and cursor', () => {
    expect(
      parsePageRequest(new URLSearchParams({ cursor: 'Yg', limit: '10' })),
    ).toEqual({ cursor: 'Yg', limit: 10 });
  });

  it.each(['0', '-1', String(MAX_PAGE_LIMIT + 1), '1.5', 'ten'])(
    'rejects the out-of-contract limit %j rather than clamping it',
    (limit) => {
      expect(() => parsePageRequest(new URLSearchParams({ limit }))).toThrow(
        WatchlistInputError,
      );
    },
  );

  it.each(['', ' '])('treats the blank limit %j as absent', (limit) => {
    expect(parsePageRequest(new URLSearchParams({ cursor: '', limit }))).toEqual({
      cursor: null,
      limit: DEFAULT_PAGE_LIMIT,
    });
  });

  it('round-trips an opaque cursor', () => {
    expect(decodePageCursor(encodePageCursor(TEST_ITEM_IDS.MATRIX))).toBe(
      TEST_ITEM_IDS.MATRIX,
    );
  });

  it.each(['not base64url!', '', 'YQ=='])(
    'rejects the malformed cursor %j',
    (cursor) => {
      expect(() => decodePageCursor(cursor)).toThrow(WatchlistInputError);
    },
  );

  it('returns the first page with a cursor onto the next one', () => {
    const page = paginateById(entries, idOf, { cursor: null, limit: 2 });

    expect(page.entries.map(idOf)).toEqual(['a', 'b']);
    expect(page.nextCursor).toBe(encodePageCursor('b'));
  });

  it('resumes strictly after the cursor and stops with a null cursor', () => {
    const page = paginateById(entries, idOf, {
      cursor: encodePageCursor('b'),
      limit: 2,
    });

    expect(page.entries.map(idOf)).toEqual(['c', 'd']);
    expect(page.nextCursor).toBeNull();
  });

  it('reports a cursor whose row has left the collection as caller input error', () => {
    expect(() =>
      paginateById(entries, idOf, { cursor: encodePageCursor('gone'), limit: 2 }),
    ).toThrow(WatchlistInputError);
  });
});

// Summary pagination must not inherit unstable repository order.
it('orders shared summaries by stable ID after the personal list', async () => {
  const base = createSharedWatchlistReadRepository();
  const lists = await base.listWatchlistsForUser(TEST_USER_IDS.OWNER);
  const result = await listAuthorizedWatchlists({
    page: FIRST_PAGE, userId: TEST_USER_IDS.OWNER,
    repository: createSharedWatchlistReadRepository({
      async listWatchlistsForUser() {
        return [{ ...lists[1], id: 'z' }, { ...lists[1], id: 'a' }, lists[0]];
      },
    }),
  });
  expect(result.watchlists.map(w => w.id)).toEqual([TEST_WATCHLIST_IDS.PERSONAL, 'a', 'z']);
});
