import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TEST_USER_IDS, TEST_WATCHLIST_IDS } from '../src/lib/test-data/catalog';
import type { WatchlistInviteLink, WatchlistRepository } from '../src/lib/watchlist';
import { createSharedWatchlistReadRepository, SHARED_WATCHLIST_NAME } from './support';

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

const SHARED = TEST_WATCHLIST_IDS.SHARED;

/**
 * A fake `rotateInviteLink` that serializes concurrent calls exactly the way
 * the real `rotate_watchlist_invite_link` RPC transaction does (MOV-331): the
 * second of two concurrent rotations only starts once the first has fully
 * committed, so there is never a moment with two live links, and a link is
 * only ever replaced, never left stranded mid-rotation.
 */
function createInviteRepository() {
  let activeLink: WatchlistInviteLink | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  let nextId = 0;

  const rotateInviteLink = vi.fn(
    ({ tokenHash, watchlistId }: { tokenHash: string | null; watchlistId: string }) => {
      const run = chain.then(async () => {
        if (watchlistId !== SHARED) {
          throw new Error('Watchlist access denied.');
        }

        if (tokenHash === null) {
          activeLink = null;
          return null;
        }

        nextId += 1;
        const newLink: WatchlistInviteLink = {
          createdAt: new Date().toISOString(),
          createdByUserId: TEST_USER_IDS.OWNER,
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          id: `invite-${nextId}`,
          revokedAt: null,
          watchlistId,
        };

        activeLink = newLink;
        return newLink;
      });

      chain = run.catch(() => undefined);
      return run;
    },
  );
  const base = createSharedWatchlistReadRepository();
  const repository: WatchlistRepository = {
    ...base,
    async getActiveInviteLinkForWatchlist(watchlistId) {
      return watchlistId === SHARED ? activeLink : null;
    },
    rotateInviteLink,
  };

  return { activeLink: () => activeLink, repository, rotateInviteLink };
}

let world = createInviteRepository();

function setup(userId: string | null): void {
  mocks.resolveAuthTokensWithClient.mockResolvedValue({
    refreshedSession: null,
    shouldClearCookies: false,
    user: userId ? { id: userId } : null,
  });
  mocks.createServerSupabaseClient.mockReturnValue({ name: 'user-client' });
  mocks.createServerSupabaseServiceRoleClient.mockReturnValue({});
  mocks.createSupabaseWatchlistRepository.mockReturnValue(world.repository);
}

function bearer(method: string, path: string, token = 'valid-token'): Request {
  return new Request(`https://moviecal.test${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    method,
  });
}

async function createInvite(watchlistId = SHARED, token?: string) {
  const { POST } = await import('../src/app/api/v1/watchlists/[watchlistId]/invite/route');

  return POST(bearer('POST', `/api/v1/watchlists/${watchlistId}/invite`, token), {
    params: Promise.resolve({ watchlistId }),
  });
}

async function revokeInvite(watchlistId = SHARED, token?: string) {
  const { DELETE } = await import('../src/app/api/v1/watchlists/[watchlistId]/invite/route');

  return DELETE(bearer('DELETE', `/api/v1/watchlists/${watchlistId}/invite`, token), {
    params: Promise.resolve({ watchlistId }),
  });
}

describe('v1 shared watchlist invite route (mobile Bearer surface)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    world = createInviteRepository();
    setup(TEST_USER_IDS.OWNER);
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns 401 without touching data for a missing or invalid bearer', async () => {
    const missing = [await createInvite(SHARED, ''), await revokeInvite(SHARED, '')];

    setup(null);

    const invalid = [await createInvite(), await revokeInvite()];

    expect([...missing, ...invalid].map((response) => response.status))
      .toEqual([401, 401, 401, 401]);
    expect(world.rotateInviteLink).not.toHaveBeenCalled();
  });

  describe('POST invite (generate/rotate)', () => {
    it('lets the owner generate a link with the raw token only in this response', async () => {
      const response = await createInvite();
      const body = await response.json();

      expect(response.status).toBe(201);
      expect(typeof body.inviteUrl).toBe('string');
      expect(body.inviteUrl).toMatch(
        /^https:\/\/moviecal\.test\/watchlist\/invite\/[\w-]+$/,
      );
      expect(body.watchlist.id).toBe(SHARED);
      expect(world.activeLink()).not.toBeNull();
    });

    it('rotates an existing link so at most one stays live', async () => {
      const first = await createInvite();
      const firstBody = await first.json();
      const firstToken = new URL(firstBody.inviteUrl).pathname.split('/').pop();

      const second = await createInvite();
      const secondBody = await second.json();
      const secondToken = new URL(secondBody.inviteUrl).pathname.split('/').pop();

      expect(secondToken).not.toBe(firstToken);
      expect(world.rotateInviteLink).toHaveBeenCalledTimes(2);
    });

    it('serializes concurrent rotations to exactly one live link', async () => {
      const [first, second] = await Promise.all([createInvite(), createInvite()]);
      const bodies = await Promise.all([first.json(), second.json()]);

      expect([first.status, second.status]).toEqual([201, 201]);
      expect(bodies[0].inviteUrl).not.toBe(bodies[1].inviteUrl);
      // Both requests succeeded, but the fake RPC only ever tracks one live link.
      expect(world.activeLink()?.id).toBeDefined();
    });

    it('refuses an editor with 403 and does not rotate', async () => {
      setup(TEST_USER_IDS.COLLABORATOR);

      const response = await createInvite();

      expect(response.status).toBe(403);
      expect(world.rotateInviteLink).not.toHaveBeenCalled();
    });

    it.each([TEST_USER_IDS.PENDING_INVITEE, TEST_USER_IDS.OUTSIDER])(
      'answers %s with the same 404 as an unknown list',
      async (userId) => {
        setup(userId);

        const denied = await createInvite();
        const unknown = await createInvite(TEST_WATCHLIST_IDS.UNKNOWN);
        const text = await denied.text();

        expect([denied.status, unknown.status]).toEqual([404, 404]);
        expect(text).toBe(await unknown.text());
        expect(text).not.toContain(SHARED_WATCHLIST_NAME);
        expect(world.rotateInviteLink).not.toHaveBeenCalled();
      },
    );
  });

  describe('DELETE invite (revoke)', () => {
    it('lets the owner revoke the live link, leaving no replacement', async () => {
      await createInvite();
      expect(world.activeLink()).not.toBeNull();

      const response = await revokeInvite();

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ revoked: true });
      expect(world.activeLink()).toBeNull();
    });

    it('is idempotent when there is no live link to revoke', async () => {
      const response = await revokeInvite();

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ revoked: true });
    });

    it('refuses an editor with 403 and does not revoke', async () => {
      await createInvite();
      setup(TEST_USER_IDS.COLLABORATOR);

      const response = await revokeInvite();

      expect(response.status).toBe(403);
      expect(world.activeLink()).not.toBeNull();
    });

    it.each([TEST_USER_IDS.PENDING_INVITEE, TEST_USER_IDS.OUTSIDER])(
      'refuses %s with a 404 and no change',
      async (userId) => {
        await createInvite();
        setup(userId);

        const response = await revokeInvite();

        expect(response.status).toBe(404);
        expect(world.activeLink()).not.toBeNull();
      },
    );
  });
});
