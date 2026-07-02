import { afterEach, describe, expect, it, vi } from 'vitest';

import { foldCalendarLine } from '../src/lib/calendar-feed';
import type { CalendarTokenRepository } from '../src/lib/calendar-tokens';
import type { WatchlistRepository } from '../src/lib/watchlist';

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

function createCalendarTokenRepository(): CalendarTokenRepository {
  return {
    async findTokenByUserId() {
      return null;
    },
    async findUserIdByToken(token) {
      return token === 'valid-token' ? 'user-1' : null;
    },
    async insertTokenForUser() {
      return {
        errorCode: null,
        row: null,
      };
    },
    async updateTokenForUser() {
      return {
        errorCode: null,
        row: null,
      };
    },
  };
}

function createWatchlistRepository(): WatchlistRepository {
  const personalWatchlist = {
    canEdit: true,
    id: 'personal-watchlist-1',
    kind: 'personal' as const,
    name: 'My watchlist',
    ownerUserId: 'user-1',
  };
  const sharedWatchlist = {
    canEdit: true,
    id: 'shared-watchlist-1',
    kind: 'shared' as const,
    name: 'Household picks',
    ownerUserId: 'user-1',
  };

  return {
    async acceptInviteMembership() {
      throw new Error('not implemented');
    },
    async createInviteLink() {
      throw new Error('not implemented');
    },
    async createWatchlist() {
      throw new Error('not implemented');
    },
    async deleteItemByIdForWatchlist() {
      return false;
    },
    async ensurePersonalWatchlist(userId) {
      return userId === 'user-1'
        ? personalWatchlist
        : {
            canEdit: true,
            id: 'personal-watchlist-2',
            kind: 'personal',
            name: 'My watchlist',
            ownerUserId: userId,
          };
    },
    async findInviteLinkByTokenHash() {
      return null;
    },
    async findItemByMovieIdForWatchlist() {
      return null;
    },
    async findMembershipForUser() {
      return null;
    },
    async getActiveInviteLinkForWatchlist() {
      return null;
    },
    async getWatchlistAccess(actorUserId, watchlistId) {
      if (actorUserId === 'user-1' && watchlistId === personalWatchlist.id) {
        return {
          status: 'authorized' as const,
          watchlist: personalWatchlist,
          canEdit: true,
        };
      }

      if (actorUserId === 'user-1' && watchlistId === sharedWatchlist.id) {
        return {
          status: 'authorized' as const,
          watchlist: sharedWatchlist,
          canEdit: true,
        };
      }

      if (
        actorUserId !== 'user-1'
        && watchlistId === 'personal-watchlist-2'
      ) {
        return {
          status: 'authorized' as const,
          watchlist: {
            canEdit: true,
            id: 'personal-watchlist-2',
            kind: 'personal' as const,
            name: 'My watchlist',
            ownerUserId: actorUserId,
          },
          canEdit: true,
        };
      }

      return {
        status: 'forbidden' as const,
      };
    },
    async insertItemForWatchlist() {
      return {
        errorCode: null,
        row: null,
      };
    },
    async listItemsForWatchlist(watchlistId) {
      if (watchlistId === personalWatchlist.id) {
        return [
          {
            added_at: '2026-06-20T00:00:00.000Z',
            id: 'watchlist-item-1',
            movie: {
              id: 42,
              raw_json: {
                overview: 'A hacker discovers the truth.',
                poster_path: '/matrix.jpg',
              },
              release_date: '1999-03-31',
              title: 'The Matrix',
              tmdb_id: 603,
              updated_at: '2026-06-20T00:00:00.000Z',
            },
          },
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
          {
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
          },
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
    async listMembersForWatchlist() {
      return [];
    },
    async listTrackedMovies() {
      return [];
    },
    async listWatchlistsForUser(userId) {
      if (userId === 'user-1') {
        return [personalWatchlist, sharedWatchlist];
      }

      return [];
    },
    async removeMembershipFromWatchlist() {
      return false;
    },
    async revokeInviteLinksForWatchlist() {},
    async upsertMovie() {
      return { id: 42 };
    },
  };
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
      createCalendarTokenRepository(),
    );
    mocks.createSupabaseWatchlistRepository.mockReturnValue(
      createWatchlistRepository(),
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
      createCalendarTokenRepository(),
    );
    mocks.createSupabaseWatchlistRepository.mockReturnValue(
      createWatchlistRepository(),
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
