import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

import {
  getTestMovieCatalogEntry,
  TEST_TMDB_IDS,
  TEST_USER_IDS,
  TEST_WATCHLIST_IDS,
} from '../src/lib/test-data/catalog';
import {
  hashWatchlistInviteToken,
  type ResolvedWatchlistInvite,
  type WatchlistInviteLink,
  type WatchlistMember,
  type WatchlistRow,
  type WatchlistSummary,
} from '../src/lib/watchlist';
import {
  buildNormalizedMovieDetail,
  buildWatchlistInviteLink,
  buildWatchlistMember,
  buildWatchlistRow,
  buildWatchlistSummary,
  createWatchlistRepository,
} from './support';

const INVITE_TOKEN = 'test-shared-invite-token';

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

function createSharedRegressionRepository(options?: {
  initialPersonalItems?: WatchlistRow[];
  initialSharedItems?: WatchlistRow[];
  members?: WatchlistMember[];
  inviteLink?: ResolvedWatchlistInvite | null;
}) {
  const personalItem = buildWatchlistRow(TEST_TMDB_IDS.MATRIX, {
    id: 'watchlist-item-personal',
  });
  const sharedItem = buildWatchlistRow(TEST_TMDB_IDS.MATRIX, {
    id: 'watchlist-item-shared',
  });
  const itemsByWatchlist = new Map<string, WatchlistRow[]>([
    [
      TEST_WATCHLIST_IDS.PERSONAL,
      [...(options?.initialPersonalItems ?? [personalItem])],
    ],
    [
      TEST_WATCHLIST_IDS.SHARED,
      [...(options?.initialSharedItems ?? [sharedItem])],
    ],
  ]);
  const members = [...(options?.members ?? [])];
  let inviteLink = options?.inviteLink ?? null;
  const createdWatchlists: WatchlistSummary[] = [];

  function getItems(watchlistId: string): WatchlistRow[] {
    return itemsByWatchlist.get(watchlistId) ?? [];
  }

  const sharedWatchlist = buildWatchlistSummary({
    id: TEST_WATCHLIST_IDS.SHARED,
    kind: 'shared',
    name: 'Friday movie night',
  });

  return {
    createdWatchlists,
    repository: createWatchlistRepository({
      async createWatchlist(args) {
        const watchlist = buildWatchlistSummary({
          id: 'shared-watchlist-new',
          kind: args.kind,
          name: args.name,
          ownerUserId: args.ownerUserId,
        });

        createdWatchlists.push(watchlist);
        itemsByWatchlist.set(watchlist.id, []);

        return watchlist;
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
      async findInviteLinkByTokenHash(tokenHash) {
        if (
          inviteLink
          && hashWatchlistInviteToken(INVITE_TOKEN) === tokenHash
        ) {
          return inviteLink;
        }

        return null;
      },
      async findMembershipForUser(watchlistId, userId) {
        return (
          members.find(
            (member) =>
              member.watchlistId === watchlistId && member.userId === userId,
          ) ?? null
        );
      },
      async acceptInviteMembership(args) {
        const member = buildWatchlistMember({
          acceptedAt: args.acceptedAt,
          invitedByUserId: args.invitedByUserId,
          userId: args.userId,
          watchlistId: args.watchlistId,
        });

        members.push(member);

        return member;
      },
      async createInviteLink(args) {
        const link = buildWatchlistInviteLink({
          createdByUserId: args.createdByUserId,
          id: 'invite-new',
          watchlistId: args.watchlistId,
        });

        inviteLink = {
          inviteLink: link,
          watchlist: sharedWatchlist,
        };

        return link;
      },
      async revokeInviteLinksForWatchlist() {
        inviteLink = null;
      },
      async getActiveInviteLinkForWatchlist(watchlistId) {
        return inviteLink?.watchlist.id === watchlistId
          ? inviteLink.inviteLink
          : null;
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
            watchlist: sharedWatchlist,
            canEdit: true,
          };
        }

        if (
          actorUserId === TEST_USER_IDS.COLLABORATOR
          && watchlistId === TEST_WATCHLIST_IDS.SHARED
        ) {
          return {
            status: 'authorized' as const,
            watchlist: sharedWatchlist,
            canEdit: true,
          };
        }

        return {
          status: 'forbidden' as const,
        };
      },
      async insertItemForWatchlist(watchlistId, movieId) {
        const items = getItems(watchlistId);
        const existing = items.find((row) => row.movie?.id === movieId);

        if (existing) {
          return { row: null, errorCode: '23505' };
        }

        const catalogEntry = Object.values({
          [TEST_TMDB_IDS.MATRIX]: getTestMovieCatalogEntry(TEST_TMDB_IDS.MATRIX),
          [TEST_TMDB_IDS.INCEPTION]: getTestMovieCatalogEntry(TEST_TMDB_IDS.INCEPTION),
        }).find((entry) => entry?.dbId === movieId);
        const tmdbId = catalogEntry?.detail.tmdbId ?? TEST_TMDB_IDS.MATRIX;
        const row = buildWatchlistRow(tmdbId, {
          id: `watchlist-item-${watchlistId}-${items.length + 1}`,
        });

        itemsByWatchlist.set(watchlistId, [...items, row]);

        return { row, errorCode: null };
      },
      async listItemsForWatchlist(watchlistId) {
        return [...getItems(watchlistId)];
      },
      async listMembersForWatchlist(watchlistId) {
        return members.filter((member) => member.watchlistId === watchlistId);
      },
      async removeMembershipFromWatchlist(watchlistId, membershipId) {
        const index = members.findIndex(
          (member) =>
            member.watchlistId === watchlistId && member.id === membershipId,
        );

        if (index === -1) {
          return false;
        }

        members.splice(index, 1);

        return true;
      },
      async upsertMovie(detail) {
        const catalogEntry = getTestMovieCatalogEntry(detail.tmdbId);

        return { id: catalogEntry?.dbId ?? 42 };
      },
    }),
    getItems,
    getMembers: () => [...members],
  };
}

function setupAuthenticatedRouteMocks(
  repository = createSharedRegressionRepository().repository,
) {
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

function setupCollaboratorAuth() {
  mocks.authenticateApiRequest.mockResolvedValue({
    accessToken: 'access-token',
    user: { id: TEST_USER_IDS.COLLABORATOR },
    applyAuthCookies(response: NextResponse) {
      response.cookies.set('sb-access-token', 'refreshed');
    },
  });
}

describe('shared watchlist regression integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('does not remove the same movie from personal when deleting from shared target', async () => {
    const { repository } = createSharedRegressionRepository();
    setupAuthenticatedRouteMocks(repository);

    const { DELETE } = await import('../src/app/api/watchlist/[id]/route');
    const response = await DELETE(
      new NextRequest(
        `https://moviecal.test/api/watchlist/watchlist-item-shared?watchlist_id=${TEST_WATCHLIST_IDS.SHARED}`,
        { method: 'DELETE' },
      ),
      { params: Promise.resolve({ id: 'watchlist-item-shared' }) },
    );

    expect(response.status).toBe(200);

    const { GET } = await import('../src/app/api/watchlist/route');
    const personalResponse = await GET(
      new NextRequest('https://moviecal.test/api/watchlist'),
    );

    await expect(personalResponse.json()).resolves.toMatchObject({
      items: [
        {
          id: 'watchlist-item-personal',
          movie: { tmdbId: TEST_TMDB_IDS.MATRIX },
        },
      ],
    });
  });

  it('defaults DELETE /api/watchlist/[id] to personal and leaves shared items intact', async () => {
    const { repository } = createSharedRegressionRepository();
    setupAuthenticatedRouteMocks(repository);

    const { DELETE } = await import('../src/app/api/watchlist/[id]/route');
    const response = await DELETE(
      new NextRequest(
        'https://moviecal.test/api/watchlist/watchlist-item-personal',
        { method: 'DELETE' },
      ),
      { params: Promise.resolve({ id: 'watchlist-item-personal' }) },
    );

    expect(response.status).toBe(200);

    const { GET } = await import('../src/app/api/watchlist/route');
    const personalResponse = await GET(
      new NextRequest('https://moviecal.test/api/watchlist'),
    );

    await expect(personalResponse.json()).resolves.toEqual({ items: [] });

    const sharedItems = await repository.listItemsForWatchlist(
      TEST_WATCHLIST_IDS.SHARED,
    );

    expect(sharedItems).toHaveLength(1);
    expect(sharedItems[0]?.id).toBe('watchlist-item-shared');
  });

  it('creates a shared watchlist through POST /api/watchlist/shared', async () => {
    const { createdWatchlists, repository } = createSharedRegressionRepository();
    setupAuthenticatedRouteMocks(repository);

    const { POST } = await import('../src/app/api/watchlist/shared/route');
    const response = await POST(
      new NextRequest('https://moviecal.test/api/watchlist/shared', {
        method: 'POST',
        body: JSON.stringify({ name: 'Friday movie night' }),
        headers: {
          'content-type': 'application/json',
        },
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      watchlist: {
        id: 'shared-watchlist-new',
        kind: 'shared',
        name: 'Friday movie night',
        ownerUserId: TEST_USER_IDS.OWNER,
      },
    });
    expect(createdWatchlists).toHaveLength(1);
  });

  it('accepts a shared watchlist invite for a new collaborator', async () => {
    const inviteLink: ResolvedWatchlistInvite = {
      inviteLink: buildWatchlistInviteLink(),
      watchlist: buildWatchlistSummary({
        id: TEST_WATCHLIST_IDS.SHARED,
        kind: 'shared',
        name: 'Friday movie night',
      }),
    };
    const { getMembers, repository } = createSharedRegressionRepository({
      inviteLink,
    });

    setupCollaboratorAuth();
    mocks.createSupabaseWatchlistRepository.mockReturnValue(repository);

    const { POST } = await import('../src/app/api/watchlist/invite/accept/route');
    const response = await POST(
      new NextRequest('https://moviecal.test/api/watchlist/invite/accept', {
        method: 'POST',
        body: JSON.stringify({ token: INVITE_TOKEN }),
        headers: {
          'content-type': 'application/json',
        },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      joined: true,
      watchlist: {
        id: TEST_WATCHLIST_IDS.SHARED,
        kind: 'shared',
        name: 'Friday movie night',
      },
    });
    expect(getMembers()).toHaveLength(1);
    expect(getMembers()[0]?.userId).toBe(TEST_USER_IDS.COLLABORATOR);
  });

  it('returns joined false when the watchlist owner accepts their own invite link', async () => {
    const inviteLink: ResolvedWatchlistInvite = {
      inviteLink: buildWatchlistInviteLink(),
      watchlist: buildWatchlistSummary({
        id: TEST_WATCHLIST_IDS.SHARED,
        kind: 'shared',
        name: 'Friday movie night',
      }),
    };
    const { getMembers, repository } = createSharedRegressionRepository({
      inviteLink,
    });

    setupAuthenticatedRouteMocks(repository);

    const { POST } = await import('../src/app/api/watchlist/invite/accept/route');
    const response = await POST(
      new NextRequest('https://moviecal.test/api/watchlist/invite/accept', {
        method: 'POST',
        body: JSON.stringify({ token: INVITE_TOKEN }),
        headers: {
          'content-type': 'application/json',
        },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      joined: false,
      watchlist: {
        id: TEST_WATCHLIST_IDS.SHARED,
      },
    });
    expect(getMembers()).toHaveLength(0);
  });

  it('creates an invite link for the shared watchlist owner', async () => {
    const { repository } = createSharedRegressionRepository();
    setupAuthenticatedRouteMocks(repository);

    const { POST } = await import(
      '../src/app/api/watchlist/shared/[watchlistId]/invite/route'
    );
    const response = await POST(
      new NextRequest(
        `https://moviecal.test/api/watchlist/shared/${TEST_WATCHLIST_IDS.SHARED}/invite`,
        { method: 'POST' },
      ),
      { params: Promise.resolve({ watchlistId: TEST_WATCHLIST_IDS.SHARED }) },
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      inviteUrl: expect.stringContaining('/watchlist/invite/'),
      watchlist: {
        id: TEST_WATCHLIST_IDS.SHARED,
        kind: 'shared',
      },
    });
  });

  it('returns 403 when a non-owner tries to create a shared watchlist invite link', async () => {
    const { repository } = createSharedRegressionRepository();
    setupCollaboratorAuth();
    mocks.createSupabaseWatchlistRepository.mockReturnValue(repository);

    const { POST } = await import(
      '../src/app/api/watchlist/shared/[watchlistId]/invite/route'
    );
    const response = await POST(
      new NextRequest(
        `https://moviecal.test/api/watchlist/shared/${TEST_WATCHLIST_IDS.SHARED}/invite`,
        { method: 'POST' },
      ),
      { params: Promise.resolve({ watchlistId: TEST_WATCHLIST_IDS.SHARED }) },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'Watchlist access denied.',
    });
  });

  it('removes a shared watchlist member for the owner', async () => {
    const member = buildWatchlistMember({ id: 'membership-1' });
    const { getMembers, repository } = createSharedRegressionRepository({
      members: [member],
    });

    setupAuthenticatedRouteMocks(repository);

    const { DELETE } = await import(
      '../src/app/api/watchlist/shared/[watchlistId]/members/[membershipId]/route'
    );
    const response = await DELETE(
      new NextRequest(
        `https://moviecal.test/api/watchlist/shared/${TEST_WATCHLIST_IDS.SHARED}/members/membership-1`,
        { method: 'DELETE' },
      ),
      {
        params: Promise.resolve({
          membershipId: 'membership-1',
          watchlistId: TEST_WATCHLIST_IDS.SHARED,
        }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      deleted: true,
      membershipId: 'membership-1',
    });
    expect(getMembers()).toHaveLength(0);
  });

  it('returns 403 when a non-owner tries to remove a shared watchlist member', async () => {
    const member = buildWatchlistMember({ id: 'membership-1' });
    const { getMembers, repository } = createSharedRegressionRepository({
      members: [member],
    });

    setupCollaboratorAuth();
    mocks.createSupabaseWatchlistRepository.mockReturnValue(repository);

    const { DELETE } = await import(
      '../src/app/api/watchlist/shared/[watchlistId]/members/[membershipId]/route'
    );
    const response = await DELETE(
      new NextRequest(
        `https://moviecal.test/api/watchlist/shared/${TEST_WATCHLIST_IDS.SHARED}/members/membership-1`,
        { method: 'DELETE' },
      ),
      {
        params: Promise.resolve({
          membershipId: 'membership-1',
          watchlistId: TEST_WATCHLIST_IDS.SHARED,
        }),
      },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'Watchlist access denied.',
    });
    expect(getMembers()).toHaveLength(1);
  });
});
