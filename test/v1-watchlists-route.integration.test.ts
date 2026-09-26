import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  TEST_ITEM_IDS,
  TEST_TIMESTAMPS,
  TEST_USER_IDS,
  TEST_WATCHLIST_IDS,
} from '../src/lib/test-data/catalog';
import {
  DEFAULT_PAGE_LIMIT,
  encodePageCursor,
  getWatchlistDetail,
  listUserWatchlists,
  WatchlistAccessError,
  WatchlistNotFoundError,
} from '../src/lib/watchlist';
import {
  createSharedWatchlistReadRepository,
  NEWEST_SHARED_ITEM_ID,
  personalWatchlistIdFor,
  SHARED_WATCHLIST_NAME,
} from './support';

const mocks = vi.hoisted(() => ({
  resolveAuthTokensWithClient: vi.fn(),
  createServerSupabaseClient: vi.fn(),
  createServerSupabaseServiceRoleClient: vi.fn(),
  createSupabaseWatchlistRepository: vi.fn(),
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

const ACTORS = [
  TEST_USER_IDS.OWNER,
  TEST_USER_IDS.COLLABORATOR,
  TEST_USER_IDS.PENDING_INVITEE,
  TEST_USER_IDS.OUTSIDER,
] as const;

const repository = createSharedWatchlistReadRepository();

/**
 * Resolves the bearer token to `userId`, or to nobody when `userId` is null
 * (an expired or otherwise invalid token).
 */
function authenticateAs(userId: string | null): void {
  mocks.resolveAuthTokensWithClient.mockResolvedValue({
    refreshedSession: null,
    shouldClearCookies: false,
    user: userId ? { id: userId } : null,
  });
}

function setupRouteMocks(userId: string | null = TEST_USER_IDS.OWNER): void {
  authenticateAs(userId);
  mocks.createServerSupabaseClient.mockReturnValue({ name: 'user-client' });
  mocks.createServerSupabaseServiceRoleClient.mockReturnValue({
    name: 'service-role-client',
  });
  mocks.createSupabaseWatchlistRepository.mockReturnValue(repository);
}

function bearerRequest(
  path: string,
  init: { token?: string | null } = {},
): Request {
  const headers = new Headers();

  if (init.token !== null) {
    headers.set('authorization', `Bearer ${init.token ?? 'valid-token'}`);
  }

  return new Request(`https://moviecal.test${path}`, { headers, method: 'GET' });
}

async function listWatchlists(path = '/api/v1/watchlists', token?: string | null) {
  const { GET } = await import('../src/app/api/v1/watchlists/route');

  return GET(bearerRequest(path, { token }));
}

async function readWatchlist(
  watchlistId: string,
  init: { query?: string; token?: string | null } = {},
) {
  const { GET } = await import('../src/app/api/v1/watchlists/[watchlistId]/route');

  return GET(
    bearerRequest(
      `/api/v1/watchlists/${encodeURIComponent(watchlistId)}${init.query ?? ''}`,
      { token: init.token },
    ),
    { params: Promise.resolve({ watchlistId }) },
  );
}

describe('v1 shared watchlist read routes (mobile Bearer surface)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupRouteMocks();
  });

  afterEach(() => {
    vi.resetModules();
  });

  describe('bearer-only transport', () => {
    it('resolves the bearer token without allowing a silent refresh', async () => {
      await listWatchlists('/api/v1/watchlists', 'mobile-access-token');

      expect(mocks.createServerSupabaseClient).toHaveBeenCalledWith(
        'mobile-access-token',
      );
      expect(mocks.resolveAuthTokensWithClient).toHaveBeenCalledWith(
        { name: 'user-client' },
        { accessToken: 'mobile-access-token', refreshToken: '' },
        { allowRefresh: false },
      );
    });

    it('builds the repository from the caller-scoped and service-role clients', async () => {
      await listWatchlists();

      expect(mocks.createSupabaseWatchlistRepository).toHaveBeenCalledWith({
        userClient: { name: 'user-client' },
        adminClient: { name: 'service-role-client' },
      });
    });

    it.each([
      ['a missing Authorization header', null],
      ['a malformed Authorization header', ''],
    ])('returns 401 and nothing else for %s', async (_label, token) => {
      const list = await listWatchlists('/api/v1/watchlists', token);
      const detail = await readWatchlist(TEST_WATCHLIST_IDS.SHARED, { token });

      expect([list.status, detail.status]).toEqual([401, 401]);
      await expect(list.json()).resolves.toEqual({ error: 'Unauthorized.' });
      await expect(detail.json()).resolves.toEqual({ error: 'Unauthorized.' });
      // No token means no identity lookup and no data access at all.
      expect(mocks.resolveAuthTokensWithClient).not.toHaveBeenCalled();
      expect(mocks.createSupabaseWatchlistRepository).not.toHaveBeenCalled();
    });

    it('returns 401 with no private metadata for an invalid bearer token', async () => {
      setupRouteMocks(null);

      const detail = await readWatchlist(TEST_WATCHLIST_IDS.SHARED);
      const body = await detail.text();

      expect(detail.status).toBe(401);
      expect(JSON.parse(body)).toEqual({ error: 'Unauthorized.' });
      expect(body).not.toContain(SHARED_WATCHLIST_NAME);
      expect(body).not.toContain(TEST_USER_IDS.OWNER);
    });
  });

  describe('GET /api/v1/watchlists', () => {
    it('returns the owner every authorized list with role and canEdit', async () => {
      const response = await listWatchlists();

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        page: { limit: DEFAULT_PAGE_LIMIT, nextCursor: null },
        watchlists: [
          {
            canEdit: true,
            id: TEST_WATCHLIST_IDS.PERSONAL,
            kind: 'personal',
            name: 'My watchlist',
            ownerUserId: TEST_USER_IDS.OWNER,
            role: 'owner',
          },
          {
            canEdit: true,
            id: TEST_WATCHLIST_IDS.SHARED,
            kind: 'shared',
            name: SHARED_WATCHLIST_NAME,
            ownerUserId: TEST_USER_IDS.OWNER,
            role: 'owner',
          },
        ],
      });
    });

    it('reports an accepted member as an editor who can edit', async () => {
      setupRouteMocks(TEST_USER_IDS.COLLABORATOR);

      const response = await listWatchlists();
      const body = (await response.json()) as {
        watchlists: { canEdit: boolean; id: string; role: string }[];
      };

      expect(response.status).toBe(200);
      expect(body.watchlists).toContainEqual(
        expect.objectContaining({
          canEdit: true,
          id: TEST_WATCHLIST_IDS.SHARED,
          role: 'editor',
        }),
      );
    });

    it.each([TEST_USER_IDS.PENDING_INVITEE, TEST_USER_IDS.OUTSIDER])(
      'reveals no shared-list metadata to %s',
      async (userId) => {
        setupRouteMocks(userId);

        const response = await listWatchlists();
        const body = await response.text();

        expect(response.status).toBe(200);
        expect(JSON.parse(body).watchlists).toEqual([
          expect.objectContaining({ id: personalWatchlistIdFor(userId) }),
        ]);
        expect(body).not.toContain(SHARED_WATCHLIST_NAME);
        expect(body).not.toContain(TEST_WATCHLIST_IDS.SHARED);
      },
    );

    it('pages with an opaque cursor', async () => {
      const firstPage = await listWatchlists('/api/v1/watchlists?limit=1');
      const firstBody = (await firstPage.json()) as {
        page: { nextCursor: string | null };
        watchlists: { id: string }[];
      };
      const secondPage = await listWatchlists(
        `/api/v1/watchlists?limit=1&cursor=${firstBody.page.nextCursor}`,
      );

      expect(firstBody.watchlists.map((watchlist) => watchlist.id)).toEqual([
        TEST_WATCHLIST_IDS.PERSONAL,
      ]);
      expect(firstBody.page).toEqual({
        limit: 1,
        nextCursor: encodePageCursor(TEST_WATCHLIST_IDS.PERSONAL),
      });
      await expect(secondPage.json()).resolves.toEqual({
        page: { limit: 1, nextCursor: null },
        watchlists: [
          expect.objectContaining({ id: TEST_WATCHLIST_IDS.SHARED }),
        ],
      });
    });

    it.each([
      ['?limit=0', 'Pagination limit must be an integer between 1 and 100.'],
      ['?limit=101', 'Pagination limit must be an integer between 1 and 100.'],
      ['?cursor=not-a-cursor!', 'Invalid pagination cursor.'],
    ])('returns 400 for %s', async (query, error) => {
      const response = await listWatchlists(`/api/v1/watchlists${query}`);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error });
    });
  });

  describe('GET /api/v1/watchlists/{id}', () => {
    it('returns the watchlist, its ordered items, and page metadata', async () => {
      const response = await readWatchlist(TEST_WATCHLIST_IDS.SHARED);
      const body = (await response.json()) as {
        items: { addedAt: string; id: string }[];
        page: { limit: number; nextCursor: string | null };
        watchlist: Record<string, unknown>;
      };

      expect(response.status).toBe(200);
      expect(body.watchlist).toEqual({
        canEdit: true,
        id: TEST_WATCHLIST_IDS.SHARED,
        kind: 'shared',
        name: SHARED_WATCHLIST_NAME,
        ownerUserId: TEST_USER_IDS.OWNER,
        role: 'owner',
      });
      // Newest first, then the addedAt tie broken by ascending stable item id.
      expect(body.items.map((item) => item.id)).toEqual([
        NEWEST_SHARED_ITEM_ID,
        TEST_ITEM_IDS.MATRIX,
        TEST_ITEM_IDS.INCEPTION,
      ]);
      // Every timestamp is UTC ISO-8601, whatever spelling Postgres stored.
      expect(body.items.map((item) => item.addedAt)).toEqual([
        TEST_TIMESTAMPS.MATRIX_ADDED_AT,
        TEST_TIMESTAMPS.ITEM_ADDED_AT,
        TEST_TIMESTAMPS.ITEM_ADDED_AT,
      ]);
      expect(body.page).toEqual({ limit: DEFAULT_PAGE_LIMIT, nextCursor: null });
    });

    it('returns an accepted editor the same items with the editor role', async () => {
      const ownerBody = await (
        await readWatchlist(TEST_WATCHLIST_IDS.SHARED)
      ).json();

      setupRouteMocks(TEST_USER_IDS.COLLABORATOR);

      const editorResponse = await readWatchlist(TEST_WATCHLIST_IDS.SHARED);
      const editorBody = await editorResponse.json();

      expect(editorResponse.status).toBe(200);
      expect(editorBody).toEqual({
        ...ownerBody,
        watchlist: { ...ownerBody.watchlist, role: 'editor' },
      });
    });

    it.each([TEST_USER_IDS.PENDING_INVITEE, TEST_USER_IDS.OUTSIDER])(
      'answers %s with the same 404 as an unknown watchlist id',
      async (userId) => {
        setupRouteMocks(userId);

        const forbidden = await readWatchlist(TEST_WATCHLIST_IDS.SHARED);
        const unknown = await readWatchlist(TEST_WATCHLIST_IDS.UNKNOWN);
        const forbiddenBody = await forbidden.text();

        expect([forbidden.status, unknown.status]).toEqual([404, 404]);
        expect(forbiddenBody).toBe(await unknown.text());
        expect(JSON.parse(forbiddenBody)).toEqual({
          error: 'Watchlist not found.',
        });
        expect(forbiddenBody).not.toContain(SHARED_WATCHLIST_NAME);
      },
    );

    it("answers 404 for another user's personal watchlist", async () => {
      setupRouteMocks(TEST_USER_IDS.OUTSIDER);

      const response = await readWatchlist(TEST_WATCHLIST_IDS.PERSONAL);

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        error: 'Watchlist not found.',
      });
    });

    it("reads the caller's own personal watchlist through the same route", async () => {
      const response = await readWatchlist(TEST_WATCHLIST_IDS.PERSONAL);
      const body = (await response.json()) as {
        items: { id: string }[];
        watchlist: { kind: string; role: string };
      };

      expect(response.status).toBe(200);
      expect(body.watchlist).toEqual(
        expect.objectContaining({ kind: 'personal', role: 'owner' }),
      );
      expect(body.items.map((item) => item.id)).toEqual([TEST_ITEM_IDS.MATRIX]);
    });

    it('pages items with an opaque cursor', async () => {
      const firstPage = await readWatchlist(TEST_WATCHLIST_IDS.SHARED, {
        query: '?limit=2',
      });
      const firstBody = (await firstPage.json()) as {
        items: { id: string }[];
        page: { nextCursor: string | null };
      };
      const secondPage = await readWatchlist(TEST_WATCHLIST_IDS.SHARED, {
        query: `?limit=2&cursor=${firstBody.page.nextCursor}`,
      });
      const secondBody = (await secondPage.json()) as {
        items: { id: string }[];
        page: { nextCursor: string | null };
      };

      expect(firstBody.items.map((item) => item.id)).toEqual([
        NEWEST_SHARED_ITEM_ID,
        TEST_ITEM_IDS.MATRIX,
      ]);
      expect(firstBody.page.nextCursor).toBe(
        encodePageCursor(TEST_ITEM_IDS.MATRIX),
      );
      expect(secondBody.items.map((item) => item.id)).toEqual([
        TEST_ITEM_IDS.INCEPTION,
      ]);
      expect(secondBody.page.nextCursor).toBeNull();
    });

    it('returns 400 for a cursor whose item is no longer in the list', async () => {
      const response = await readWatchlist(TEST_WATCHLIST_IDS.SHARED, {
        query: `?cursor=${encodePageCursor('watchlist-item-removed')}`,
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: 'Invalid pagination cursor.',
      });
    });
  });

  describe('web/bearer parity', () => {
    it.each(ACTORS)(
      'lists exactly the watchlists the cookie surface lists for %s',
      async (userId) => {
        setupRouteMocks(userId);

        const cookieWatchlists = await listUserWatchlists({
          repository,
          userId,
        });
        const body = (await (await listWatchlists()).json()) as {
          watchlists: { canEdit: boolean; id: string }[];
        };

        expect(body.watchlists.map((watchlist) => watchlist.id)).toEqual(
          cookieWatchlists.map((watchlist) => watchlist.id),
        );
        expect(body.watchlists.map((watchlist) => watchlist.canEdit)).toEqual(
          cookieWatchlists.map((watchlist) => watchlist.canEdit),
        );
      },
    );

    it.each(ACTORS)(
      'reads the shared watchlist exactly when the cookie surface does for %s',
      async (actorUserId) => {
        setupRouteMocks(actorUserId);

        const cookieResult = await getWatchlistDetail({
          actorUserId,
          repository,
          watchlistId: TEST_WATCHLIST_IDS.SHARED,
        }).catch((error: unknown) => error);
        const response = await readWatchlist(TEST_WATCHLIST_IDS.SHARED);

        if (
          cookieResult instanceof WatchlistAccessError
          || cookieResult instanceof WatchlistNotFoundError
        ) {
          // The cookie detail page renders notFound() for both; the bearer
          // surface answers 404 for both. Neither distinguishes them.
          expect(response.status).toBe(404);

          return;
        }

        const body = (await response.json()) as { items: { id: string }[] };

        expect(response.status).toBe(200);
        expect(body.items.map((item) => item.id).sort()).toEqual(
          (cookieResult as Awaited<ReturnType<typeof getWatchlistDetail>>).items
            .map((item) => item.id)
            .sort(),
        );
      },
    );
  });
});
