import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mocks = vi.hoisted(() => ({
  authenticateApiRequest: vi.fn(),
  createSupabaseWatchlistRepository: vi.fn(),
  createSharedWatchlist: vi.fn(),
  createSharedWatchlistInviteLink: vi.fn(),
  acceptWatchlistInvite: vi.fn(),
  removeSharedWatchlistMember: vi.fn(),
  listPersonalWatchlistItems: vi.fn(),
  addPersonalWatchlistItem: vi.fn(),
  addWatchlistItem: vi.fn(),
  removePersonalWatchlistItem: vi.fn(),
  removeWatchlistItem: vi.fn(),
  createServerSupabaseClient: vi.fn(),
  createServerSupabaseServiceRoleClient: vi.fn(),
  getMovieDetails: vi.fn(),
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

vi.mock('../src/lib/tmdb/client', () => ({
  getMovieDetails: mocks.getMovieDetails,
  TMDbEnvironmentError: class TMDbEnvironmentError extends Error {},
  TMDbRequestError: class TMDbRequestError extends Error {
    status: number;

    constructor(message: string, status = 502) {
      super(message);
      this.status = status;
    }
  },
}));

vi.mock('../src/lib/watchlist', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/watchlist')>(
    '../src/lib/watchlist',
  );

  return {
    ...actual,
    createSharedWatchlist: mocks.createSharedWatchlist,
    createSharedWatchlistInviteLink: mocks.createSharedWatchlistInviteLink,
    acceptWatchlistInvite: mocks.acceptWatchlistInvite,
    removeSharedWatchlistMember: mocks.removeSharedWatchlistMember,
    listPersonalWatchlistItems: mocks.listPersonalWatchlistItems,
    addPersonalWatchlistItem: mocks.addPersonalWatchlistItem,
    addWatchlistItem: mocks.addWatchlistItem,
    removePersonalWatchlistItem: mocks.removePersonalWatchlistItem,
    removeWatchlistItem: mocks.removeWatchlistItem,
  };
});

describe('watchlist routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createServerSupabaseClient.mockReturnValue({ name: 'user-client' });
    mocks.createServerSupabaseServiceRoleClient.mockReturnValue({
      name: 'admin-client',
    });
    mocks.createSupabaseWatchlistRepository.mockReturnValue({ name: 'repository' });
    mocks.authenticateApiRequest.mockResolvedValue({
      accessToken: 'access-token',
      user: { id: 'user-1' },
      applyAuthCookies(response: NextResponse) {
        response.cookies.set('sb-access-token', 'refreshed');
      },
    });
  });

  it('returns the user watchlist from GET /api/watchlist', async () => {
    const { GET } = await import('../src/app/api/watchlist/route');

    mocks.listPersonalWatchlistItems.mockResolvedValue([
      {
        id: 'watchlist-item-1',
        addedAt: '2026-06-13T05:00:00.000Z',
        movie: {
          id: 42,
          tmdbId: 603,
          title: 'The Matrix',
          releaseDate: '1999-03-31',
          overview: 'A hacker discovers the truth.',
          posterPath: '/poster.jpg',
        },
      },
    ]);

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
            posterPath: '/poster.jpg',
          },
        },
      ],
    });
    expect(mocks.listPersonalWatchlistItems).toHaveBeenCalledWith({
      repository: { name: 'repository' },
      userId: 'user-1',
    });
  });

  it('returns 201 from POST /api/watchlist when a movie is newly added', async () => {
    const { POST } = await import('../src/app/api/watchlist/route');

    mocks.addPersonalWatchlistItem.mockResolvedValue({
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
          posterPath: '/poster.jpg',
        },
      },
      watchlist: {
        canEdit: true,
        id: 'personal-watchlist-1',
        kind: 'personal',
        name: 'My watchlist',
        ownerUserId: 'user-1',
      },
    });

    const response = await POST(
      new NextRequest('https://moviecal.test/api/watchlist', {
        method: 'POST',
        body: JSON.stringify({ tmdb_id: 603 }),
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
          posterPath: '/poster.jpg',
        },
      },
      watchlist: {
        canEdit: true,
        id: 'personal-watchlist-1',
        kind: 'personal',
        name: 'My watchlist',
        ownerUserId: 'user-1',
      },
    });
    expect(mocks.addPersonalWatchlistItem).toHaveBeenCalledWith({
      getMovieDetails: mocks.getMovieDetails,
      repository: { name: 'repository' },
      tmdbId: 603,
      userId: 'user-1',
    });
  });

  it('routes POST /api/watchlist to the explicit watchlist target when watchlist_id is present', async () => {
    const { POST } = await import('../src/app/api/watchlist/route');

    mocks.addWatchlistItem.mockResolvedValue({
      created: true,
      item: {
        id: 'watchlist-item-2',
        addedAt: '2026-06-13T05:00:00.000Z',
        movie: {
          id: 42,
          tmdbId: 603,
          title: 'The Matrix',
          releaseDate: '1999-03-31',
          overview: 'A hacker discovers the truth.',
          posterPath: '/poster.jpg',
        },
      },
      watchlist: {
        canEdit: true,
        id: 'shared-watchlist-1',
        kind: 'shared',
        name: 'Friday movie night',
        ownerUserId: 'user-1',
      },
    });

    const response = await POST(
      new NextRequest('https://moviecal.test/api/watchlist', {
        method: 'POST',
        body: JSON.stringify({ tmdb_id: 603, watchlist_id: 'shared-watchlist-1' }),
        headers: {
          'content-type': 'application/json',
        },
      }),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      created: true,
      item: {
        id: 'watchlist-item-2',
        addedAt: '2026-06-13T05:00:00.000Z',
        movie: {
          id: 42,
          tmdbId: 603,
          title: 'The Matrix',
          releaseDate: '1999-03-31',
          overview: 'A hacker discovers the truth.',
          posterPath: '/poster.jpg',
        },
      },
      watchlist: {
        canEdit: true,
        id: 'shared-watchlist-1',
        kind: 'shared',
        name: 'Friday movie night',
        ownerUserId: 'user-1',
      },
    });
    expect(mocks.addWatchlistItem).toHaveBeenCalledWith({
      actorUserId: 'user-1',
      getMovieDetails: mocks.getMovieDetails,
      repository: { name: 'repository' },
      tmdbId: 603,
      watchlistId: 'shared-watchlist-1',
    });
    expect(mocks.addPersonalWatchlistItem).not.toHaveBeenCalled();
  });

  it('returns 400 from POST /api/watchlist when tmdb_id is invalid', async () => {
    const { POST } = await import('../src/app/api/watchlist/route');

    const response = await POST(
      new NextRequest('https://moviecal.test/api/watchlist', {
        method: 'POST',
        body: JSON.stringify({ tmdb_id: '603' }),
        headers: {
          'content-type': 'application/json',
        },
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'A valid tmdb_id is required.',
    });
    expect(mocks.addPersonalWatchlistItem).not.toHaveBeenCalled();
  });

  it('returns 404 from DELETE /api/watchlist/[id] for another user item', async () => {
    const { DELETE } = await import('../src/app/api/watchlist/[id]/route');
    const { WatchlistNotFoundError } = await import('../src/lib/watchlist');

    mocks.removePersonalWatchlistItem.mockRejectedValue(
      new WatchlistNotFoundError('Watchlist item not found.'),
    );

    const response = await DELETE(
      new NextRequest('https://moviecal.test/api/watchlist/watchlist-item-2', {
        method: 'DELETE',
      }),
      { params: Promise.resolve({ id: 'watchlist-item-2' }) },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: 'Watchlist item not found.',
    });
    expect(mocks.removePersonalWatchlistItem).toHaveBeenCalledWith({
      itemId: 'watchlist-item-2',
      repository: { name: 'repository' },
      userId: 'user-1',
    });
  });

  it('routes DELETE /api/watchlist/[id] to the explicit watchlist target when watchlist_id is present', async () => {
    const { DELETE } = await import('../src/app/api/watchlist/[id]/route');

    mocks.removeWatchlistItem.mockResolvedValue(undefined);

    const response = await DELETE(
      new NextRequest(
        'https://moviecal.test/api/watchlist/watchlist-item-2?watchlist_id=shared-watchlist-1',
        {
          method: 'DELETE',
        },
      ),
      { params: Promise.resolve({ id: 'watchlist-item-2' }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      deleted: true,
      id: 'watchlist-item-2',
    });
    expect(mocks.removeWatchlistItem).toHaveBeenCalledWith({
      actorUserId: 'user-1',
      itemId: 'watchlist-item-2',
      repository: { name: 'repository' },
      watchlistId: 'shared-watchlist-1',
    });
    expect(mocks.removePersonalWatchlistItem).not.toHaveBeenCalled();
  });

  it('returns 201 from POST /api/watchlist/shared when a shared watchlist is created', async () => {
    const { POST } = await import('../src/app/api/watchlist/shared/route');

    mocks.createSharedWatchlist.mockResolvedValue({
      canEdit: true,
      id: 'shared-watchlist-1',
      kind: 'shared',
      name: 'Friday movie night',
      ownerUserId: 'user-1',
    });

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
    await expect(response.json()).resolves.toEqual({
      watchlist: {
        canEdit: true,
        id: 'shared-watchlist-1',
        kind: 'shared',
        name: 'Friday movie night',
        ownerUserId: 'user-1',
      },
    });
    expect(mocks.createSharedWatchlist).toHaveBeenCalledWith({
      name: 'Friday movie night',
      repository: { name: 'repository' },
      userId: 'user-1',
    });
  });

  it('returns 400 from POST /api/watchlist/shared when the name is missing', async () => {
    const { POST } = await import('../src/app/api/watchlist/shared/route');

    const response = await POST(
      new NextRequest('https://moviecal.test/api/watchlist/shared', {
        method: 'POST',
        body: JSON.stringify({}),
        headers: {
          'content-type': 'application/json',
        },
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'A shared watchlist name is required.',
    });
    expect(mocks.createSharedWatchlist).not.toHaveBeenCalled();
  });

  it('returns 201 from POST /api/watchlist/shared/[watchlistId]/invite when a link is created', async () => {
    const { POST } = await import(
      '../src/app/api/watchlist/shared/[watchlistId]/invite/route'
    );

    mocks.createSharedWatchlistInviteLink.mockResolvedValue({
      inviteUrl: 'https://moviecal.test/watchlist/invite/secret-token',
      watchlist: {
        id: 'shared-watchlist-1',
        kind: 'shared',
        name: 'Friday movie night',
        ownerUserId: 'user-1',
      },
    });

    const response = await POST(
      new NextRequest('https://moviecal.test/api/watchlist/shared/shared-watchlist-1/invite', {
        method: 'POST',
      }),
      { params: Promise.resolve({ watchlistId: 'shared-watchlist-1' }) },
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      inviteUrl: 'https://moviecal.test/watchlist/invite/secret-token',
      watchlist: {
        id: 'shared-watchlist-1',
        kind: 'shared',
        name: 'Friday movie night',
        ownerUserId: 'user-1',
      },
    });
    expect(mocks.createSharedWatchlistInviteLink).toHaveBeenCalledWith({
      actorUserId: 'user-1',
      baseUrl: 'https://moviecal.test',
      repository: { name: 'repository' },
      watchlistId: 'shared-watchlist-1',
    });
  });

  it('returns 200 from POST /api/watchlist/invite/accept when a user joins', async () => {
    const { POST } = await import('../src/app/api/watchlist/invite/accept/route');

    mocks.acceptWatchlistInvite.mockResolvedValue({
      joined: true,
      watchlist: {
        id: 'shared-watchlist-1',
        kind: 'shared',
        name: 'Friday movie night',
        ownerUserId: 'user-1',
      },
    });

    const response = await POST(
      new NextRequest('https://moviecal.test/api/watchlist/invite/accept', {
        method: 'POST',
        body: JSON.stringify({ token: 'secret-token' }),
        headers: {
          'content-type': 'application/json',
        },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      joined: true,
      watchlist: {
        id: 'shared-watchlist-1',
        kind: 'shared',
        name: 'Friday movie night',
        ownerUserId: 'user-1',
      },
    });
    expect(mocks.acceptWatchlistInvite).toHaveBeenCalledWith({
      actorUserId: 'user-1',
      repository: { name: 'repository' },
      token: 'secret-token',
    });
  });

  it('returns 200 from DELETE /api/watchlist/shared/[watchlistId]/members/[membershipId]', async () => {
    const { DELETE } = await import(
      '../src/app/api/watchlist/shared/[watchlistId]/members/[membershipId]/route'
    );

    mocks.removeSharedWatchlistMember.mockResolvedValue(undefined);

    const response = await DELETE(
      new NextRequest(
        'https://moviecal.test/api/watchlist/shared/shared-watchlist-1/members/membership-1',
        {
          method: 'DELETE',
        },
      ),
      {
        params: Promise.resolve({
          membershipId: 'membership-1',
          watchlistId: 'shared-watchlist-1',
        }),
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      deleted: true,
      membershipId: 'membership-1',
    });
    expect(mocks.removeSharedWatchlistMember).toHaveBeenCalledWith({
      actorUserId: 'user-1',
      membershipId: 'membership-1',
      repository: { name: 'repository' },
      watchlistId: 'shared-watchlist-1',
    });
  });
});
