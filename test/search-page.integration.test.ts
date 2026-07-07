import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { TEST_USER_IDS, TEST_WATCHLIST_IDS } from '../src/lib/test-data/catalog';
import {
  buildWatchlistSummary,
  createWatchlistRepository,
} from './support';

const mocks = vi.hoisted(() => ({
  getOptionalPageSession: vi.fn(),
  createServerSupabaseClient: vi.fn(),
  createServerSupabaseServiceRoleClient: vi.fn(),
  createSupabaseWatchlistRepository: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/search',
  useRouter: () => ({
    replace: vi.fn(),
  }),
}));

vi.mock('../src/lib/auth/session', () => ({
  getOptionalPageSession: mocks.getOptionalPageSession,
}));

vi.mock('../src/lib/supabase/server', () => ({
  createServerSupabaseClient: mocks.createServerSupabaseClient,
  createServerSupabaseServiceRoleClient: mocks.createServerSupabaseServiceRoleClient,
}));

vi.mock('../src/lib/supabase/watchlist', () => ({
  createSupabaseWatchlistRepository: mocks.createSupabaseWatchlistRepository,
}));

function setupPageSession() {
  mocks.getOptionalPageSession.mockResolvedValue({
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
    async listWatchlistsForUser() {
      return [
        buildWatchlistSummary({
          id: TEST_WATCHLIST_IDS.PERSONAL,
          kind: 'personal',
          name: 'My watchlist',
        }),
        buildWatchlistSummary({
          id: TEST_WATCHLIST_IDS.SHARED,
          kind: 'shared',
          name: 'Friday movie night',
        }),
      ];
    },
    ...overrides,
  });
}

describe('search page integration seam', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('renders the idle search state for anonymous visitors', async () => {
    mocks.getOptionalPageSession.mockResolvedValue(null);

    const { default: SearchPage } = await import('../src/app/search/page');
    const markup = renderToStaticMarkup(
      await SearchPage({ searchParams: Promise.resolve({}) }),
    );

    expect(markup).toContain('Search the TMDb-backed catalog');
    expect(markup).toContain('Find release dates without exposing TMDb in the browser.');
    expect(markup).toContain('Search by title');
    expect(markup).not.toContain('Save to');
    expect(markup).not.toContain('Sign in to add movies to your watchlist');
  });

  it('passes an initial query and authenticated watchlists through the real domain path', async () => {
    setupPageSession();
    mocks.createSupabaseWatchlistRepository.mockReturnValue(createPageRepository());

    const { default: SearchPage } = await import('../src/app/search/page');
    const markup = renderToStaticMarkup(
      await SearchPage({
        searchParams: Promise.resolve({ q: 'matrix' }),
      }),
    );

    expect(markup).toContain('Searching…');
    expect(markup).toContain('Looking up matches for');
    expect(markup).toContain('matrix');
    expect(markup).toContain('value="matrix"');
    expect(markup).not.toContain('Save to');
  });

  it('keeps search available when watchlist loading fails', async () => {
    setupPageSession();
    mocks.createSupabaseWatchlistRepository.mockReturnValue(
      createPageRepository({
        async listWatchlistsForUser() {
          throw new Error('Could not load your watchlists right now.');
        },
      }),
    );

    const { default: SearchPage } = await import('../src/app/search/page');
    const markup = renderToStaticMarkup(
      await SearchPage({
        searchParams: Promise.resolve({ q: 'matrix' }),
      }),
    );

    expect(markup).toContain('Searching…');
    expect(markup).toContain('Looking up matches for');
    expect(markup).not.toContain('Save to');
    expect(markup).not.toContain('Could not load your watchlists right now.');
  });
});
