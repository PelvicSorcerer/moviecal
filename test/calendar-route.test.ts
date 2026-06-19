import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createServerSupabaseServiceRoleClient: vi.fn(),
  createSupabaseCalendarTokenRepository: vi.fn(),
  resolveCalendarTokenOwner: vi.fn(),
}));

vi.mock('../src/lib/supabase/server', () => ({
  createServerSupabaseServiceRoleClient:
    mocks.createServerSupabaseServiceRoleClient,
}));

vi.mock('../src/lib/supabase/calendar-tokens', () => ({
  createSupabaseCalendarTokenRepository:
    mocks.createSupabaseCalendarTokenRepository,
}));

vi.mock('../src/lib/calendar-tokens', () => ({
  resolveCalendarTokenOwner: mocks.resolveCalendarTokenOwner,
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
  });

  it('returns 404 for an invalid token', async () => {
    mocks.resolveCalendarTokenOwner.mockResolvedValue(null);

    const { GET } = await import('../src/app/api/calendar/[token]/route');
    const response = await GET(new Request('https://moviecal.test/api/calendar/bad'), {
      params: Promise.resolve({ token: 'bad-token' }),
    });

    expect(response.status).toBe(404);
  });

  it('returns the calendar payload for a valid token', async () => {
    mocks.resolveCalendarTokenOwner.mockResolvedValue('user-1');

    const { GET } = await import('../src/app/api/calendar/[token]/route');
    const response = await GET(
      new Request('https://moviecal.test/api/calendar/good-token'),
      {
        params: Promise.resolve({ token: 'good-token' }),
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/calendar');
    await expect(response.text()).resolves.toContain('BEGIN:VCALENDAR');
    expect(mocks.resolveCalendarTokenOwner).toHaveBeenCalledWith({
      repository: { name: 'calendar-token-repository' },
      token: 'good-token',
    });
  });
});
