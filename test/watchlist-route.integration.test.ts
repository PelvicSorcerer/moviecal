import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

import {
  getTestMovieCatalogEntry,
  TEST_TMDB_IDS,
  TEST_USER_IDS,
  TEST_WATCHLIST_IDS,
} from '../src/lib/test-data/catalog';
import type { WatchlistRow } from '../src/lib/watchlist';
import {
  buildNormalizedMovieDetail,
  buildWatchlistRow,
  buildWatchlistSummary,
  createWatchlistRepository,
} from './support';

const mocks = vi.hoisted(() => ({
  authenticateApiRequest: vi.fn(),
  createServerSupabaseClient: vi.fn(),
  createServerSupabaseServiceRoleClient: vi.fn(),
  createSupabaseWatchlistRepository: vi.fn(),
  getMovieDetails: vi.fn(),
  hasE2EAuthenticatedSession: vi.fn(),
}));

vi.mock('../src/lib/auth/session', () => ({
  authenticateApiRequest: mocks.authenticateApiRequest,
}));

vi.mock('../src/lib/supabase/server', () => ({
  createServerSupabaseClient: mocks.createServerSupabaseClient,
  createServerSupabaseServiceRoleClient: mocks.createServerSupabaseServiceRoleClient,
}));

vi.mock('../src/lib/supabase/watchlist', () => ({
  createSupabaseWatchlistRepository: mocks.createSupabaseWatchlistRepository,
}));

vi.mock('../src/lib/tmdb/client', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/tmdb/client')>(
    '../src/lib/tmdb/client',
  );

  return {
    ...actual,
    getMovieDetails: mocks.getMovieDetails,
  };
});

vi.mock('../src/lib/e2e/fixtures', () => ({
  hasE2EAuthenticatedSession: mocks.hasE2EAuthenticatedSession,
}));

function createInMemoryWatchlistRepository(
  initialItems: WatchlistRow[] = [],
) {
  const itemsByWatchlist = new Map<string, WatchlistRow[]>([
    [TEST_WATCHLIST_IDS.PERSONAL, [...initialItems]],
    [TEST_WATCHLIST_IDS.SHARED, []],
  ]);

  function getItems(watchlistId: string): WatchlistRow[] {
    return itemsByWatchlist.get(watchlistId) ?? [];
  }

  return createWatchlistRepository({
    async listItemsForWatchlist(watchlistId) {
      return [...getItems(watchlistId)];
    },
    async insertItemForWatchlist(watchlistId, movieId) {
      const items = getItems(watchlistId);
      const existing = items.find((row) => row.movie?.id === movieId);

      if (existing) {
        return { row: null, errorCode: '23505' };
      }

      const catalogEntry = Object.values(
        {
          [TEST_TMDB_IDS.MATRIX]: getTestMovieCatalogEntry(TEST_TMDB_IDS.MATRIX),
          [TEST_TMDB_IDS.INCEPTION]: getTestMovieCatalogEntry(TEST_TMDB_IDS.INCEPTION),
        },
      ).find((entry) => entry?.dbId === movieId);
      const tmdbId = catalogEntry?.detail.tmdbId ?? TEST_TMDB_IDS.MATRIX;
      const row = buildWatchlistRow(tmdbId, {
        id: `watchlist-item-${items.length + 1}`,
      });

      itemsByWatchlist.set(watchlistId, [...items, row]);

      return { row, errorCode: null };
    },
    async deleteItemByIdForWatchlist(watchlistId, itemId) {
      const items = getItems(watchlistId);
      const nextItems = items.filter((row) => row.id !== itemId);

      if (nextItems.length === items.length) {
        return false;
      }

      itemsByWatchlist.set(watchlistId, nextItems);

      return true;
    },
    async findItemByMovieIdForWatchlist(watchlistId, movieId) {
      return getItems(watchlistId).find((row) => row.movie?.id === movieId) ?? null;
    },
    async upsertMovie(detail) {
      const catalogEntry = getTestMovieCatalogEntry(detail.tmdbId);

      return { id: catalogEntry?.dbId ?? 42 };
    },
    async getWatchlistAccess(actorUserId, watchlistId) {
      if (
        actorUserId === TEST_USER_IDS.OWNER
        && watchlistId === TEST_WATCHLIST_IDS.PERSONAL
      ) {
        return {
          status: 'authorized' as const,
          watchlist: buildWatchlistSummary({
            id: TEST_WATCHLIST_IDS.PERSONAL,
            kind: 'personal',
            name: 'My watchlist',
          }),
          canEdit: true,
        };
      }

      if (
        actorUserId === TEST_USER_IDS.OWNER
        && watchlistId === TEST_WATCHLIST_IDS.SHARED
      ) {
        return {
          status: 'authorized' as const,
          watchlist: buildWatchlistSummary({
            id: TEST_WATCHLIST_IDS.SHARED,
            kind: 'shared',
            name: 'Friday movie night',
          }),
          canEdit: true,
        };
      }

      return {
        status: 'forbidden' as const,
      };
    },
  });
}

function setupAuthenticatedRouteMocks(repository = createInMemoryWatchlistRepository()) {
  mocks.authenticateApiRequest.mockResolvedValue({
    accessToken: 'access-token',
    user: { id: TEST_USER_IDS.OWNER },
    applyAuthCookies(response: NextResponse) {
      response.cookies.set('sb-access-token', 'refreshed');
    },
  });
  mocks.createServerSupabaseClient.mockReturnValue({ name: 'user-client' });
  mocks.createServerSupabaseServiceRoleClient.mockReturnValue({
    name: 'admin-client',
  });
  mocks.createSupabaseWatchlistRepository.mockReturnValue(repository);
  mocks.hasE2EAuthenticatedSession.mockReturnValue(false);
  mocks.getMovieDetails.mockImplementation(async (tmdbId: number) =>
    buildNormalizedMovieDetail(tmdbId),
  );
}

describe('watchlist route integration seam', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns the real personal watchlist through GET /api/watchlist', async () => {
    setupAuthenticatedRouteMocks(
      createInMemoryWatchlistRepository([buildWatchlistRow()]),
    );

    const { GET } = await import('../src/app/api/watchlist/route');
    const response = await GET(
      new NextRequest('https://moviecal.test/api/watchlist'),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      items: [
        {
          id: 'watchlist-item-1',
          addedAt: '2026-06-13T05:00:00.000Z',
          movie: {
            id: 42,
            tmdbId: 603,
            title: 'The Matrix',
            releaseDate: '1999-03-31',
            overview: 'A hacker discovers the truth.',
            posterPath: '/matrix.jpg',
          },
        },
      ],
    });
  });

  it('returns an empty personal watchlist through GET /api/watchlist', async () => {
    setupAuthenticatedRouteMocks();

    const { GET } = await import('../src/app/api/watchlist/route');
    const response = await GET(
      new NextRequest('https://moviecal.test/api/watchlist'),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ items: [] });
  });

  it('adds a movie through POST /api/watchlist using the real domain path', async () => {
    setupAuthenticatedRouteMocks();

    const { POST } = await import('../src/app/api/watchlist/route');
    const response = await POST(
      new NextRequest('https://moviecal.test/api/watchlist', {
        method: 'POST',
        body: JSON.stringify({ tmdb_id: TEST_TMDB_IDS.MATRIX }),
        headers: {
          'content-type': 'application/json',
        },
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
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
          posterPath: '/matrix.jpg',
        },
      },
      watchlist: {
        canEdit: true,
        id: TEST_WATCHLIST_IDS.PERSONAL,
        kind: 'personal',
        name: 'My watchlist',
        ownerUserId: TEST_USER_IDS.OWNER,
      },
    });
    expect(mocks.getMovieDetails).toHaveBeenCalledWith(TEST_TMDB_IDS.MATRIX);
  });

  it('returns 200 without creating a duplicate item through POST /api/watchlist', async () => {
    setupAuthenticatedRouteMocks(
      createInMemoryWatchlistRepository([buildWatchlistRow()]),
    );

    const { POST } = await import('../src/app/api/watchlist/route');
    const response = await POST(
      new NextRequest('https://moviecal.test/api/watchlist', {
        method: 'POST',
        body: JSON.stringify({ tmdb_id: TEST_TMDB_IDS.MATRIX }),
        headers: {
          'content-type': 'application/json',
        },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      created: false,
      item: {
        id: 'watchlist-item-1',
        movie: {
          tmdbId: TEST_TMDB_IDS.MATRIX,
          title: 'The Matrix',
        },
      },
    });
  });

  it('adds to an explicit shared watchlist target through POST /api/watchlist', async () => {
    setupAuthenticatedRouteMocks();

    const { POST } = await import('../src/app/api/watchlist/route');
    const response = await POST(
      new NextRequest('https://moviecal.test/api/watchlist', {
        method: 'POST',
        body: JSON.stringify({
          tmdb_id: TEST_TMDB_IDS.INCEPTION,
          watchlist_id: TEST_WATCHLIST_IDS.SHARED,
        }),
        headers: {
          'content-type': 'application/json',
        },
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      created: true,
      item: {
        movie: {
          tmdbId: TEST_TMDB_IDS.INCEPTION,
          title: 'Inception',
        },
      },
      watchlist: {
        id: TEST_WATCHLIST_IDS.SHARED,
        kind: 'shared',
        name: 'Friday movie night',
      },
    });
  });

  it('removes a watchlist item through DELETE /api/watchlist/[id]', async () => {
    setupAuthenticatedRouteMocks(
      createInMemoryWatchlistRepository([buildWatchlistRow()]),
    );

    const { DELETE } = await import('../src/app/api/watchlist/[id]/route');
    const response = await DELETE(
      new NextRequest('https://moviecal.test/api/watchlist/watchlist-item-1', {
        method: 'DELETE',
      }),
      { params: Promise.resolve({ id: 'watchlist-item-1' }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      deleted: true,
      id: 'watchlist-item-1',
    });

    const { GET } = await import('../src/app/api/watchlist/route');
    const listResponse = await GET(
      new NextRequest('https://moviecal.test/api/watchlist'),
    );

    await expect(listResponse.json()).resolves.toEqual({ items: [] });
  });

  it('returns 404 when DELETE /api/watchlist/[id] targets a missing item', async () => {
    setupAuthenticatedRouteMocks();

    const { DELETE } = await import('../src/app/api/watchlist/[id]/route');
    const response = await DELETE(
      new NextRequest('https://moviecal.test/api/watchlist/missing-item', {
        method: 'DELETE',
      }),
      { params: Promise.resolve({ id: 'missing-item' }) },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: 'Watchlist item not found.',
    });
  });

  it('returns 403 when POST /api/watchlist targets a forbidden watchlist', async () => {
    setupAuthenticatedRouteMocks();

    const { POST } = await import('../src/app/api/watchlist/route');
    const response = await POST(
      new NextRequest('https://moviecal.test/api/watchlist', {
        method: 'POST',
        body: JSON.stringify({
          tmdb_id: TEST_TMDB_IDS.MATRIX,
          watchlist_id: 'forbidden-watchlist',
        }),
        headers: {
          'content-type': 'application/json',
        },
      }),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'Watchlist access denied.',
    });
  });
});
