import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TEST_TMDB_IDS, TEST_USER_IDS } from '../src/lib/test-data/catalog';
// TMDbEnvironmentError is imported from the tmdb/client module (partially mocked
// below with `...actual`) so the test throws the exact class reference the route
// resolves — otherwise an `instanceof` mismatch from module duplication would
// mis-map the 503 case to 500.
import {
  type NormalizedMovieSummary,
  TMDbEnvironmentError,
} from '../src/lib/tmdb/client';

const mocks = vi.hoisted(() => ({
  resolveAuthTokensWithClient: vi.fn(),
  createServerSupabaseClient: vi.fn(),
  searchMovies: vi.fn(),
}));

vi.mock('../src/lib/auth/identity', () => ({
  resolveAuthTokensWithClient: mocks.resolveAuthTokensWithClient,
}));

vi.mock('../src/lib/supabase/server', () => ({
  createServerSupabaseClient: mocks.createServerSupabaseClient,
}));

vi.mock('../src/lib/tmdb/client', async () => {
  const actual = await vi.importActual<typeof import('../src/lib/tmdb/client')>(
    '../src/lib/tmdb/client',
  );

  return {
    ...actual,
    searchMovies: mocks.searchMovies,
  };
});

const MATRIX_RESULT: NormalizedMovieSummary = {
  tmdbId: TEST_TMDB_IDS.MATRIX,
  title: 'The Matrix',
  releaseDate: '1999-03-31',
  posterPath: '/matrix.jpg',
  overview: 'A hacker discovers the truth.',
};

function authenticateAs(userId: string | null): void {
  mocks.resolveAuthTokensWithClient.mockResolvedValue({
    refreshedSession: null,
    shouldClearCookies: false,
    user: userId ? { id: userId } : null,
  });
}

function setupAuthenticatedRouteMocks(): void {
  authenticateAs(TEST_USER_IDS.OWNER);
  mocks.createServerSupabaseClient.mockReturnValue({ name: 'user-client' });
  mocks.searchMovies.mockResolvedValue([MATRIX_RESULT]);
}

function bearerRequest(
  init: { query?: string | null; token?: string | null } = {},
): Request {
  const headers = new Headers();

  if (init.token !== null) {
    headers.set('authorization', `Bearer ${init.token ?? 'valid-token'}`);
  }

  const url = new URL('https://moviecal.test/api/v1/movies/search');

  if (init.query != null) {
    url.searchParams.set('q', init.query);
  }

  return new Request(url, { method: 'GET', headers });
}

describe('v1 movies search route (mobile Bearer surface)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('route source never imports Next.js cookie transport or logs tokens', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const routeSource = readFileSync(
      fileURLToPath(
        new URL('../src/app/api/v1/movies/search/route.ts', import.meta.url),
      ),
      'utf8',
    );

    // The route must never import the Next.js cookie transport module, and it
    // must never log or echo the bearer token.
    expect(routeSource).not.toContain('next/headers');
    expect(routeSource).not.toContain('next/navigation');
    expect(routeSource).not.toMatch(/console\.[a-z]+\(/);
  });

  it('returns 200 { results } for an authenticated search', async () => {
    setupAuthenticatedRouteMocks();

    const { GET } = await import('../src/app/api/v1/movies/search/route');
    const response = await GET(bearerRequest({ query: 'matrix' }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ results: [MATRIX_RESULT] });
    expect(mocks.searchMovies).toHaveBeenCalledWith('matrix');
  });

  it('resolves the bearer token without allowing a silent refresh', async () => {
    setupAuthenticatedRouteMocks();

    const { GET } = await import('../src/app/api/v1/movies/search/route');
    await GET(bearerRequest({ query: 'matrix', token: 'mobile-access-token' }));

    expect(mocks.createServerSupabaseClient).toHaveBeenCalledWith(
      'mobile-access-token',
    );
    // Bearer-only auth carries no refresh token: refreshToken is empty and
    // refresh is disabled.
    expect(mocks.resolveAuthTokensWithClient).toHaveBeenCalledWith(
      { name: 'user-client' },
      { accessToken: 'mobile-access-token', refreshToken: '' },
      { allowRefresh: false },
    );
  });

  it('returns 401 { error: Unauthorized. } when the Authorization header is missing', async () => {
    setupAuthenticatedRouteMocks();

    const { GET } = await import('../src/app/api/v1/movies/search/route');
    const response = await GET(bearerRequest({ query: 'matrix', token: null }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized.' });
    // A missing token must short-circuit before any auth resolution or search.
    expect(mocks.resolveAuthTokensWithClient).not.toHaveBeenCalled();
    expect(mocks.searchMovies).not.toHaveBeenCalled();
  });

  it('returns 401 when the bearer token does not resolve to a user', async () => {
    setupAuthenticatedRouteMocks();
    authenticateAs(null);

    const { GET } = await import('../src/app/api/v1/movies/search/route');
    const response = await GET(bearerRequest({ query: 'matrix' }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized.' });
    expect(mocks.searchMovies).not.toHaveBeenCalled();
  });

  it('returns 400 when the query is missing', async () => {
    setupAuthenticatedRouteMocks();

    const { GET } = await import('../src/app/api/v1/movies/search/route');
    const response = await GET(bearerRequest());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Search query "q" is required.',
    });
    expect(mocks.searchMovies).not.toHaveBeenCalled();
  });

  it('returns 400 when the query is empty or whitespace only', async () => {
    setupAuthenticatedRouteMocks();

    const { GET } = await import('../src/app/api/v1/movies/search/route');
    const response = await GET(bearerRequest({ query: '   ' }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'Search query "q" is required.',
    });
    expect(mocks.searchMovies).not.toHaveBeenCalled();
  });

  it('returns 503 when TMDb is not configured', async () => {
    setupAuthenticatedRouteMocks();
    mocks.searchMovies.mockRejectedValue(
      new TMDbEnvironmentError('TMDb API key is not configured.'),
    );

    const { GET } = await import('../src/app/api/v1/movies/search/route');
    const response = await GET(bearerRequest({ query: 'matrix' }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'Movie search is unavailable until TMDb is configured.',
    });
  });
});
