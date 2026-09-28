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

const createWatchlist = vi.fn();
const renameWatchlist = vi.fn();

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
  mocks.createSupabaseWatchlistRepository.mockReturnValue(
    createSharedWatchlistReadRepository({ createWatchlist, renameWatchlist }),
  );
}

function jsonRequest(method: string, path: string, body?: unknown, token = 'valid-token') {
  const headers = new Headers({ 'content-type': 'application/json' });

  if (token) {
    headers.set('authorization', `Bearer ${token}`);
  }

  return new Request(`https://moviecal.test${path}`, {
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers,
    method,
  });
}

async function create(body: unknown, token?: string) {
  const { POST } = await import('../src/app/api/v1/watchlists/route');

  return POST(jsonRequest('POST', '/api/v1/watchlists', body, token));
}

async function rename(watchlistId: string, body: unknown, token?: string) {
  const { PATCH } = await import('../src/app/api/v1/watchlists/[watchlistId]/route');

  return PATCH(jsonRequest('PATCH', `/api/v1/watchlists/${watchlistId}`, body, token), {
    params: Promise.resolve({ watchlistId }),
  });
}

describe('v1 shared list create and rename (mobile Bearer surface)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setup(TEST_USER_IDS.OWNER);
    createWatchlist.mockImplementation(async (args: { name: string; ownerUserId: string }) => ({
      canEdit: true,
      id: 'new-shared-list',
      kind: 'shared',
      name: args.name,
      ownerUserId: args.ownerUserId,
    }));
    renameWatchlist.mockImplementation(async (args: { name: string; watchlistId: string }) => ({
      canEdit: true,
      id: args.watchlistId,
      kind: 'shared',
      name: args.name,
      ownerUserId: TEST_USER_IDS.OWNER,
    }));
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('requires a bearer token before touching data', async () => {
    const created = await create({ name: 'x' }, '');
    const renamed = await rename(TEST_WATCHLIST_IDS.SHARED, { name: 'x' }, '');

    expect([created.status, renamed.status]).toEqual([401, 401]);
    await expect(renamed.json()).resolves.toEqual({ error: 'Unauthorized.' });
    expect(mocks.createSupabaseWatchlistRepository).not.toHaveBeenCalled();
  });

  it('creates a shared list for the owner with a normalized name', async () => {
    const response = await create({ name: '  Date   night ' });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      watchlist: {
        canEdit: true,
        id: 'new-shared-list',
        kind: 'shared',
        name: 'Date night',
        ownerUserId: TEST_USER_IDS.OWNER,
        role: 'owner',
      },
    });
    expect(createWatchlist).toHaveBeenCalledWith({
      kind: 'shared',
      name: 'Date night',
      ownerUserId: TEST_USER_IDS.OWNER,
    });
  });

  it.each([
    ['a missing name', {}, 'A shared watchlist name is required.'],
    ['a non-string name', { name: 5 }, 'A shared watchlist name is required.'],
    ['a blank name', { name: '   ' }, 'A shared watchlist name is required.'],
    [
      'an over-long name',
      { name: 'x'.repeat(81) },
      'Shared watchlist names must be 80 characters or fewer.',
    ],
    ['a non-JSON body', 'not json', 'Request body must be valid JSON.'],
  ])('rejects create with %s', async (_label, body, error) => {
    const response = await create(body);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error });
    expect(createWatchlist).not.toHaveBeenCalled();
  });

  it.each([
    ['owner', TEST_USER_IDS.OWNER, 'owner'],
    ['accepted editor', TEST_USER_IDS.COLLABORATOR, 'editor'],
  ])('lets the %s rename the shared list', async (_label, userId, role) => {
    setup(userId);

    const response = await rename(TEST_WATCHLIST_IDS.SHARED, { name: ' New  name ' });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      watchlist: {
        canEdit: true,
        id: TEST_WATCHLIST_IDS.SHARED,
        kind: 'shared',
        name: 'New name',
        ownerUserId: TEST_USER_IDS.OWNER,
        role,
      },
    });
  });

  it('is idempotent when the same rename is retried', async () => {
    const first = await (await rename(TEST_WATCHLIST_IDS.SHARED, { name: 'Same' })).json();
    const second = await (await rename(TEST_WATCHLIST_IDS.SHARED, { name: 'Same' })).json();

    expect(second).toEqual(first);
  });

  it.each([
    ['blank', { name: ' ' }],
    ['non-string', { name: null }],
    ['over-long', { name: 'x'.repeat(81) }],
  ])('rejects a %s rename name with 400 and no write', async (_label, body) => {
    const response = await rename(TEST_WATCHLIST_IDS.SHARED, body);

    expect(response.status).toBe(400);
    expect(renameWatchlist).not.toHaveBeenCalled();
  });

  it.each([
    ['pending invitee', TEST_USER_IDS.PENDING_INVITEE],
    ['outsider', TEST_USER_IDS.OUTSIDER],
  ])('answers a %s exactly like an unknown list, without writing', async (_label, userId) => {
    setup(userId);

    const denied = await rename(TEST_WATCHLIST_IDS.SHARED, { name: 'Hijack' });
    const unknown = await rename(TEST_WATCHLIST_IDS.UNKNOWN, { name: 'Hijack' });
    const overlong = await rename(TEST_WATCHLIST_IDS.SHARED, { name: 'x'.repeat(81) });
    const deniedBody = await denied.text();

    expect([denied.status, unknown.status, overlong.status]).toEqual([404, 404, 404]);
    expect(JSON.parse(deniedBody)).toEqual({ error: 'Watchlist not found.' });
    expect(deniedBody).toBe(await unknown.text());
    expect(deniedBody).not.toContain(SHARED_WATCHLIST_NAME);
    expect(renameWatchlist).not.toHaveBeenCalled();
  });

  it('refuses to rename a personal list, even the caller\'s own', async () => {
    const response = await rename(personalWatchlistIdFor(TEST_USER_IDS.OWNER), {
      name: 'Renamed',
    });

    expect(response.status).toBe(404);
    expect(renameWatchlist).not.toHaveBeenCalled();
  });

  it('answers 404 when access is revoked between the check and the write', async () => {
    renameWatchlist.mockResolvedValue(null);

    const response = await rename(TEST_WATCHLIST_IDS.SHARED, { name: 'Late' });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Watchlist not found.' });
  });
});
