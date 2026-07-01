import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const mocks = vi.hoisted(() => ({
  requireAuthenticatedPageSession: vi.fn(),
  createServerSupabaseClient: vi.fn(),
  createServerSupabaseServiceRoleClient: vi.fn(),
  createSupabaseWatchlistRepository: vi.fn(),
  cookies: vi.fn(),
  getWatchlistDetail: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('../src/lib/auth/session', () => ({
  requireAuthenticatedPageSession: mocks.requireAuthenticatedPageSession,
}));

vi.mock('../src/lib/supabase/server', () => ({
  createServerSupabaseClient: mocks.createServerSupabaseClient,
  createServerSupabaseServiceRoleClient: mocks.createServerSupabaseServiceRoleClient,
}));

vi.mock('next/headers', () => ({
  cookies: mocks.cookies,
}));

vi.mock('../src/lib/supabase/watchlist', () => ({
  createSupabaseWatchlistRepository: mocks.createSupabaseWatchlistRepository,
}));

vi.mock('next/navigation', () => ({
  notFound: mocks.notFound,
}));

vi.mock('../src/lib/watchlist', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/watchlist')>(
    '../src/lib/watchlist',
  );

  return {
    ...actual,
    getWatchlistDetail: mocks.getWatchlistDetail,
  };
});

describe('watchlist detail page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuthenticatedPageSession.mockResolvedValue({
      accessToken: 'access-token',
      user: {
        id: 'user-1',
        email: 'dev@example.com',
      },
    });
    mocks.createServerSupabaseClient.mockReturnValue({ name: 'user-client' });
    mocks.createServerSupabaseServiceRoleClient.mockReturnValue({ name: 'admin-client' });
    mocks.createSupabaseWatchlistRepository.mockReturnValue({ name: 'repository' });
    mocks.cookies.mockResolvedValue({});
  });

  it('renders the authorized watchlist detail page', async () => {
    mocks.getWatchlistDetail.mockResolvedValue({
      watchlist: {
        canEdit: true,
        id: 'shared-watchlist-1',
        kind: 'shared',
        name: 'Friday movie night',
        ownerUserId: 'user-2',
      },
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

    const { default: WatchlistDetailPage } = await import(
      '../src/app/watchlist/[watchlistId]/page'
    );
    const markup = renderToStaticMarkup(
      await WatchlistDetailPage({
        params: Promise.resolve({ watchlistId: 'shared-watchlist-1' }),
      }),
    );

    expect(markup).toContain('Friday movie night');
    expect(markup).toContain('The Matrix');
    expect(markup).toContain('Back to watchlists');
    expect(mocks.getWatchlistDetail).toHaveBeenCalledWith({
      actorUserId: 'user-1',
      repository: { name: 'repository' },
      watchlistId: 'shared-watchlist-1',
    });
  });

  it('fails closed for unauthorized detail access', async () => {
    const { WatchlistAccessError } = await import('../src/lib/watchlist');
    mocks.getWatchlistDetail.mockRejectedValue(
      new WatchlistAccessError('Watchlist access denied.'),
    );

    const { default: WatchlistDetailPage } = await import(
      '../src/app/watchlist/[watchlistId]/page'
    );

    await expect(
      WatchlistDetailPage({
        params: Promise.resolve({ watchlistId: 'shared-watchlist-1' }),
      }),
    ).rejects.toThrow('NEXT_NOT_FOUND');
  });
});
