import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  CalendarTokenRepository,
  CalendarTokenRow,
} from '../src/lib/calendar-tokens';
import {
  E2E_DEFAULT_CALENDAR_TOKEN,
  E2E_USER,
} from '../src/lib/e2e/fixtures';
import { TEST_USER_IDS } from '../src/lib/test-data/catalog';

const mocks = vi.hoisted(() => ({
  resolveAuthTokensWithClient: vi.fn(),
  createServerSupabaseClient: vi.fn(),
  createServerSupabaseServiceRoleClient: vi.fn(),
  createSupabaseCalendarTokenRepository: vi.fn(),
}));

vi.mock('../src/lib/auth/identity', () => ({
  resolveAuthTokensWithClient: mocks.resolveAuthTokensWithClient,
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

/**
 * An in-memory calendar-token repository seam. The v1 route exercises the real
 * `getOrCreateCalendarToken` domain helper while the Supabase client stays
 * mocked, so on-demand creation and idempotency are covered against real logic.
 */
function createInMemoryCalendarTokenRepository(
  seed: CalendarTokenRow | null = null,
): CalendarTokenRepository {
  let row = seed;
  let counter = 0;

  return {
    async findTokenByUserId(userId) {
      return row && row.user_id === userId ? row : null;
    },
    async findUserIdByToken(token) {
      return row && row.token === token ? row.user_id : null;
    },
    async insertTokenForUser(userId, token) {
      if (row && row.user_id === userId) {
        return { errorCode: '23505', row: null };
      }

      counter += 1;
      row = {
        created_at: '2026-06-13T05:00:00.000Z',
        id: `calendar-token-${counter}`,
        token,
        user_id: userId,
      };

      return { errorCode: null, row };
    },
    async updateTokenForUser(userId, token) {
      if (!row || row.user_id !== userId) {
        return { errorCode: null, row: null };
      }

      row = { ...row, token };

      return { errorCode: null, row };
    },
  };
}

function authenticateAs(userId: string | null): void {
  mocks.resolveAuthTokensWithClient.mockResolvedValue({
    refreshedSession: null,
    shouldClearCookies: false,
    user: userId ? { id: userId } : null,
  });
}

function setupAuthenticatedRouteMocks(
  repository = createInMemoryCalendarTokenRepository(),
): CalendarTokenRepository {
  authenticateAs(TEST_USER_IDS.OWNER);
  mocks.createServerSupabaseClient.mockReturnValue({ name: 'user-client' });
  mocks.createServerSupabaseServiceRoleClient.mockReturnValue({
    name: 'service-role-client',
  });
  mocks.createSupabaseCalendarTokenRepository.mockReturnValue(repository);

  return repository;
}

function bearerRequest(
  init: { token?: string | null } = {},
): Request {
  const headers = new Headers();

  if (init.token !== null) {
    headers.set('authorization', `Bearer ${init.token ?? 'valid-token'}`);
  }

  // The route derives the feed origin from the standard Request headers (no
  // next/headers). Provide forwarded host/proto so the URL is deterministic.
  headers.set('x-forwarded-host', 'moviecal.test');
  headers.set('x-forwarded-proto', 'https');

  return new Request('https://moviecal.test/api/v1/calendar-token', {
    method: 'GET',
    headers,
  });
}

describe('v1 calendar-token route (mobile Bearer surface)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
    delete process.env.MOVIECAL_E2E_TEST_MODE;
  });

  it('route source never imports Next.js cookie transport or logs tokens', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const routeSource = readFileSync(
      fileURLToPath(
        new URL('../src/app/api/v1/calendar-token/route.ts', import.meta.url),
      ),
      'utf8',
    );

    // The response body embeds the calendar token (a bearer credential): the
    // cookie transport module must never be imported and nothing may be logged.
    expect(routeSource).not.toContain('next/headers');
    expect(routeSource).not.toMatch(/console\.[a-z]+\(/);
  });

  it('returns 200 { subscriptionUrl } and creates the token on demand', async () => {
    const repository = setupAuthenticatedRouteMocks();

    const { GET } = await import('../src/app/api/v1/calendar-token/route');
    const response = await GET(bearerRequest());

    expect(response.status).toBe(200);
    const body = (await response.json()) as { subscriptionUrl: string };

    // The URL is the canonical /api/calendar/[token] feed URL.
    expect(body.subscriptionUrl.startsWith(
      'https://moviecal.test/api/calendar/',
    )).toBe(true);

    // The embedded token resolves strictly to the authenticated user's feed,
    // i.e. the same feed /api/calendar/[token] would serve.
    const embeddedToken = decodeURIComponent(
      new URL(body.subscriptionUrl).pathname.replace('/api/calendar/', ''),
    );
    await expect(
      repository.findUserIdByToken(embeddedToken),
    ).resolves.toBe(TEST_USER_IDS.OWNER);

    // The interactive get/insert runs through the user-scoped (RLS) client.
    expect(mocks.createSupabaseCalendarTokenRepository).toHaveBeenCalledWith({
      userClient: { name: 'user-client' },
      adminClient: { name: 'service-role-client' },
    });
  });

  it('is idempotent: repeated calls return the same subscription URL', async () => {
    setupAuthenticatedRouteMocks();

    const { GET } = await import('../src/app/api/v1/calendar-token/route');

    const first = (await (await GET(bearerRequest())).json()) as {
      subscriptionUrl: string;
    };
    const second = (await (await GET(bearerRequest())).json()) as {
      subscriptionUrl: string;
    };

    expect(second.subscriptionUrl).toBe(first.subscriptionUrl);
  });

  it('returns the same URL for a user that already has a token', async () => {
    const existing: CalendarTokenRow = {
      created_at: '2026-06-13T05:00:00.000Z',
      id: 'calendar-token-existing',
      token: 'existing-token-value',
      user_id: TEST_USER_IDS.OWNER,
    };
    setupAuthenticatedRouteMocks(
      createInMemoryCalendarTokenRepository(existing),
    );

    const { GET } = await import('../src/app/api/v1/calendar-token/route');
    const body = (await (await GET(bearerRequest())).json()) as {
      subscriptionUrl: string;
    };

    expect(body.subscriptionUrl).toBe(
      'https://moviecal.test/api/calendar/existing-token-value',
    );
  });

  it('returns 401 { error: Unauthorized. } when the Authorization header is missing', async () => {
    setupAuthenticatedRouteMocks();

    const { GET } = await import('../src/app/api/v1/calendar-token/route');
    const response = await GET(bearerRequest({ token: null }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized.' });
    // A missing token must short-circuit before any auth resolution.
    expect(mocks.resolveAuthTokensWithClient).not.toHaveBeenCalled();
  });

  it('returns 401 when the bearer token does not resolve to a user', async () => {
    setupAuthenticatedRouteMocks();
    authenticateAs(null);

    const { GET } = await import('../src/app/api/v1/calendar-token/route');
    const response = await GET(bearerRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized.' });
    // A token that resolves to no user must never mint a calendar token.
    expect(mocks.createSupabaseCalendarTokenRepository).not.toHaveBeenCalled();
  });

  it('resolves the bearer token without allowing a silent refresh', async () => {
    setupAuthenticatedRouteMocks();

    const { GET } = await import('../src/app/api/v1/calendar-token/route');
    await GET(bearerRequest({ token: 'mobile-access-token' }));

    expect(mocks.createServerSupabaseClient).toHaveBeenCalledWith(
      'mobile-access-token',
    );
    expect(mocks.resolveAuthTokensWithClient).toHaveBeenCalledWith(
      { name: 'user-client' },
      { accessToken: 'mobile-access-token', refreshToken: '' },
      { allowRefresh: false },
    );
  });

  it('honours the E2E path for the E2E user without touching the database', async () => {
    process.env.MOVIECAL_E2E_TEST_MODE = '1';
    setupAuthenticatedRouteMocks();
    authenticateAs(E2E_USER.id);

    const { GET } = await import('../src/app/api/v1/calendar-token/route');
    const response = await GET(bearerRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      subscriptionUrl: `https://moviecal.test/api/calendar/${E2E_DEFAULT_CALENDAR_TOKEN}`,
    });
    // The E2E branch must not build the Supabase-backed repository.
    expect(mocks.createSupabaseCalendarTokenRepository).not.toHaveBeenCalled();
  });
});
