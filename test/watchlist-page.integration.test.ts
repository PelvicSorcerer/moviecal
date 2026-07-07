import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { TEST_USER_IDS, TEST_WATCHLIST_IDS } from '../src/lib/test-data/catalog';
import {
  buildWatchlistRow,
  buildWatchlistSummary,
  createWatchlistRepository,
} from './support';

const mocks = vi.hoisted(() => ({
  requireAuthenticatedPageSession: vi.fn(),
  createServerSupabaseClient: vi.fn(),
  createServerSupabaseServiceRoleClient: vi.fn(),
  createSupabaseWatchlistRepository: vi.fn(),
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

function setupPageSession() {
  mocks.requireAuthenticatedPageSession.mockResolvedValue({
    accessToken: 'access-token',
    user: {
      id: TEST_USER_IDS.OWNER,
      email: 'dev@example.com',
    },
  });
  mocks.createServerSupabaseClient.mockReturnValue({ name: 'user-client' });
  mocks.createServerSupabaseServiceRoleClient.mockReturnValue({
    name: 'admin-client',
  });
}

function createPageRepository(
  overrides: Parameters<typeof createWatchlistRepository>[0] = {},
) {
  return createWatchlistRepository({
    async listItemsForWatchlist(watchlistId) {
      if (watchlistId === TEST_WATCHLIST_IDS.PERSONAL) {
        return [buildWatchlistRow()];
      }

      return [];
    },
    ...overrides,
  });
}

describe('watchlist page integration seam', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupPageSession();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('renders populated personal and shared watchlist overview states', async () => {
    mocks.createSupabaseWatchlistRepository.mockReturnValue(createPageRepository());

    const { default: WatchlistPage } = await import('../src/app/watchlist/page');
    const markup = renderToStaticMarkup(await WatchlistPage());

    expect(markup).toContain('Your personal and shared watchlists');
    expect(markup).toContain('The Matrix');
    expect(markup).toContain('Friday movie night');
    expect(markup).toContain('Remove');
  });

  it('renders the empty personal watchlist state through the real domain path', async () => {
    mocks.createSupabaseWatchlistRepository.mockReturnValue(
      createPageRepository({
        async listItemsForWatchlist() {
          return [];
        },
      }),
    );

    const { default: WatchlistPage } = await import('../src/app/watchlist/page');
    const markup = renderToStaticMarkup(await WatchlistPage());

    expect(markup).toContain('Your watchlist is empty');
    expect(markup).toContain('Save movies from the search page');
    expect(markup).toContain('Friday movie night');
  });

  it('keeps personal watchlist management visible when only the overview query fails', async () => {
    mocks.createSupabaseWatchlistRepository.mockReturnValue(
      createPageRepository({
        async listWatchlistsForUser() {
          throw new Error('Could not load your watchlists right now.');
        },
      }),
    );

    const { default: WatchlistPage } = await import('../src/app/watchlist/page');
    const markup = renderToStaticMarkup(await WatchlistPage());

    expect(markup).toContain('Watchlist overview unavailable');
    expect(markup).toContain('Could not load your watchlists right now.');
    expect(markup).toContain('The Matrix');
    expect(markup).toContain('Personal watchlist');
  });

  it('keeps the watchlist overview visible when only personal items fail to load', async () => {
    mocks.createSupabaseWatchlistRepository.mockReturnValue(
      createPageRepository({
        async listItemsForWatchlist(watchlistId) {
          if (watchlistId === TEST_WATCHLIST_IDS.PERSONAL) {
            throw new Error('Could not load your personal watchlist right now.');
          }

          return [];
        },
      }),
    );

    const { default: WatchlistPage } = await import('../src/app/watchlist/page');
    const markup = renderToStaticMarkup(await WatchlistPage());

    expect(markup).toContain('Personal watchlist unavailable');
    expect(markup).toContain('Could not load your personal watchlist right now.');
    expect(markup).toContain('Friday movie night');
    expect(markup).toContain('Watchlists you can access');
    expect(markup).not.toContain('The Matrix');
  });
});
