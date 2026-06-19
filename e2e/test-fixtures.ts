import { expect, test as base } from '@playwright/test';

import {
  createE2EWatchlistItem,
  E2E_AUTH_COOKIE,
  E2E_WATCHLIST_COOKIE,
  getE2EMovieSummaries,
  serializeE2EWatchlistItems,
} from '../src/lib/e2e/fixtures';

type SmokeFixtures = {
  assertRedirectsToSignIn(
    protectedPath: '/watchlist' | '/settings/calendar',
  ): Promise<void>;
  seedAuthenticatedSession(tmdbIds?: number[]): Promise<void>;
  signInAsTestUser(nextPath?: string): Promise<void>;
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
  seedAuthenticatedSession: async ({ baseURL, context }, use) => {
    await use(async (tmdbIds = []) => {
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
          name: E2E_WATCHLIST_COOKIE,
          value: serializeE2EWatchlistItems(
            tmdbIds.map((tmdbId) => createE2EWatchlistItem(tmdbId)),
          ),
          url: baseURL,
          httpOnly: true,
          sameSite: 'Lax',
        },
      ]);
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
});

export { expect };
