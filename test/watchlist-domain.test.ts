import { describe, expect, it, vi } from 'vitest';

import {
  addPersonalWatchlistItem,
  addWatchlistItem,
  listPersonalWatchlistItems,
  listUserWatchlists,
  listWatchlistItems,
  mapWatchlistRow,
  removeWatchlistItem,
  WatchlistAccessError,
  WatchlistInputError,
  WatchlistNotFoundError,
  type WatchlistRepository,
  type WatchlistRow,
  type WatchlistSummary,
} from '../src/lib/watchlist';

function buildWatchlistSummary(
  overrides: Partial<WatchlistSummary> = {},
): WatchlistSummary {
  return {
    id: 'watchlist-1',
    kind: 'personal',
    name: 'My watchlist',
    ownerUserId: 'user-1',
    ...overrides,
  };
}

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
    async deleteItemByIdForWatchlist() {
      return true;
    },
    async ensurePersonalWatchlist() {
      return buildWatchlistSummary();
    },
    async findItemByMovieIdForWatchlist() {
      return buildWatchlistRow();
    },
    async getWatchlistAccess() {
      return {
        status: 'authorized',
        watchlist: buildWatchlistSummary(),
        canEdit: true,
      };
    },
    async insertItemForWatchlist() {
      return {
        row: buildWatchlistRow(),
        errorCode: null,
      };
    },
    async listItemsForWatchlist() {
      return [];
    },
    async listTrackedMovies() {
      return [];
    },
    async listWatchlistsForUser() {
      return [buildWatchlistSummary()];
    },
    async upsertMovie() {
      return { id: 42 };
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

  it('lists an explicitly scoped watchlist after checking access', async () => {
    const repository = createRepository({
      async getWatchlistAccess(actorUserId, watchlistId) {
        expect(actorUserId).toBe('user-1');
        expect(watchlistId).toBe('watchlist-1');

        return {
          status: 'authorized',
          watchlist: buildWatchlistSummary(),
          canEdit: true,
        };
      },
      async listItemsForWatchlist(watchlistId) {
        expect(watchlistId).toBe('watchlist-1');
        return [buildWatchlistRow()];
      },
    });

    await expect(
      listWatchlistItems({
        actorUserId: 'user-1',
        repository,
        watchlistId: 'watchlist-1',
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

  it('preserves the current personal watchlist path through the generalized abstraction', async () => {
    const repository = createRepository({
      async ensurePersonalWatchlist(userId) {
        expect(userId).toBe('user-1');
        return buildWatchlistSummary({
          id: 'personal-watchlist-1',
        });
      },
      async getWatchlistAccess(actorUserId, watchlistId) {
        expect(actorUserId).toBe('user-1');
        expect(watchlistId).toBe('personal-watchlist-1');
        return {
          status: 'authorized',
          watchlist: buildWatchlistSummary({
            id: 'personal-watchlist-1',
          }),
          canEdit: true,
        };
      },
      async listItemsForWatchlist(watchlistId) {
        expect(watchlistId).toBe('personal-watchlist-1');
        return [buildWatchlistRow()];
      },
    });

    await expect(
      listPersonalWatchlistItems({
        repository,
        userId: 'user-1',
      }),
    ).resolves.toHaveLength(1);
  });

  it('distinguishes forbidden watchlist access from not-found watchlists', async () => {
    await expect(
      listWatchlistItems({
        actorUserId: 'user-2',
        repository: createRepository({
          async getWatchlistAccess() {
            return {
              status: 'forbidden',
            };
          },
        }),
        watchlistId: 'watchlist-1',
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: 'WatchlistAccessError',
        reason: 'forbidden',
        status: 403,
      }),
    );

    await expect(
      listWatchlistItems({
        actorUserId: 'user-2',
        repository: createRepository({
          async getWatchlistAccess() {
            return {
              status: 'not_found',
            };
          },
        }),
        watchlistId: 'watchlist-missing',
      }),
    ).rejects.toBeInstanceOf(WatchlistNotFoundError);
  });

  it('blocks mutations when the actor lacks edit access', async () => {
    await expect(
      addWatchlistItem({
        actorUserId: 'user-2',
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
        repository: createRepository({
          async getWatchlistAccess() {
            return {
              status: 'authorized',
              watchlist: buildWatchlistSummary({
                id: 'shared-watchlist-1',
                kind: 'shared',
              }),
              canEdit: false,
            };
          },
        }),
        tmdbId: 603,
        watchlistId: 'shared-watchlist-1',
      }),
    ).rejects.toBeInstanceOf(WatchlistAccessError);
  });

  it('adds a new watchlist item after upserting movie metadata', async () => {
    const repository = createRepository({
      async getWatchlistAccess(actorUserId, watchlistId) {
        expect(actorUserId).toBe('user-1');
        expect(watchlistId).toBe('watchlist-1');
        return {
          status: 'authorized',
          watchlist: buildWatchlistSummary(),
          canEdit: true,
        };
      },
      async upsertMovie(detail) {
        expect(detail.tmdbId).toBe(603);
        return { id: 42 };
      },
      async insertItemForWatchlist(watchlistId, movieId) {
        expect(watchlistId).toBe('watchlist-1');
        expect(movieId).toBe(42);
        return {
          row: buildWatchlistRow(),
          errorCode: null,
        };
      },
    });

    await expect(
      addWatchlistItem({
        actorUserId: 'user-1',
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
        watchlistId: 'watchlist-1',
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

  it('treats duplicate add attempts as deterministic no-ops within the target watchlist scope', async () => {
    const repository = createRepository({
      async insertItemForWatchlist() {
        return {
          row: null,
          errorCode: '23505',
        };
      },
    });

    await expect(
      addPersonalWatchlistItem({
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
      addPersonalWatchlistItem({
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
        actorUserId: 'user-1',
        itemId: 'missing-item',
        repository: createRepository({
          async deleteItemByIdForWatchlist() {
            return false;
          },
        }),
        watchlistId: 'watchlist-1',
      }),
    ).rejects.toBeInstanceOf(WatchlistNotFoundError);
  });

  it('exposes list discovery through the repository abstraction', async () => {
    await expect(
      listUserWatchlists({
        repository: createRepository({
          async listWatchlistsForUser(userId) {
            expect(userId).toBe('user-1');
            return [
              buildWatchlistSummary(),
              buildWatchlistSummary({
                id: 'shared-watchlist-1',
                kind: 'shared',
                name: 'Movie night',
              }),
            ];
          },
        }),
        userId: 'user-1',
      }),
    ).resolves.toEqual([
      buildWatchlistSummary(),
      buildWatchlistSummary({
        id: 'shared-watchlist-1',
        kind: 'shared',
        name: 'Movie night',
      }),
    ]);
  });
});
