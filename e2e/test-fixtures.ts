import { expect, test as base } from '@playwright/test';

import {
  createE2ESharedWatchlist,
  createE2EWatchlistItem,
  createSeededE2ECalendarToken,
  E2E_AUTH_COOKIE,
  E2E_CALENDAR_TOKEN_COOKIE,
  E2E_COLLABORATOR_USER,
  E2E_SHARED_STATE_COOKIE,
  E2E_USER,
  E2E_USER_COOKIE,
  E2E_WATCHLIST_COOKIE,
  E2E_WATCHLISTS_COOKIE,
  getE2EMovieSummaries,
  getE2EPersonalWatchlistId,
  serializeE2ESharedState,
  serializeE2EWatchlistItems,
  serializeE2EWatchlists,
  type E2ESharedState,
} from '../src/lib/e2e/fixtures';
import type { WatchlistSummary } from '../src/lib/watchlist';

type SeedArgs =
  | number[]
  | {
      personalTmdbIds?: number[];
      sharedState?: E2ESharedState;
      sharedWatchlists?: Array<{
        canEdit?: boolean;
        id?: string;
        name: string;
        tmdbIds?: number[];
      }>;
      tmdbIds?: number[];
      user?: 'owner' | 'collaborator';
      watchlists?: WatchlistSummary[];
    };

type SmokeFixtures = {
  assertRedirectsToSignIn(
    protectedPath: '/watchlist' | '/settings/calendar',
  ): Promise<void>;
  stubMovieSearchWithScenario(args?: {
    delayMs?: number;
    query?: string;
    results?: ReturnType<typeof getE2EMovieSummaries>;
    status?: number;
    error?: string;
  }): Promise<void>;
  seedAuthenticatedSession(args?: SeedArgs): Promise<void>;
  signInAsTestUser(nextPath?: string): Promise<void>;
  switchAuthenticatedUser(user: 'owner' | 'collaborator'): Promise<void>;
  stubMovieSearch(tmdbIds?: number[]): Promise<void>;
};

export const test = base.extend<SmokeFixtures>({
  assertRedirectsToSignIn: async ({ page }, use) => {
    await use(async (protectedPath) => {
      await page.goto(protectedPath);
      await expect(page).toHaveURL(
        new RegExp(`/sign-in\\?next=${encodeURIComponent(protectedPath)}$`),
      );
      await expect(
        page.getByRole('heading', { name: 'Sign in to moviecal' }),
      ).toBeVisible();
    });
  },
  seedAuthenticatedSession: async ({ baseURL, context, request }, use) => {
    await use(async (args = []) => {
      if (!baseURL) {
        throw new Error('A baseURL is required for Playwright smoke fixtures.');
      }

      const config = Array.isArray(args) ? { personalTmdbIds: args } : args;
      const user = config.user === 'collaborator' ? E2E_COLLABORATOR_USER : E2E_USER;
      const personalWatchlistId = getE2EPersonalWatchlistId(user.id);
      const personalTmdbIds = config.personalTmdbIds ?? config.tmdbIds ?? [];
      const sharedWatchlists = config.sharedWatchlists ?? [];
      const watchlists = config.watchlists ?? [
        {
          canEdit: true,
          id: personalWatchlistId,
          kind: 'personal' as const,
          name: 'My watchlist',
          ownerUserId: user.id,
        },
        ...sharedWatchlists.map((watchlist, index) => ({
          canEdit: watchlist.canEdit ?? true,
          id: watchlist.id ?? createE2ESharedWatchlist(watchlist.name, index).id,
          kind: 'shared' as const,
          name: watchlist.name,
          ownerUserId: E2E_USER.id,
        })),
      ];
      const watchlistCookieValue = serializeE2EWatchlistItems({
        [personalWatchlistId]: personalTmdbIds.map((tmdbId) => createE2EWatchlistItem(tmdbId)),
        ...Object.fromEntries(
          sharedWatchlists.map((watchlist, index) => [
            watchlist.id ?? createE2ESharedWatchlist(watchlist.name, index).id,
            (watchlist.tmdbIds ?? []).map((tmdbId) => createE2EWatchlistItem(tmdbId)),
          ]),
        ),
      });
      const sharedState = config.sharedState ?? {
        inviteLinks: [],
        memberships: [],
      };
      const watchlistsCookieValue = serializeE2EWatchlists(watchlists);
      const sharedStateCookieValue = serializeE2ESharedState(sharedState);
      const calendarToken = createSeededE2ECalendarToken(
        `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      );

      await context.addCookies([
        {
          name: E2E_AUTH_COOKIE,
          value: 'authenticated',
          url: baseURL,
          httpOnly: true,
          sameSite: 'Lax',
        },
        {
          name: E2E_USER_COOKIE,
          value: JSON.stringify(user),
          url: baseURL,
          httpOnly: true,
          sameSite: 'Lax',
        },
        {
          name: E2E_WATCHLIST_COOKIE,
          value: watchlistCookieValue,
          url: baseURL,
          httpOnly: true,
          sameSite: 'Lax',
        },
        {
          name: E2E_WATCHLISTS_COOKIE,
          value: watchlistsCookieValue,
          url: baseURL,
          httpOnly: true,
          sameSite: 'Lax',
        },
        {
          name: E2E_SHARED_STATE_COOKIE,
          value: sharedStateCookieValue,
          url: baseURL,
          httpOnly: true,
          sameSite: 'Lax',
        },
        {
          name: E2E_CALENDAR_TOKEN_COOKIE,
          value: calendarToken,
          url: baseURL,
          httpOnly: true,
          sameSite: 'Lax',
        },
      ]);

      await request.get(`${baseURL}/settings/calendar`, {
        headers: {
          cookie: [
            `${E2E_AUTH_COOKIE}=authenticated`,
            `${E2E_USER_COOKIE}=${encodeURIComponent(JSON.stringify(user))}`,
            `${E2E_CALENDAR_TOKEN_COOKIE}=${calendarToken}`,
            `${E2E_WATCHLIST_COOKIE}=${encodeURIComponent(watchlistCookieValue)}`,
            `${E2E_WATCHLISTS_COOKIE}=${encodeURIComponent(watchlistsCookieValue)}`,
            `${E2E_SHARED_STATE_COOKIE}=${encodeURIComponent(sharedStateCookieValue)}`,
          ].join('; '),
        },
      });
    });
  },
  signInAsTestUser: async ({ page }, use) => {
    await use(async (nextPath = '/watchlist') => {
      await page.goto(`/sign-in?next=${encodeURIComponent(nextPath)}`);
      await page.getByLabel('Email').fill('e2e@example.com');
      await page.getByLabel('Password').fill('password123');
      await page.getByRole('button', { name: 'Sign in' }).click();
    });
  },
  switchAuthenticatedUser: async ({ baseURL, context }, use) => {
    await use(async (user) => {
      if (!baseURL) {
        throw new Error('A baseURL is required for Playwright smoke fixtures.');
      }

      await context.addCookies([
        {
          name: E2E_AUTH_COOKIE,
          value: 'authenticated',
          url: baseURL,
          httpOnly: true,
          sameSite: 'Lax',
        },
        {
          name: E2E_USER_COOKIE,
          value: JSON.stringify(
            user === 'collaborator' ? E2E_COLLABORATOR_USER : E2E_USER,
          ),
          url: baseURL,
          httpOnly: true,
          sameSite: 'Lax',
        },
      ]);
    });
  },
  stubMovieSearch: async ({ page }, use) => {
    await use(async (tmdbIds = [603]) => {
      const results = getE2EMovieSummaries(tmdbIds);

      await page.route('**/api/movies/search**', async (route) => {
        const requestUrl = new URL(route.request().url());
        const query = requestUrl.searchParams.get('q')?.trim() ?? '';

        if (!query) {
          await route.fulfill({
            status: 400,
            contentType: 'application/json',
            body: JSON.stringify({
              error: 'Search query "q" is required.',
            }),
          });

          return;
        }

        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ results }),
        });
      });
    });
  },
  stubMovieSearchWithScenario: async ({ page }, use) => {
    await use(async ({
      delayMs = 0,
      query,
      results = getE2EMovieSummaries([603]),
      status = 200,
      error,
    } = {}) => {
      await page.route('**/api/movies/search**', async (route) => {
        const requestUrl = new URL(route.request().url());
        const requestQuery = requestUrl.searchParams.get('q')?.trim() ?? '';

        if (query && requestQuery !== query) {
          await route.fallback();

          return;
        }

        if (delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }

        if (status >= 400) {
          await route.fulfill({
            status,
            contentType: 'application/json',
            body: JSON.stringify({
              error: error ?? 'Movie search is unavailable right now.',
            }),
          });

          return;
        }

        await route.fulfill({
          status,
          contentType: 'application/json',
          body: JSON.stringify({ results }),
        });
      });
    });
  },
});

export { expect };
