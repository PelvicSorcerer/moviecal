import { describe, expect, it, vi } from 'vitest';

import {
  addWatchlistItem,
  listWatchlistItems,
  mapWatchlistRow,
  removeWatchlistItem,
  WatchlistInputError,
  WatchlistNotFoundError,
  type WatchlistRepository,
  type WatchlistRow,
} from '../src/lib/watchlist';

function buildWatchlistRow(overrides: Partial<WatchlistRow> = {}): WatchlistRow {
  return {
    id: 'watchlist-item-1',
    added_at: '2026-06-13T05:00:00.000Z',
    movie: {
      id: 42,
      tmdb_id: 603,
      title: 'The Matrix',
      release_date: '1999-03-31',
      raw_json: {
        overview: 'A hacker discovers the truth.',
        poster_path: '/f89U3ADr1oiB1s9GkdPOEpXUk5H.jpg',
      },
      updated_at: '2026-06-13T05:00:00.000Z',
    },
    ...overrides,
  };
}

function createRepository(
  overrides: Partial<WatchlistRepository> = {},
): WatchlistRepository {
  return {
    async listItemsForUser() {
      return [];
    },
    async upsertMovie() {
      return { id: 42 };
    },
    async insertItemForUser() {
      return {
        row: buildWatchlistRow(),
        errorCode: null,
      };
    },
    async findItemByMovieIdForUser() {
      return buildWatchlistRow();
    },
    async deleteItemByIdForUser() {
      return true;
    },
    ...overrides,
  };
}

describe('watchlist domain helpers', () => {
  it('maps joined movie metadata into the planned API shape', () => {
    expect(mapWatchlistRow(buildWatchlistRow())).toEqual({
      id: 'watchlist-item-1',
      addedAt: '2026-06-13T05:00:00.000Z',
      movie: {
        id: 42,
        tmdbId: 603,
        title: 'The Matrix',
        releaseDate: '1999-03-31',
        overview: 'A hacker discovers the truth.',
        posterPath: '/f89U3ADr1oiB1s9GkdPOEpXUk5H.jpg',
      },
    });
  });

  it('lists the authenticated user watchlist', async () => {
    const repository = createRepository({
      async listItemsForUser(userId) {
        expect(userId).toBe('user-1');
        return [buildWatchlistRow()];
      },
    });

    await expect(
      listWatchlistItems({
        repository,
        userId: 'user-1',
      }),
    ).resolves.toEqual([
      {
        id: 'watchlist-item-1',
        addedAt: '2026-06-13T05:00:00.000Z',
        movie: {
          id: 42,
          tmdbId: 603,
          title: 'The Matrix',
          releaseDate: '1999-03-31',
          overview: 'A hacker discovers the truth.',
          posterPath: '/f89U3ADr1oiB1s9GkdPOEpXUk5H.jpg',
        },
      },
    ]);
  });

  it('adds a new watchlist item after upserting movie metadata', async () => {
    const repository = createRepository({
      async upsertMovie(detail) {
        expect(detail.tmdbId).toBe(603);
        return { id: 42 };
      },
      async insertItemForUser(userId, movieId) {
        expect(userId).toBe('user-1');
        expect(movieId).toBe(42);
        return {
          row: buildWatchlistRow(),
          errorCode: null,
        };
      },
    });

    await expect(
      addWatchlistItem({
        getMovieDetails: async () => ({
          tmdbId: 603,
          title: 'The Matrix',
          releaseDate: '1999-03-31',
          posterPath: '/f89U3ADr1oiB1s9GkdPOEpXUk5H.jpg',
          overview: 'A hacker discovers the truth.',
          rawJson: {
            id: 603,
            title: 'The Matrix',
          },
        }),
        repository,
        tmdbId: 603,
        userId: 'user-1',
      }),
    ).resolves.toEqual({
      created: true,
      item: {
        id: 'watchlist-item-1',
        addedAt: '2026-06-13T05:00:00.000Z',
        movie: {
          id: 42,
          tmdbId: 603,
          title: 'The Matrix',
          releaseDate: '1999-03-31',
          overview: 'A hacker discovers the truth.',
          posterPath: '/f89U3ADr1oiB1s9GkdPOEpXUk5H.jpg',
        },
      },
    });
  });

  it('treats duplicate add attempts as deterministic no-ops', async () => {
    const repository = createRepository({
      async insertItemForUser() {
        return {
          row: null,
          errorCode: '23505',
        };
      },
    });

    await expect(
      addWatchlistItem({
        getMovieDetails: async () => ({
          tmdbId: 603,
          title: 'The Matrix',
          releaseDate: '1999-03-31',
          posterPath: '/f89U3ADr1oiB1s9GkdPOEpXUk5H.jpg',
          overview: 'A hacker discovers the truth.',
          rawJson: {
            id: 603,
            title: 'The Matrix',
          },
        }),
        repository,
        tmdbId: 603,
        userId: 'user-1',
      }),
    ).resolves.toMatchObject({
      created: false,
      item: {
        id: 'watchlist-item-1',
      },
    });
  });

  it('rejects invalid tmdb ids before calling TMDb', async () => {
    const getMovieDetails = vi.fn();

    await expect(
      addWatchlistItem({
        getMovieDetails,
        repository: createRepository(),
        tmdbId: 0,
        userId: 'user-1',
      }),
    ).rejects.toBeInstanceOf(WatchlistInputError);

    expect(getMovieDetails).not.toHaveBeenCalled();
  });

  it('reports missing watchlist items on delete', async () => {
    await expect(
      removeWatchlistItem({
        itemId: 'missing-item',
        repository: createRepository({
          async deleteItemByIdForUser() {
            return false;
          },
        }),
        userId: 'user-1',
      }),
    ).rejects.toBeInstanceOf(WatchlistNotFoundError);
  });
});
