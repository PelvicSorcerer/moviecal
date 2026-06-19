import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const mocks = vi.hoisted(() => ({
  requireAuthenticatedPageSession: vi.fn(),
  createServerSupabaseClient: vi.fn(),
  createServerSupabaseServiceRoleClient: vi.fn(),
  createSupabaseCalendarTokenRepository: vi.fn(),
  getOrCreateCalendarToken: vi.fn(),
  headers: vi.fn(),
}));

vi.mock('../src/lib/auth/session', () => ({
  requireAuthenticatedPageSession: mocks.requireAuthenticatedPageSession,
}));

vi.mock('../src/lib/supabase/server', () => ({
  createServerSupabaseClient: mocks.createServerSupabaseClient,
  createServerSupabaseServiceRoleClient:
    mocks.createServerSupabaseServiceRoleClient,
}));

vi.mock('../src/lib/supabase/calendar-tokens', () => ({
  createSupabaseCalendarTokenRepository:
    mocks.createSupabaseCalendarTokenRepository,
}));

vi.mock('../src/lib/calendar-tokens', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/calendar-tokens')>(
    '../src/lib/calendar-tokens',
  );

  return {
    ...actual,
    getOrCreateCalendarToken: mocks.getOrCreateCalendarToken,
  };
});

vi.mock('next/headers', () => ({
  headers: mocks.headers,
}));

describe('calendar settings page', () => {
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
    mocks.createServerSupabaseServiceRoleClient.mockReturnValue({
      name: 'admin-client',
    });
    mocks.createSupabaseCalendarTokenRepository.mockReturnValue({
      name: 'calendar-token-repository',
    });
    mocks.getOrCreateCalendarToken.mockResolvedValue({
      created_at: '2026-06-19T00:00:00.000Z',
      id: 'token-row-1',
      token: 'calendar-token-123',
      user_id: 'user-1',
    });
    mocks.headers.mockResolvedValue({
      get(name: string) {
        if (name === 'host') {
          return 'moviecal.test';
        }

        if (name === 'x-forwarded-proto') {
          return 'https';
        }

        return null;
      },
    });
  });

  it('renders the current subscription URL and rotate button', async () => {
    const { default: CalendarSettingsPage } = await import(
      '../src/app/settings/calendar/page'
    );
    const markup = renderToStaticMarkup(await CalendarSettingsPage());

    expect(markup).toContain('Calendar settings');
    expect(markup).toContain('dev@example.com');
    expect(markup).toContain(
      'https://moviecal.test/api/calendar/calendar-token-123',
    );
    expect(markup).toContain('Rotate subscription URL');
  });
});
