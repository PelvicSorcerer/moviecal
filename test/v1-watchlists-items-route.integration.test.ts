import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getTestMovieCatalogEntry,
  TEST_TMDB_IDS,
  TEST_USER_IDS,
  TEST_WATCHLIST_IDS,
} from '../src/lib/test-data/catalog';
import { addWatchlistItem, type WatchlistRow } from '../src/lib/watchlist';
import {
  buildNormalizedMovieDetail,
  buildWatchlistRow,
  createSharedWatchlistReadRepository,
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

  return { ...actual, getMovieDetails: mocks.getMovieDetails };
});

/** Shared-list access rules plus a stateful item table keyed by movie. */
function createRepository() {
  const items: WatchlistRow[] = [];

  return {
    items,
    repository: createSharedWatchlistReadRepository({
      async deleteItemByIdForWatchlist(_watchlistId, itemId) {
        const index = items.findIndex((row) => row.id === itemId);

        if (index === -1) {
          return false;
        }

        items.splice(index, 1);

        return true;
      },
      async findItemByMovieIdForWatchlist(_watchlistId, movieId) {
        return items.find((row) => row.movie?.id === movieId) ?? null;
      },
      async insertItemForWatchlist(_watchlistId, movieId) {
        if (items.some((row) => row.movie?.id === movieId)) {
          return { row: null, errorCode: '23505' };
        }

        const entry = [TEST_TMDB_IDS.INCEPTION, TEST_TMDB_IDS.MATRIX].find(
          (tmdbId) => getTestMovieCatalogEntry(tmdbId)?.dbId === movieId,
        );
        const row = buildWatchlistRow(entry ?? TEST_TMDB_IDS.MATRIX, {
          id: `new-item-${items.length + 1}`,
        });

        items.push(row);

        return { row, errorCode: null };
      },
      async upsertMovie(detail) {
        return { id: getTestMovieCatalogEntry(detail.tmdbId)?.dbId ?? 42 };
      },
    }),
  };
}

let state = createRepository();

function setup(userId: string | null = TEST_USER_IDS.OWNER): void {
  mocks.resolveAuthTokensWithClient.mockResolvedValue({
    refreshedSession: null,
    shouldClearCookies: false,
    user: userId ? { id: userId } : null,
  });
  mocks.createServerSupabaseClient.mockReturnValue({ name: 'user-client' });
  mocks.createServerSupabaseServiceRoleClient.mockReturnValue({
    name: 'service-role-client',
  });
  mocks.createSupabaseWatchlistRepository.mockReturnValue(state.repository);
  mocks.getMovieDetails.mockImplementation(async (tmdbId: number) =>
    buildNormalizedMovieDetail(tmdbId),
  );
}

function request(
  method: string,
  init: { body?: unknown; token?: string | null } = {},
): Request {
  const headers = new Headers();

  if (init.token !== null) {
    headers.set('authorization', `Bearer ${init.token ?? 'valid-token'}`);
  }

  if (init.body !== undefined) {
    headers.set('content-type', 'application/json');
  }

  return new Request('https://moviecal.test/api/v1/watchlists/x/items', {
    body:
      init.body === undefined
        ? undefined
        : typeof init.body === 'string'
          ? init.body
          : JSON.stringify(init.body),
    headers,
    method,
  });
}

async function addItem(
  watchlistId: string,
  body: unknown,
  token?: string | null,
) {
  const { POST } = await import(
    '../src/app/api/v1/watchlists/[watchlistId]/items/route'
  );

  return POST(request('POST', { body, token }), {
    params: Promise.resolve({ watchlistId }),
  });
}

async function removeItem(
  watchlistId: string,
  itemId: string,
  token?: string | null,
) {
  const { DELETE } = await import(
    '../src/app/api/v1/watchlists/[watchlistId]/items/[itemId]/route'
  );

  return DELETE(request('DELETE', { token }), {
    params: Promise.resolve({ itemId, watchlistId }),
  });
}

const SHARED = TEST_WATCHLIST_IDS.SHARED;
const NOT_FOUND = { error: 'Watchlist not found.' };

describe('v1 shared watchlist item add/remove routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state = createRepository();
    setup();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it.each([
    ['owner', TEST_USER_IDS.OWNER],
    ['accepted editor', TEST_USER_IDS.COLLABORATOR],
  ])('lets the %s add and remove an item', async (_label, userId) => {
    setup(userId);

    const added = await addItem(SHARED, { tmdbId: TEST_TMDB_IDS.INCEPTION });
    const body = (await added.json()) as {
      created: boolean;
      item: { id: string; movie: { tmdbId: number } };
      watchlist: { id: string };
    };

    expect(added.status).toBe(201);
    expect(body.created).toBe(true);
    expect(body.watchlist.id).toBe(SHARED);
    expect(body.item.movie.tmdbId).toBe(TEST_TMDB_IDS.INCEPTION);

    const removed = await removeItem(SHARED, body.item.id);

    expect(removed.status).toBe(204);
    expect(state.items).toEqual([]);
  });

  it.each([TEST_USER_IDS.PENDING_INVITEE, TEST_USER_IDS.OUTSIDER, 'lost-access-user'])(
    'answers %s with the same 404 as an unknown list and changes nothing',
    async (userId) => {
      state.items.push(buildWatchlistRow(TEST_TMDB_IDS.MATRIX, { id: 'kept' }));
      setup(userId);

      const responses = [
        await addItem(SHARED, { tmdbId: TEST_TMDB_IDS.INCEPTION }),
        await removeItem(SHARED, 'kept'),
        await addItem(TEST_WATCHLIST_IDS.UNKNOWN, {
          tmdbId: TEST_TMDB_IDS.INCEPTION,
        }),
        await removeItem(TEST_WATCHLIST_IDS.UNKNOWN, 'kept'),
      ];

      expect(responses.map((response) => response.status)).toEqual([
        404, 404, 404, 404,
      ]);

      for (const response of responses) {
        await expect(response.json()).resolves.toEqual(NOT_FOUND);
      }

      expect(state.items.map((row) => row.id)).toEqual(['kept']);
      expect(mocks.getMovieDetails).not.toHaveBeenCalled();
    },
  );

  it('returns 200 with created:false and the same item for a duplicate add', async () => {
    const first = await addItem(SHARED, { tmdbId: TEST_TMDB_IDS.INCEPTION });
    const retry = await addItem(SHARED, { tmdbId: TEST_TMDB_IDS.INCEPTION });
    const firstBody = await first.json();
    const retryBody = await retry.json();

    expect([first.status, retry.status]).toEqual([201, 200]);
    expect(retryBody).toEqual({ ...firstBody, created: false });
    expect(state.items).toHaveLength(1);
  });

  it('does not create a duplicate when two editors add the same movie', async () => {
    const owner = await addItem(SHARED, { tmdbId: TEST_TMDB_IDS.MATRIX });

    setup(TEST_USER_IDS.COLLABORATOR);

    const editor = await addItem(SHARED, { tmdbId: TEST_TMDB_IDS.MATRIX });

    expect([owner.status, editor.status]).toEqual([201, 200]);
    expect(state.items).toHaveLength(1);
  });

  it('returns 404 when retrying a remove of an already-removed item', async () => {
    const added = await addItem(SHARED, { tmdbId: TEST_TMDB_IDS.INCEPTION });
    const { item } = (await added.json()) as { item: { id: string } };

    const first = await removeItem(SHARED, item.id);
    const retry = await removeItem(SHARED, item.id);

    expect([first.status, retry.status]).toEqual([204, 404]);
    await expect(retry.json()).resolves.toEqual({
      error: 'Watchlist item not found.',
    });
  });

  it.each([
    ['a missing tmdbId', {}],
    ['a string tmdbId', { tmdbId: '603' }],
    ['a non-positive tmdbId', { tmdbId: 0 }],
    ['a fractional tmdbId', { tmdbId: 1.5 }],
  ])('returns 400 for %s', async (_label, body) => {
    const response = await addItem(SHARED, body);

    expect(response.status).toBe(400);
    expect(state.items).toEqual([]);
  });

  it('returns 400 for a malformed JSON body', async () => {
    const response = await addItem(SHARED, '{not json');

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Request body must be valid JSON.',
    });
  });

  it('validates the movie with TMDb and adds nothing when it is unknown', async () => {
    const { TMDbRequestError } = await import('../src/lib/tmdb/client');

    mocks.getMovieDetails.mockRejectedValue(
      new TMDbRequestError('Movie not found.', 404),
    );

    const response = await addItem(SHARED, { tmdbId: 999999 });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: 'Movie not found.',
    });
    expect(state.items).toEqual([]);
  });

  it.each([
    ['a missing Authorization header', null],
    ['a malformed Authorization header', ''],
  ])('returns 401 without data access for %s', async (_label, token) => {
    const added = await addItem(SHARED, { tmdbId: 1 }, token);
    const removed = await removeItem(SHARED, 'item', token);

    expect([added.status, removed.status]).toEqual([401, 401]);
    expect(mocks.createSupabaseWatchlistRepository).not.toHaveBeenCalled();
  });

  it('returns 401 for an invalid bearer token', async () => {
    setup(null);

    const response = await addItem(SHARED, { tmdbId: TEST_TMDB_IDS.MATRIX });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized.' });
  });

  it('matches the cookie-surface domain result for the same add', async () => {
    const cookieResult = await addWatchlistItem({
      actorUserId: TEST_USER_IDS.OWNER,
      getMovieDetails: async (tmdbId) => buildNormalizedMovieDetail(tmdbId),
      repository: state.repository,
      tmdbId: TEST_TMDB_IDS.INCEPTION,
      watchlistId: SHARED,
    });
    const response = await addItem(SHARED, { tmdbId: TEST_TMDB_IDS.INCEPTION });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      created: false,
      item: cookieResult.item,
      watchlist: cookieResult.watchlist,
    });
  });
});
