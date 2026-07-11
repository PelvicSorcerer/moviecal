import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  resolveAuthTokensWithClient: vi.fn(),
  createServerSupabaseClient: vi.fn(),
  createServerSupabaseServiceRoleClient: vi.fn(),
  createSupabaseWatchlistRepository: vi.fn(),
  getMovieDetails: vi.fn(),
}));

vi.mock('../src/lib/auth/identity', () => ({
  resolveAuthTokensWithClient: mocks.resolveAuthTokensWithClient,
}));

vi.mock('../src/lib/supabase/server', () => ({
  createServerSupabaseClient: mocks.createServerSupabaseClient,
  createServerSupabaseServiceRoleClient:
    mocks.createServerSupabaseServiceRoleClient,
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

/**
 * An in-memory watchlist repository seam. Mirrors the pattern used by
 * `test/watchlist-route.integration.test.ts` so the v1 route exercises the real
 * watchlist domain layer while the Supabase client stays mocked.
 */
function createInMemoryWatchlistRepository(initialItems: WatchlistRow[] = []) {
  const items = [...initialItems];

  return createWatchlistRepository({
    async listItemsForWatchlist() {
      return [...items];
    },
    async insertItemForWatchlist(_watchlistId, movieId) {
      const existing = items.find((row) => row.movie?.id === movieId);

      if (existing) {
        return { row: null, errorCode: '23505' };
      }

      const row = buildWatchlistRow(TEST_TMDB_IDS.MATRIX, {
        id: `watchlist-item-${items.length + 1}`,
      });

      items.push(row);

      return { row, errorCode: null };
    },
    async deleteItemByIdForWatchlist(_watchlistId, itemId) {
      const index = items.findIndex((row) => row.id === itemId);

      if (index === -1) {
        return false;
      }

      items.splice(index, 1);

      return true;
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

      return { status: 'forbidden' as const };
    },
  });
}

function authenticateAs(userId: string | null): void {
  mocks.resolveAuthTokensWithClient.mockResolvedValue({
    refreshedSession: null,
    shouldClearCookies: false,
    user: userId ? { id: userId } : null,
  });
}

function setupAuthenticatedRouteMocks(
  repository = createInMemoryWatchlistRepository(),
): void {
  authenticateAs(TEST_USER_IDS.OWNER);
  mocks.createServerSupabaseClient.mockReturnValue({ name: 'user-client' });
  mocks.createServerSupabaseServiceRoleClient.mockReturnValue({
    name: 'service-role-client',
  });
  mocks.createSupabaseWatchlistRepository.mockReturnValue(repository);
  mocks.getMovieDetails.mockImplementation(async (tmdbId: number) =>
    buildNormalizedMovieDetail(tmdbId),
  );
}

function bearerRequest(
  init: { body?: unknown; method?: string; token?: string | null } = {},
): Request {
  const headers = new Headers();

  if (init.token !== null) {
    headers.set('authorization', `Bearer ${init.token ?? 'valid-token'}`);
  }

  if (init.body !== undefined) {
    headers.set('content-type', 'application/json');
  }

  return new Request('https://moviecal.test/api/v1/watchlist', {
    method: init.method ?? 'GET',
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

describe('v1 watchlist route (mobile Bearer surface)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('route source never imports Next.js cookie transport or logs tokens', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const routeSource = readFileSync(
      fileURLToPath(
        new URL('../src/app/api/v1/watchlist/route.ts', import.meta.url),
      ),
      'utf8',
    );

    // The service-role client is permitted for the trusted `movies` upsert, but
    // the cookie transport module must never be imported and tokens must never
    // be logged.
    expect(routeSource).not.toContain('next/headers');
    expect(routeSource).not.toMatch(/console\.[a-z]+\(/);
  });

  it('bearer transport helper never imports Next.js transport or logs', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const bearerSource = readFileSync(
      fileURLToPath(new URL('../src/lib/auth/bearer.ts', import.meta.url)),
      'utf8',
    );

    // Assert on imports specifically — the module docstring names these paths
    // in prose to explain that it deliberately does NOT import them.
    expect(bearerSource).not.toMatch(
      /from ['"]next\/(headers|server|navigation)['"]/,
    );
    expect(bearerSource).not.toMatch(/console\.[a-z]+\(/);
  });

  describe('GET /api/v1/watchlist', () => {
    it('returns the authenticated user watchlist as { items }', async () => {
      setupAuthenticatedRouteMocks(
        createInMemoryWatchlistRepository([buildWatchlistRow()]),
      );

      const { GET } = await import('../src/app/api/v1/watchlist/route');
      const response = await GET(bearerRequest());

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        items: [
          {
            id: 'watchlist-item-1',
            addedAt: '2026-06-13T05:00:00.000Z',
            movie: {
              id: 42,
              tmdbId: TEST_TMDB_IDS.MATRIX,
              title: 'The Matrix',
              releaseDate: '1999-03-31',
              overview: 'A hacker discovers the truth.',
              posterPath: '/matrix.jpg',
            },
          },
        ],
      });
      // The user-scoped client backs identity + RLS-scoped queries; the
      // service-role client backs only the trusted `movies` metadata upsert.
      expect(mocks.createSupabaseWatchlistRepository).toHaveBeenCalledWith({
        userClient: { name: 'user-client' },
        adminClient: { name: 'service-role-client' },
      });
    });

    it('returns 401 { error: Unauthorized. } when the Authorization header is missing', async () => {
      setupAuthenticatedRouteMocks();

      const { GET } = await import('../src/app/api/v1/watchlist/route');
      const response = await GET(bearerRequest({ token: null }));

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: 'Unauthorized.' });
      // A missing token must short-circuit before any auth resolution.
      expect(mocks.resolveAuthTokensWithClient).not.toHaveBeenCalled();
    });

    it('returns 401 when the bearer token does not resolve to a user', async () => {
      setupAuthenticatedRouteMocks();
      authenticateAs(null);

      const { GET } = await import('../src/app/api/v1/watchlist/route');
      const response = await GET(bearerRequest());

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: 'Unauthorized.' });
    });

    it('resolves the bearer token without allowing a silent refresh', async () => {
      setupAuthenticatedRouteMocks();

      const { GET } = await import('../src/app/api/v1/watchlist/route');
      await GET(bearerRequest({ token: 'mobile-access-token' }));

      expect(mocks.createServerSupabaseClient).toHaveBeenCalledWith(
        'mobile-access-token',
      );
      // Bearer-only auth carries no refresh token: refreshToken is empty and
      // refresh is disabled.
      expect(mocks.resolveAuthTokensWithClient).toHaveBeenCalledWith(
        { name: 'user-client' },
        { accessToken: 'mobile-access-token', refreshToken: '' },
        { allowRefresh: false },
      );
    });
  });

  describe('POST /api/v1/watchlist', () => {
    it('adds a movie and returns { item } with status 201', async () => {
      setupAuthenticatedRouteMocks();

      const { POST } = await import('../src/app/api/v1/watchlist/route');
      const response = await POST(
        bearerRequest({ method: 'POST', body: { tmdbId: TEST_TMDB_IDS.MATRIX } }),
      );

      expect(response.status).toBe(201);
      await expect(response.json()).resolves.toEqual({
        item: {
          id: 'watchlist-item-1',
          addedAt: '2026-06-13T05:00:00.000Z',
          movie: {
            id: 42,
            tmdbId: TEST_TMDB_IDS.MATRIX,
            title: 'The Matrix',
            releaseDate: '1999-03-31',
            overview: 'A hacker discovers the truth.',
            posterPath: '/matrix.jpg',
          },
        },
      });
      expect(mocks.getMovieDetails).toHaveBeenCalledWith(TEST_TMDB_IDS.MATRIX);
    });

    it('maps a WatchlistInputError to 400 for a non-numeric tmdbId', async () => {
      setupAuthenticatedRouteMocks();

      const { POST } = await import('../src/app/api/v1/watchlist/route');
      const response = await POST(
        bearerRequest({ method: 'POST', body: { tmdbId: 'not-a-number' } }),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: 'A valid tmdbId is required.',
      });
    });

    it('returns 401 when the Authorization header is missing', async () => {
      setupAuthenticatedRouteMocks();

      const { POST } = await import('../src/app/api/v1/watchlist/route');
      const response = await POST(
        bearerRequest({
          method: 'POST',
          body: { tmdbId: TEST_TMDB_IDS.MATRIX },
          token: null,
        }),
      );

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: 'Unauthorized.' });
    });
  });

  describe('DELETE /api/v1/watchlist', () => {
    it('removes an item and returns 204 with no body', async () => {
      setupAuthenticatedRouteMocks(
        createInMemoryWatchlistRepository([buildWatchlistRow()]),
      );

      const { DELETE } = await import('../src/app/api/v1/watchlist/route');
      const response = await DELETE(
        bearerRequest({
          method: 'DELETE',
          body: { watchlistItemId: 'watchlist-item-1' },
        }),
      );

      expect(response.status).toBe(204);
      expect(await response.text()).toBe('');
    });

    it('maps a WatchlistNotFoundError to 404 for a missing item', async () => {
      setupAuthenticatedRouteMocks();

      const { DELETE } = await import('../src/app/api/v1/watchlist/route');
      const response = await DELETE(
        bearerRequest({
          method: 'DELETE',
          body: { watchlistItemId: 'missing-item' },
        }),
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        error: 'Watchlist item not found.',
      });
    });

    it('maps a WatchlistInputError to 400 for a missing watchlistItemId', async () => {
      setupAuthenticatedRouteMocks();

      const { DELETE } = await import('../src/app/api/v1/watchlist/route');
      const response = await DELETE(bearerRequest({ method: 'DELETE', body: {} }));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: 'A valid watchlistItemId is required.',
      });
    });

    it('returns 401 when the Authorization header is missing', async () => {
      setupAuthenticatedRouteMocks();

      const { DELETE } = await import('../src/app/api/v1/watchlist/route');
      const response = await DELETE(
        bearerRequest({
          method: 'DELETE',
          body: { watchlistItemId: 'watchlist-item-1' },
          token: null,
        }),
      );

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: 'Unauthorized.' });
    });
  });
});
