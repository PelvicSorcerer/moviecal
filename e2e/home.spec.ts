import { expect, test } from './test-fixtures';

const placeholderText = /early mvp|scaffold|authentication foundation|protected APIs/i;
const signedInDestinations = [
  { name: 'Search', path: '/search', heading: 'Find release dates without exposing TMDb in the browser.' },
  { name: 'Watchlists', path: '/watchlist', heading: 'Your personal and shared watchlists' },
  { name: 'Calendar settings', path: '/settings/calendar', heading: 'Calendar settings' },
];

for (const width of [375, 1280]) {
  test.describe(`home page at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test('signed-out visitors learn about moviecal and can sign in or search', async ({ page }) => {
      await page.goto('/');
      const main = page.getByRole('main');

      await expect(main.getByRole('heading', { level: 2 })).toHaveText(
        'Your next movie night starts here.',
      );
      await expect(main.getByRole('heading', { level: 3 })).toHaveText([
        'Private watchlists',
        'Shared watchlists',
        'Release-date calendar',
      ]);
      await expect(main).toContainText('private iCalendar feed');
      await expect(main).toContainText('Release dates stay up to date as they change.');
      await expect(main.getByRole('link')).toHaveCount(2);
      await expect(main.getByRole('link', { name: 'Sign in to get started' })).toHaveAttribute(
        'href', '/sign-in',
      );
      await main.getByRole('link', { name: 'Sign in to get started' }).click();
      await expect(page).toHaveURL('/sign-in');
      await expect(page.getByRole('heading', { name: 'Sign in to moviecal' })).toBeVisible();

      await page.goto('/');
      await main.getByRole('link', { name: 'Search movies' }).click();
      await expect(page).toHaveURL('/search');
      await expect(page.getByRole('heading', {
        name: 'Find release dates without exposing TMDb in the browser.',
      })).toBeVisible();
    });

    test('signed-in visitors can go straight to their movie tools', async ({
      page,
      seedAuthenticatedSession,
    }) => {
      await seedAuthenticatedSession();
      await page.goto('/');
      const main = page.getByRole('main');

      await expect(main.getByRole('heading', { level: 2 })).toHaveText('Welcome back to moviecal.');
      await expect(main.getByRole('link')).toHaveCount(3);
      await expect(page.getByRole('link', { name: /sign in/i })).toHaveCount(0);

      for (const { name, path, heading } of signedInDestinations) {
        await page.goto('/');
        const link = main.getByRole('link', { name, exact: true });
        await expect(link).toHaveAttribute('href', path);
        await link.click();
        await expect(page).toHaveURL(path);
        await expect(main.getByRole('heading', { name: heading, exact: true })).toBeVisible();
      }
    });

    for (const signedIn of [false, true]) {
      const sessionLabel = signedIn ? 'signed in' : 'signed out';

      test(`finished copy, headings, layout and keyboard focus when ${sessionLabel}`, async ({
        page,
        seedAuthenticatedSession,
      }) => {
        if (signedIn) await seedAuthenticatedSession();
        await page.goto('/');
        const main = page.getByRole('main');

        await expect(main.getByRole('heading', { level: 2 })).toBeVisible();
        await expect(page.getByRole('heading', { level: 1 })).toHaveText('moviecal');
        await expect(main.getByRole('heading', { level: 3 })).toHaveCount(signedIn ? 0 : 3);
        await expect(page.locator('body')).not.toContainText(placeholderText);
        await expect(page.locator('meta[name="description"]')).toHaveAttribute(
          'content',
          'Keep private and shared movie watchlists, and follow release dates with a personal iCalendar feed.',
        );
        await expect(page.locator('meta[name="description"]')).not.toHaveAttribute(
          'content', placeholderText,
        );
        expect(await page.evaluate(() => (
          document.documentElement.scrollWidth <= document.documentElement.clientWidth
        ))).toBe(true);

        // The Next.js dev-tools button only exists under `next dev` and is not part of the page.
        const controls = page.locator('a, button:not([data-nextjs-dev-tools-button])');
        for (const control of await controls.all()) {
          await page.keyboard.press('Tab');
          await expect(control).toBeFocused();
          await expect(control).toBeVisible();
          await expect(control).toBeInViewport({ ratio: 1 });
          await expect(control).toHaveCSS('outline-style', 'solid');
          await expect(control).toHaveCSS('outline-width', '3px');
          await expect(control).not.toHaveCSS('outline-color', 'rgba(0, 0, 0, 0)');
        }
      });
    }
  });
}
