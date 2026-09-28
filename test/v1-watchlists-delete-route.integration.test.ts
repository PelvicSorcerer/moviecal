import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TEST_USER_IDS, TEST_WATCHLIST_IDS } from '../src/lib/test-data/catalog';
import {
  createSharedWatchlistReadRepository,
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

const deleteSharedWatchlistOwnedBy = vi.fn(async () => true);
const repository = createSharedWatchlistReadRepository({
  deleteSharedWatchlistOwnedBy,
});

function setup(userId: string | null): void {
  mocks.resolveAuthTokensWithClient.mockResolvedValue({
    refreshedSession: null,
    shouldClearCookies: false,
    user: userId ? { id: userId } : null,
  });
  mocks.createServerSupabaseClient.mockReturnValue({ name: 'user-client' });
  mocks.createServerSupabaseServiceRoleClient.mockReturnValue({
    name: 'service-role-client',
  });
  mocks.createSupabaseWatchlistRepository.mockReturnValue(repository);
}

async function remove(watchlistId: string, token: string | null = 'valid-token') {
  const { DELETE } = await import('../src/app/api/v1/watchlists/[watchlistId]/route');
  const headers = new Headers();

  if (token !== null) {
    headers.set('authorization', `Bearer ${token}`);
  }

  return DELETE(
    new Request(`https://moviecal.test/api/v1/watchlists/${watchlistId}`, {
      headers,
      method: 'DELETE',
    }),
    { params: Promise.resolve({ watchlistId }) },
  );
}

describe('DELETE /api/v1/watchlists/{id} (mobile Bearer surface)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setup(TEST_USER_IDS.OWNER);
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns 401 without touching data for a missing bearer token', async () => {
    const response = await remove(TEST_WATCHLIST_IDS.SHARED, null);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized.' });
    expect(mocks.createSupabaseWatchlistRepository).not.toHaveBeenCalled();
    expect(deleteSharedWatchlistOwnedBy).not.toHaveBeenCalled();
  });

  it('returns 401 for an invalid bearer token', async () => {
    setup(null);

    const response = await remove(TEST_WATCHLIST_IDS.SHARED);

    expect(response.status).toBe(401);
    expect(deleteSharedWatchlistOwnedBy).not.toHaveBeenCalled();
  });

  it('lets the owner delete with an empty 204', async () => {
    const response = await remove(TEST_WATCHLIST_IDS.SHARED);

    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(deleteSharedWatchlistOwnedBy).toHaveBeenCalledWith({
      ownerUserId: TEST_USER_IDS.OWNER,
      watchlistId: TEST_WATCHLIST_IDS.SHARED,
    });
  });

  it.each([
    ['an accepted editor', TEST_USER_IDS.COLLABORATOR],
    ['an outsider', TEST_USER_IDS.OUTSIDER],
    ['a pending invitee', TEST_USER_IDS.PENDING_INVITEE],
  ])('refuses %s with 403 and deletes nothing', async (_label, userId) => {
    setup(userId);

    const response = await remove(TEST_WATCHLIST_IDS.SHARED);
    const body = await response.text();

    expect(response.status).toBe(403);
    expect(JSON.parse(body)).toEqual({ error: 'Watchlist access denied.' });
    expect(body).not.toContain(SHARED_WATCHLIST_NAME);
    expect(deleteSharedWatchlistOwnedBy).not.toHaveBeenCalled();
  });

  it('refuses deleting a personal list and deletes nothing', async () => {
    const response = await remove(personalWatchlistIdFor(TEST_USER_IDS.OWNER));

    expect(response.status).toBe(403);
    expect(deleteSharedWatchlistOwnedBy).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown list', async () => {
    const response = await remove(TEST_WATCHLIST_IDS.UNKNOWN);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: 'Watchlist not found.',
    });
  });

  it('returns 404 when persistence matched no row', async () => {
    deleteSharedWatchlistOwnedBy.mockResolvedValueOnce(false);

    const response = await remove(TEST_WATCHLIST_IDS.SHARED);

    expect(response.status).toBe(404);
  });
});
