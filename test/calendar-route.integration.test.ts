import { afterEach, describe, expect, it, vi } from 'vitest';

import { foldCalendarLine } from '../src/lib/calendar-feed';
import { TEST_USER_IDS, TEST_WATCHLIST_IDS } from '../src/lib/test-data/catalog';
import {
  buildWatchlistRow,
  buildWatchlistSummary,
  createCalendarTokenRepository,
  createWatchlistRepository,
} from './support';

const mocks = vi.hoisted(() => ({
  createServerSupabaseServiceRoleClient: vi.fn(),
  createSupabaseCalendarTokenRepository: vi.fn(),
  createSupabaseWatchlistRepository: vi.fn(),
  isE2ECalendarTokenActive: vi.fn(),
  isE2ETestModeEnabled: vi.fn(),
}));

vi.mock('../src/lib/supabase/server', () => ({
  createServerSupabaseServiceRoleClient:
    mocks.createServerSupabaseServiceRoleClient,
}));

vi.mock('../src/lib/supabase/calendar-tokens', () => ({
  createSupabaseCalendarTokenRepository:
    mocks.createSupabaseCalendarTokenRepository,
}));

vi.mock('../src/lib/supabase/watchlist', () => ({
  createSupabaseWatchlistRepository:
    mocks.createSupabaseWatchlistRepository,
}));

vi.mock('../src/lib/e2e/calendar-token-state', () => ({
  isE2ECalendarTokenActive: mocks.isE2ECalendarTokenActive,
}));

vi.mock('../src/lib/e2e/fixtures', () => ({
  E2E_USER: { email: 'e2e-user@moviecal.test' },
  isE2ETestModeEnabled: mocks.isE2ETestModeEnabled,
}));

function createCalendarTokenRepositoryForRoute() {
  return createCalendarTokenRepository({
    async findUserIdByToken(token) {
      return token === 'valid-token' ? TEST_USER_IDS.OWNER : null;
    },
  });
}

function createWatchlistRepositoryForRoute() {
  const personalWatchlist = buildWatchlistSummary({
    id: TEST_WATCHLIST_IDS.PERSONAL,
    kind: 'personal',
    name: 'My watchlist',
  });
  const sharedWatchlist = buildWatchlistSummary({
    id: TEST_WATCHLIST_IDS.SHARED,
    kind: 'shared',
    name: 'Household picks',
  });

  return createWatchlistRepository({
    async listItemsForWatchlist(watchlistId) {
      if (watchlistId === personalWatchlist.id) {
        return [
          buildWatchlistRow(),
          {
            added_at: '2026-06-21T00:00:00.000Z',
            id: 'watchlist-item-2',
            movie: {
              id: 43,
              raw_json: {
                overview: 'Missing release date should be skipped.',
                poster_path: '/unknown.jpg',
              },
              release_date: null,
              title: 'Unknown Release',
              tmdb_id: 604,
              updated_at: '2026-06-21T00:00:00.000Z',
            },
          },
        ];
      }

      if (watchlistId === sharedWatchlist.id) {
        return [
          buildWatchlistRow(27205, {
            added_at: '2026-06-22T00:00:00.000Z',
            id: 'watchlist-item-4',
            movie: {
              id: 45,
              raw_json: {
                overview: 'Shared watchlist movie.',
                poster_path: '/inception.jpg',
              },
              release_date: '2010-07-16',
              title: 'Inception',
              tmdb_id: 27205,
              updated_at: '2026-06-22T00:00:00.000Z',
            },
          }),
        ];
      }

      if (watchlistId === 'personal-watchlist-2') {
        return [
          {
            added_at: '2026-06-22T00:00:00.000Z',
            id: 'watchlist-item-3',
            movie: {
              id: 44,
              raw_json: {
                overview: 'Another user item.',
                poster_path: '/other.jpg',
              },
              release_date: '2001-01-01',
              title: 'Other User Movie',
              tmdb_id: 605,
              updated_at: '2026-06-22T00:00:00.000Z',
            },
          },
        ];
      }

      return [];
    },
    async listWatchlistsForUser(userId) {
      return userId === TEST_USER_IDS.OWNER
        ? [personalWatchlist, sharedWatchlist]
        : [];
    },
  });
}

describe('calendar feed route integration seam', () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('returns the real owner-scoped calendar feed for a valid token', async () => {
    mocks.createServerSupabaseServiceRoleClient.mockReturnValue({
      name: 'service-role-client',
    });
    mocks.createSupabaseCalendarTokenRepository.mockReturnValue(
      createCalendarTokenRepositoryForRoute(),
    );
    mocks.createSupabaseWatchlistRepository.mockReturnValue(
      createWatchlistRepositoryForRoute(),
    );
    mocks.isE2ETestModeEnabled.mockReturnValue(false);
    mocks.isE2ECalendarTokenActive.mockReturnValue(false);

    const { GET } = await import('../src/app/api/calendar/[token]/route');
    const response = await GET(
      new Request('https://moviecal.test/api/calendar/valid-token'),
      {
        params: Promise.resolve({ token: 'valid-token' }),
      },
    );

    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(
      'text/calendar; charset=utf-8',
    );
    expect(body).toContain('BEGIN:VCALENDAR');
    expect(body).toContain('SUMMARY:The Matrix');
    expect(body).toContain('SUMMARY:Inception');
    expect(body).toContain('DESCRIPTION:https://www.themoviedb.org/movie/603');
    expect(body).toContain('DESCRIPTION:https://www.themoviedb.org/movie/27205');
    expect(body).toContain(
      foldCalendarLine(
        'UID:35c9675c92fcbee5a2b50e3bf7bcc6797211309f5f0513b0f6f8aa66030a959b@moviecal',
      ).join('\r\n'),
    );
    expect(body).toContain('DTSTART;VALUE=DATE:19990331');
    expect(body).not.toContain('Unknown Release');
    expect(body).not.toContain('Other User Movie');
  });

  it('returns 404 for an invalid token through the real token-resolution path', async () => {
    mocks.createServerSupabaseServiceRoleClient.mockReturnValue({
      name: 'service-role-client',
    });
    mocks.createSupabaseCalendarTokenRepository.mockReturnValue(
      createCalendarTokenRepositoryForRoute(),
    );
    mocks.createSupabaseWatchlistRepository.mockReturnValue(
      createWatchlistRepositoryForRoute(),
    );
    mocks.isE2ETestModeEnabled.mockReturnValue(false);
    mocks.isE2ECalendarTokenActive.mockReturnValue(false);

    const { GET } = await import('../src/app/api/calendar/[token]/route');
    const response = await GET(
      new Request('https://moviecal.test/api/calendar/missing-token'),
      {
        params: Promise.resolve({ token: 'missing-token' }),
      },
    );

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe('Not Found');
  });
});
