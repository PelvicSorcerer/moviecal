import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAuthenticatedPageSession: vi.fn(),
  createServerSupabaseClient: vi.fn(),
  createServerSupabaseServiceRoleClient: vi.fn(),
  createSupabaseCalendarTokenRepository: vi.fn(),
  rotateCalendarToken: vi.fn(),
  revalidatePath: vi.fn(),
  redirect: vi.fn(),
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

vi.mock('../src/lib/calendar-tokens', () => ({
  rotateCalendarToken: mocks.rotateCalendarToken,
}));

vi.mock('next/cache', () => ({
  revalidatePath: mocks.revalidatePath,
}));

vi.mock('next/navigation', () => ({
  redirect: mocks.redirect,
}));

describe('calendar settings rotate action', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuthenticatedPageSession.mockResolvedValue({
      accessToken: 'access-token',
      user: {
        id: 'user-1',
      },
    });
    mocks.createServerSupabaseClient.mockReturnValue({ name: 'user-client' });
    mocks.createServerSupabaseServiceRoleClient.mockReturnValue({
      name: 'admin-client',
    });
    mocks.createSupabaseCalendarTokenRepository.mockReturnValue({
      name: 'calendar-token-repository',
    });
    mocks.rotateCalendarToken.mockResolvedValue(undefined);
  });

  it('rotates the token and revalidates the settings page', async () => {
    const { rotateCalendarTokenAction } = await import(
      '../src/app/settings/calendar/actions'
    );

    await rotateCalendarTokenAction();

    expect(mocks.rotateCalendarToken).toHaveBeenCalledWith({
      repository: { name: 'calendar-token-repository' },
      userId: 'user-1',
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/settings/calendar');
    expect(mocks.redirect).toHaveBeenCalledWith('/settings/calendar');
  });
});
