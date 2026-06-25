import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const mocks = vi.hoisted(() => ({
  requireAuthenticatedPageSession: vi.fn(),
  createServerSupabaseClient: vi.fn(),
  createServerSupabaseServiceRoleClient: vi.fn(),
  createSupabaseWatchlistRepository: vi.fn(),
  listPersonalWatchlistItems: vi.fn(),
}));

vi.mock('../src/lib/auth/session', () => ({
  requireAuthenticatedPageSession: mocks.requireAuthenticatedPageSession,
}));

vi.mock('../src/lib/supabase/server', () => ({
  createServerSupabaseClient: mocks.createServerSupabaseClient,
  createServerSupabaseServiceRoleClient: mocks.createServerSupabaseServiceRoleClient,
}));

vi.mock('../src/lib/supabase/watchlist', () => ({
  createSupabaseWatchlistRepository: mocks.createSupabaseWatchlistRepository,
}));

vi.mock('../src/lib/watchlist', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/watchlist')>(
    '../src/lib/watchlist',
  );

  return {
    ...actual,
    listPersonalWatchlistItems: mocks.listPersonalWatchlistItems,
  };
});

describe('watchlist page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuthenticatedPageSession.mockResolvedValue({
      accessToken: 'access-token',
      user: {
        id: 'user-1',
        email: 'dev@example.com',
      },
    });
    mocks.createServerSupabaseClient.mockReturnValue({
      name: 'user-client',
    });
    mocks.createServerSupabaseServiceRoleClient.mockReturnValue({
      name: 'admin-client',
    });
    mocks.createSupabaseWatchlistRepository.mockReturnValue({
      name: 'repository',
    });
  });

  it('renders the signed-in user watchlist from a user-scoped repository client', async () => {
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
          posterPath: '/matrix.jpg',
        },
      },
    ]);

    const { default: WatchlistPage } = await import('../src/app/watchlist/page');
    const markup = renderToStaticMarkup(await WatchlistPage());

    expect(markup).toContain('Your saved movies');
    expect(markup).toContain('The Matrix');
    expect(markup).toContain('Mar 31, 1999');
    expect(markup).toContain('Remove');
    expect(markup).toContain('dev@example.com');
    expect(mocks.createServerSupabaseClient).toHaveBeenCalledWith('access-token');
    expect(mocks.createSupabaseWatchlistRepository).toHaveBeenCalledWith({
      userClient: { name: 'user-client' },
      adminClient: { name: 'admin-client' },
    });
    expect(mocks.listPersonalWatchlistItems).toHaveBeenCalledWith({
      repository: { name: 'repository' },
      userId: 'user-1',
    });
  });

  it('renders an empty state when the user has no saved movies', async () => {
    mocks.listPersonalWatchlistItems.mockResolvedValue([]);

    const { default: WatchlistPage } = await import('../src/app/watchlist/page');
    const markup = renderToStaticMarkup(await WatchlistPage());

    expect(markup).toContain('Your watchlist is empty');
    expect(markup).toContain('Save movies from the search page');
  });

  it('renders a clear error state when loading fails', async () => {
    mocks.listPersonalWatchlistItems.mockRejectedValue(
      new Error('Could not load your watchlist right now.'),
    );

    const { default: WatchlistPage } = await import('../src/app/watchlist/page');
    const markup = renderToStaticMarkup(await WatchlistPage());

    expect(markup).toContain('Watchlist unavailable');
    expect(markup).toContain('Could not load your watchlist right now.');
  });
});
