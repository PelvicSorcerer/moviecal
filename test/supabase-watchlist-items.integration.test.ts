import { describe, expect, it, vi } from 'vitest';
import type { PostgrestError } from '@supabase/supabase-js';

import type { ServerSupabaseClient } from '../src/lib/supabase/server';
import { createItemsAggregate } from '../src/lib/supabase/watchlist/items';
import { WatchlistDataError } from '../src/lib/watchlist';

const SUPABASE_ERROR: PostgrestError = {
  code: 'P0001',
  message: 'DB error',
  details: '',
  hint: '',
  name: 'PostgrestError',
};

const VALID_MOVIE_ROW = {
  id: 42,
  tmdb_id: 603,
  title: 'The Matrix',
  release_date: '1999-03-31',
  raw_json: { id: 603 },
  updated_at: '2026-06-13T05:00:00.000Z',
};

const VALID_WATCHLIST_ROW = {
  id: 'item-1',
  added_at: '2026-06-13T05:00:00.000Z',
  movie: VALID_MOVIE_ROW,
};

function makeChain(result: { data: unknown; error: PostgrestError | null }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: Record<string, any> = {
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    upsert: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    not: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue(result),
    maybeSingle: vi.fn().mockResolvedValue(result),
    then: (resolve: (v: typeof result) => void) => Promise.resolve(result).then(resolve),
    catch: (reject: (e: unknown) => void) => Promise.resolve(result).catch(reject),
  };
  return chain;
}

function mockClient(result: { data: unknown; error: PostgrestError | null }) {
  return {
    from: vi.fn(() => makeChain(result)),
  } as unknown as ServerSupabaseClient;
}

describe('createItemsAggregate — listItemsForWatchlist', () => {
  it('returns an array of mapped WatchlistRows', async () => {
    const adminClient = mockClient({ data: [VALID_WATCHLIST_ROW], error: null });
    const { listItemsForWatchlist } = createItemsAggregate({
      adminClient,
      userClient: adminClient,
    });

    const result = await listItemsForWatchlist('watchlist-1');

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('item-1');
    expect(adminClient.from).toHaveBeenCalledWith('watchlist_items');
  });

  it('throws WatchlistDataError on a PostgrestError', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const adminClient = mockClient({ data: null, error: SUPABASE_ERROR });
    const { listItemsForWatchlist } = createItemsAggregate({
      adminClient,
      userClient: adminClient,
    });

    await expect(listItemsForWatchlist('watchlist-1')).rejects.toThrow(WatchlistDataError);
    consoleSpy.mockRestore();
  });
});

describe('createItemsAggregate — findItemByMovieIdForWatchlist', () => {
  it('returns a WatchlistRow when found', async () => {
    const adminClient = mockClient({ data: VALID_WATCHLIST_ROW, error: null });
    const { findItemByMovieIdForWatchlist } = createItemsAggregate({
      adminClient,
      userClient: adminClient,
    });

    const result = await findItemByMovieIdForWatchlist('watchlist-1', 42);

    expect(result).not.toBeNull();
    expect(result!.id).toBe('item-1');
    expect(adminClient.from).toHaveBeenCalledWith('watchlist_items');
  });

  it('returns null when no row found', async () => {
    const adminClient = mockClient({ data: null, error: null });
    const { findItemByMovieIdForWatchlist } = createItemsAggregate({
      adminClient,
      userClient: adminClient,
    });

    await expect(findItemByMovieIdForWatchlist('watchlist-1', 42)).resolves.toBeNull();
  });

  it('throws WatchlistDataError on a PostgrestError', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const adminClient = mockClient({ data: null, error: SUPABASE_ERROR });
    const { findItemByMovieIdForWatchlist } = createItemsAggregate({
      adminClient,
      userClient: adminClient,
    });

    await expect(findItemByMovieIdForWatchlist('watchlist-1', 42)).rejects.toThrow(
      WatchlistDataError,
    );
    consoleSpy.mockRestore();
  });
});

describe('createItemsAggregate — insertItemForWatchlist', () => {
  it('returns the inserted row on success', async () => {
    const adminClient = mockClient({ data: VALID_WATCHLIST_ROW, error: null });
    const { insertItemForWatchlist } = createItemsAggregate({
      adminClient,
      userClient: adminClient,
    });

    const result = await insertItemForWatchlist('watchlist-1', 42);

    expect(result.errorCode).toBeNull();
    expect(result.row).not.toBeNull();
    expect(result.row!.id).toBe('item-1');
    expect(adminClient.from).toHaveBeenCalledWith('watchlist_items');
  });

  it('returns the error code without throwing on a Supabase error', async () => {
    const adminClient = mockClient({ data: null, error: SUPABASE_ERROR });
    const { insertItemForWatchlist } = createItemsAggregate({
      adminClient,
      userClient: adminClient,
    });

    const result = await insertItemForWatchlist('watchlist-1', 42);

    expect(result.row).toBeNull();
    expect(result.errorCode).toBe('P0001');
  });
});

describe('createItemsAggregate — deleteItemByIdForWatchlist', () => {
  it('returns true when a row was deleted', async () => {
    const adminClient = mockClient({ data: { id: 'item-1' }, error: null });
    const { deleteItemByIdForWatchlist } = createItemsAggregate({
      adminClient,
      userClient: adminClient,
    });

    await expect(deleteItemByIdForWatchlist('watchlist-1', 'item-1')).resolves.toBe(true);
    expect(adminClient.from).toHaveBeenCalledWith('watchlist_items');
  });

  it('returns false when no row matched', async () => {
    const adminClient = mockClient({ data: null, error: null });
    const { deleteItemByIdForWatchlist } = createItemsAggregate({
      adminClient,
      userClient: adminClient,
    });

    await expect(deleteItemByIdForWatchlist('watchlist-1', 'item-1')).resolves.toBe(false);
  });

  it('throws WatchlistDataError on a PostgrestError', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const adminClient = mockClient({ data: null, error: SUPABASE_ERROR });
    const { deleteItemByIdForWatchlist } = createItemsAggregate({
      adminClient,
      userClient: adminClient,
    });

    await expect(deleteItemByIdForWatchlist('watchlist-1', 'item-1')).rejects.toThrow(
      WatchlistDataError,
    );
    consoleSpy.mockRestore();
  });
});

describe('createItemsAggregate — listTrackedMovies', () => {
  it('returns unique movie rows', async () => {
    const trackedRow = { movie: VALID_MOVIE_ROW };
    const adminClient = mockClient({ data: [trackedRow], error: null });
    const { listTrackedMovies } = createItemsAggregate({
      adminClient,
      userClient: adminClient,
    });

    const result = await listTrackedMovies();

    expect(result).toHaveLength(1);
    expect(result[0].tmdb_id).toBe(603);
    expect(adminClient.from).toHaveBeenCalledWith('watchlist_items');
  });

  it('throws WatchlistDataError on a PostgrestError', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const adminClient = mockClient({ data: null, error: SUPABASE_ERROR });
    const { listTrackedMovies } = createItemsAggregate({
      adminClient,
      userClient: adminClient,
    });

    await expect(listTrackedMovies()).rejects.toThrow(WatchlistDataError);
    consoleSpy.mockRestore();
  });
});

describe('createItemsAggregate — upsertMovie', () => {
  it('returns the upserted movie id', async () => {
    const adminClient = mockClient({ data: { id: 42 }, error: null });
    const { upsertMovie } = createItemsAggregate({
      adminClient,
      userClient: adminClient,
    });

    const result = await upsertMovie({
      tmdbId: 603,
      title: 'The Matrix',
      releaseDate: '1999-03-31',
      posterPath: '/matrix.jpg',
      overview: 'A hacker discovers the truth.',
      rawJson: { id: 603 },
    });

    expect(result).toEqual({ id: 42 });
    expect(adminClient.from).toHaveBeenCalledWith('movies');
  });

  it('throws WatchlistDataError on a PostgrestError', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const adminClient = mockClient({ data: null, error: SUPABASE_ERROR });
    const { upsertMovie } = createItemsAggregate({
      adminClient,
      userClient: adminClient,
    });

    await expect(
      upsertMovie({
        tmdbId: 603,
        title: 'The Matrix',
        releaseDate: '1999-03-31',
        posterPath: null,
        overview: null,
        rawJson: {},
      }),
    ).rejects.toThrow(WatchlistDataError);
    consoleSpy.mockRestore();
  });
});
