import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createServerSupabaseServiceRoleClient: vi.fn(),
  createSupabaseCalendarTokenRepository: vi.fn(),
  createSupabaseWatchlistRepository: vi.fn(),
  resolveCalendarTokenOwner: vi.fn(),
  listWatchlistItems: vi.fn(),
  buildCalendarFeed: vi.fn(),
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

vi.mock('../src/lib/calendar-tokens', () => ({
  resolveCalendarTokenOwner: mocks.resolveCalendarTokenOwner,
}));

vi.mock('../src/lib/watchlist', () => ({
  listWatchlistItems: mocks.listWatchlistItems,
}));

vi.mock('../src/lib/calendar-feed', () => ({
  buildCalendarFeed: mocks.buildCalendarFeed,
}));

describe('calendar feed route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createServerSupabaseServiceRoleClient.mockReturnValue({
      name: 'service-role-client',
    });
    mocks.createSupabaseCalendarTokenRepository.mockReturnValue({
      name: 'calendar-token-repository',
    });
    mocks.createSupabaseWatchlistRepository.mockReturnValue({
      name: 'watchlist-repository',
    });
    mocks.buildCalendarFeed.mockReturnValue(
      'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n',
    );
  });

  it('returns 404 for an invalid token', async () => {
    mocks.resolveCalendarTokenOwner.mockResolvedValue(null);

    const { GET } = await import('../src/app/api/calendar/[token]/route');
    const response = await GET(
      new Request('https://moviecal.test/api/calendar/bad'),
      {
        params: Promise.resolve({ token: 'bad-token' }),
      },
    );

    expect(response.status).toBe(404);
    expect(mocks.listWatchlistItems).not.toHaveBeenCalled();
    expect(mocks.buildCalendarFeed).not.toHaveBeenCalled();
  });

  it('returns the token owner calendar payload for a valid token', async () => {
    mocks.resolveCalendarTokenOwner.mockResolvedValue('user-1');
    mocks.listWatchlistItems.mockResolvedValue([
      {
        id: 'watchlist-item-1',
        addedAt: '2026-06-20T00:00:00.000Z',
        movie: {
          id: 42,
          overview: 'A hacker discovers the truth.',
          posterPath: '/poster.jpg',
          releaseDate: '1999-03-31',
          title: 'The Matrix',
          tmdbId: 603,
        },
      },
    ]);
    mocks.buildCalendarFeed.mockReturnValue(
      'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//moviecal//EN\r\nEND:VCALENDAR\r\n',
    );

    const { GET } = await import('../src/app/api/calendar/[token]/route');
    const response = await GET(
      new Request('https://moviecal.test/api/calendar/good-token'),
      {
        params: Promise.resolve({ token: 'good-token' }),
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(
      'text/calendar; charset=utf-8',
    );
    await expect(response.text()).resolves.toBe(
      'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//moviecal//EN\r\nEND:VCALENDAR\r\n',
    );
    expect(mocks.resolveCalendarTokenOwner).toHaveBeenCalledWith({
      repository: { name: 'calendar-token-repository' },
      token: 'good-token',
    });
    expect(mocks.listWatchlistItems).toHaveBeenCalledWith({
      repository: { name: 'watchlist-repository' },
      userId: 'user-1',
    });
    expect(mocks.buildCalendarFeed).toHaveBeenCalledWith({
      items: [
        {
          id: 'watchlist-item-1',
          addedAt: '2026-06-20T00:00:00.000Z',
          movie: {
            id: 42,
            overview: 'A hacker discovers the truth.',
            posterPath: '/poster.jpg',
            releaseDate: '1999-03-31',
            title: 'The Matrix',
            tmdbId: 603,
          },
        },
      ],
      userId: 'user-1',
    });
  });
});
