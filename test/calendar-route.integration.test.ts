import { afterEach, describe, expect, it, vi } from 'vitest';

import { foldCalendarLine } from '../src/lib/calendar-feed';
import { rotateCalendarToken } from '../src/lib/calendar-tokens';
import { TEST_USER_IDS, TEST_WATCHLIST_IDS } from '../src/lib/test-data/catalog';
import {
  buildWatchlistRow,
  buildWatchlistSummary,
  createCalendarTokenRepository,
  createMutableCalendarTokenRepository,
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
    vi.useRealTimers();
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('keeps validators stable across requests and changes them with watchlist content', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-20T12:00:00Z'));
    mocks.createSupabaseCalendarTokenRepository.mockReturnValue(
      createCalendarTokenRepositoryForRoute(),
    );
    mocks.createSupabaseWatchlistRepository.mockReturnValue(
      createWatchlistRepositoryForRoute(),
    );
    mocks.isE2ETestModeEnabled.mockReturnValue(false);

    const { GET } = await import('../src/app/api/calendar/[token]/route');
    const getFeed = (validator?: string) => GET(
      new Request('https://moviecal.test/api/calendar/valid-token', {
        headers: validator ? { 'If-None-Match': validator } : {},
      }),
      { params: Promise.resolve({ token: 'valid-token' }) },
    );
    const initial = await getFeed();
    const body = await initial.text();
    const etag = initial.headers.get('etag')!;
    expect(initial.status).toBe(200);
    expect(etag).toMatch(/^"[a-f0-9]{64}"$/);
    expect(initial.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');

    vi.setSystemTime(new Date('2026-06-21T12:00:00Z'));
    const repeated = await getFeed();
    expect(repeated.headers.get('etag')).toBe(etag);
    expect(await repeated.text()).toBe(body);

    for (const validator of [etag, `W/${etag}`, `"other", W/${etag}`, '*']) {
      const response = await getFeed(validator);
      expect(response.status).toBe(304);
      expect(response.body).toBeNull();
      expect(await response.text()).toBe('');
      expect(response.headers.get('etag')).toBe(etag);
      expect(response.headers.get('cache-control')).toBe('private, max-age=0, must-revalidate');
    }

    const nonmatching = await getFeed('"other"');
    expect(nonmatching.status).toBe(200);
    expect(await nonmatching.text()).toBe(body);

    mocks.createSupabaseWatchlistRepository.mockReturnValue(
      createWatchlistRepository({
        async listItemsForWatchlist() {
          return [];
        },
      }),
    );
    const changed = await getFeed(etag);
    expect(changed.status).toBe(200);
    expect(changed.headers.get('etag')).not.toBe(etag);
    expect(await changed.text()).not.toContain('BEGIN:VEVENT');
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
      new Request('https://moviecal.test/api/calendar/missing-token', {
        headers: { 'If-None-Match': '*' },
      }),
      {
        params: Promise.resolve({ token: 'missing-token' }),
      },
    );

    expect(response.status).toBe(404);
    expect(response.headers.has('etag')).toBe(false);
    await expect(response.text()).resolves.toBe('Not Found');
  });

  it('invalidates the previous feed URL after rotation while preserving event identity for the new token', async () => {
    const tokenRepository = createMutableCalendarTokenRepository({
      initialToken: 'valid-token',
    });

    mocks.createServerSupabaseServiceRoleClient.mockReturnValue({
      name: 'service-role-client',
    });
    mocks.createSupabaseCalendarTokenRepository.mockReturnValue(
      tokenRepository,
    );
    mocks.createSupabaseWatchlistRepository.mockReturnValue(
      createWatchlistRepositoryForRoute(),
    );
    mocks.isE2ETestModeEnabled.mockReturnValue(false);
    mocks.isE2ECalendarTokenActive.mockReturnValue(false);

    const { GET } = await import('../src/app/api/calendar/[token]/route');
    const initialResponse = await GET(
      new Request('https://moviecal.test/api/calendar/valid-token'),
      {
        params: Promise.resolve({ token: 'valid-token' }),
      },
    );
    const initialBody = await initialResponse.text();
    const rotatedRow = await rotateCalendarToken({
      repository: tokenRepository,
      userId: TEST_USER_IDS.OWNER,
    });
    const staleResponse = await GET(
      new Request('https://moviecal.test/api/calendar/valid-token'),
      {
        params: Promise.resolve({ token: 'valid-token' }),
      },
    );
    const rotatedResponse = await GET(
      new Request(`https://moviecal.test/api/calendar/${rotatedRow.token}`),
      {
        params: Promise.resolve({ token: rotatedRow.token }),
      },
    );
    const rotatedBody = await rotatedResponse.text();
    const stableUid = foldCalendarLine(
      'UID:35c9675c92fcbee5a2b50e3bf7bcc6797211309f5f0513b0f6f8aa66030a959b@moviecal',
    ).join('\r\n');

    expect(initialResponse.status).toBe(200);
    expect(initialBody).toContain(stableUid);
    expect(staleResponse.status).toBe(404);
    await expect(staleResponse.text()).resolves.toBe('Not Found');
    expect(rotatedResponse.status).toBe(200);
    expect(rotatedResponse.headers.get('content-type')).toBe(
      'text/calendar; charset=utf-8',
    );
    expect(rotatedBody).toContain(stableUid);
    expect(rotatedBody).toContain('SUMMARY:The Matrix');
    expect(rotatedBody).toContain('SUMMARY:Inception');
  });
});
