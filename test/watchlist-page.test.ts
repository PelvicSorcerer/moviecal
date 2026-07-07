import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const mocks = vi.hoisted(() => ({
  requireAuthenticatedPageSession: vi.fn(),
  createServerSupabaseClient: vi.fn(),
  createServerSupabaseServiceRoleClient: vi.fn(),
  createSupabaseWatchlistRepository: vi.fn(),
  listUserWatchlists: vi.fn(),
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
    listUserWatchlists: mocks.listUserWatchlists,
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
    mocks.listUserWatchlists.mockResolvedValue([
      {
        canEdit: true,
        id: 'personal-watchlist-1',
        kind: 'personal',
        name: 'My watchlist',
        ownerUserId: 'user-1',
      },
    ]);
  });

  it('renders the signed-in user watchlist overview from a user-scoped repository client', async () => {
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

    expect(markup).toContain('Your personal and shared watchlists');
    expect(markup).toContain('Watchlists you can access');
    expect(markup).toContain('My watchlist');
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
    expect(mocks.listUserWatchlists).toHaveBeenCalledWith({
      repository: { name: 'repository' },
      userId: 'user-1',
    });
  });

  it('renders shared watchlists alongside the personal watchlist overview', async () => {
    mocks.listUserWatchlists.mockResolvedValue([
      {
        canEdit: true,
        id: 'personal-watchlist-1',
        kind: 'personal',
        name: 'My watchlist',
        ownerUserId: 'user-1',
      },
      {
        canEdit: true,
        id: 'shared-watchlist-1',
        kind: 'shared',
        name: 'Friday movie night',
        ownerUserId: 'user-1',
      },
    ]);
    mocks.listPersonalWatchlistItems.mockResolvedValue([]);

    const { default: WatchlistPage } = await import('../src/app/watchlist/page');
    const markup = renderToStaticMarkup(await WatchlistPage());

    expect(markup).toContain('Friday movie night');
    expect(markup).toContain('Shared');
    expect(markup).toContain('Your watchlist is empty');
    expect(markup).toContain('Save movies from the search page');
  });

  it('keeps personal watchlist management available when only the overview query fails', async () => {
    mocks.listUserWatchlists.mockRejectedValue(
      new Error('Could not load your watchlists right now.'),
    );
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

    expect(markup).toContain('Watchlist overview unavailable');
    expect(markup).toContain('Could not load your watchlists right now.');
    expect(markup).toContain('The Matrix');
    expect(markup).toContain('Remove');
    expect(markup).toContain('Personal watchlist');
  });

  it('renders the personal items error while keeping the overview available', async () => {
    mocks.listPersonalWatchlistItems.mockRejectedValue(
      new Error('Could not load your personal watchlist right now.'),
    );

    const { default: WatchlistPage } = await import('../src/app/watchlist/page');
    const markup = renderToStaticMarkup(await WatchlistPage());

    expect(markup).toContain('Personal watchlist unavailable');
    expect(markup).toContain('Could not load your personal watchlist right now.');
    expect(markup).toContain('Friday movie night');
    expect(markup).not.toContain('The Matrix');
  });
});
