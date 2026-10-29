import { expect, test } from './test-fixtures';

const destinations = [
  { name: 'Home', path: '/', title: 'moviecal' },
  { name: 'Search', path: '/search', title: 'Search | moviecal' },
  { name: 'Watchlists', path: '/watchlist', title: 'Watchlists | moviecal' },
];

for (const width of [375, 1280]) {
  test.describe(`branded not-found page at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    for (const signedIn of [false, true]) {
      const sessionLabel = signedIn ? 'signed in' : 'signed out';

      test(`returns 404 with accessible recovery links when ${sessionLabel}`, async ({
        page,
        seedAuthenticatedSession,
      }) => {
        if (signedIn) await seedAuthenticatedSession();

        const response = await page.goto('/no-such-page');
        expect(response?.status()).toBe(404);
        await expect(page).toHaveURL('/no-such-page');
        await expect(page).toHaveTitle('Page not found | moviecal');
        await expect(page.getByRole('banner').getByRole('heading', { name: 'moviecal' })).toBeVisible();
        await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
        await expect(page.getByRole('navigation', { name: 'Main navigation' }).locator('[aria-current]')).toHaveCount(0);

        const main = page.getByRole('main');
        await expect(main.getByRole('heading')).toHaveCount(1);
        await expect(main.getByRole('heading', { level: 2, name: 'Page not found' })).toBeVisible();
        await expect(main.getByText('404 · moviecal', { exact: true })).toBeVisible();
        await expect(main.getByText(
          'This page is missing, but your next movie night can start at Home, Search, or Watchlists.',
          { exact: true },
        )).toBeVisible();

        const recovery = main.getByRole('navigation', { name: 'Find your next page' });
        await expect(recovery.getByRole('link')).toHaveCount(3);
        for (const { name, path } of destinations) {
          const link = recovery.getByRole('link', { name, exact: true });
          await expect(link).toHaveAttribute('href', path);
          await expect(link).toBeInViewport({ ratio: 1 });
        }
        expect(await page.evaluate(() => (
          document.documentElement.scrollWidth <= document.documentElement.clientWidth
        ))).toBe(true);

        const controls = page.locator('a, button:not([data-nextjs-dev-tools-button])');
        for (const control of await controls.all()) {
          await page.keyboard.press('Tab');
          await expect(control).toBeFocused();
          await expect(control).toBeInViewport({ ratio: 1 });
          await expect(control).toHaveCSS('outline-style', 'solid');
          await expect(control).toHaveCSS('outline-width', '3px');
          await expect(control).not.toHaveCSS('outline-color', 'rgba(0, 0, 0, 0)');
        }
      });

      test(`recovery links open existing pages when ${sessionLabel}`, async ({
        page,
        seedAuthenticatedSession,
      }) => {
        if (signedIn) await seedAuthenticatedSession();

        for (const { name, path, title } of destinations) {
          await page.goto('/no-such-page');
          const recovery = page.getByRole('navigation', { name: 'Find your next page' });
          await recovery.getByRole('link', { name, exact: true }).click();

          if (!signedIn && path === '/watchlist') {
            await expect(page).toHaveURL('/sign-in?next=%2Fwatchlist');
            await expect(page).toHaveTitle('Sign in | moviecal');
          } else {
            await expect(page).toHaveURL(path);
            await expect(page).toHaveTitle(title);
          }
          await expect(page.getByRole('heading', { name: 'Page not found', exact: true })).toHaveCount(0);
        }
      });
    }
  });
}
