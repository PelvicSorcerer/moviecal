import type { Page } from '@playwright/test';

import { expect, test } from './test-fixtures';

const routes = [
  { path: '/', label: 'Home' },
  { path: '/search', label: 'Search' },
  { path: '/watchlist', label: 'Watchlists' },
  { path: '/settings/calendar', label: 'Calendar' },
];

async function expectHeaderFits(page: Page, signedIn: boolean) {
  const header = page.getByRole('banner');
  const controls = header.locator('a, button');

  await expect(controls).toHaveCount(5);
  for (const control of await controls.all()) {
    await expect(control).toBeVisible();
    await expect(control).toBeInViewport({ ratio: 1 });
  }
  await expect(signedIn
    ? header.getByRole('button', { name: 'Sign out' })
    : header.getByRole('link', { name: 'Sign in' }),
  ).toBeVisible();
  expect(await page.evaluate(() => (
    document.documentElement.scrollWidth <= document.documentElement.clientWidth
  ))).toBe(true);
}

for (const width of [375, 1280]) {
  test.describe(`site navigation at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    for (const signedIn of [false, true]) {
      const sessionLabel = signedIn ? 'signed in' : 'signed out';

      test(`links remain reachable and show the current page when ${sessionLabel}`, async ({
        page,
        seedAuthenticatedSession,
      }) => {
        if (signedIn) await seedAuthenticatedSession();
        await page.goto('/');
        const navigation = page.getByRole('navigation', { name: 'Main navigation' });

        for (const { path, label } of routes) {
          await navigation.getByRole('link', { name: label, exact: true }).click();

          if (!signedIn && (path === '/watchlist' || path === '/settings/calendar')) {
            await expect(page).toHaveURL(
              new RegExp(`/sign-in\\?next=${encodeURIComponent(path)}$`),
            );
            await expect(navigation.locator('[aria-current]')).toHaveCount(0);
          } else {
            await expect(page).toHaveURL(path);
            const currentLink = navigation.getByRole('link', { name: label, exact: true });
            await expect(currentLink).toHaveAttribute('aria-current', 'page');
            await expect(navigation.locator('[aria-current]')).toHaveCount(1);
            await expect(currentLink).toHaveCSS('text-decoration-line', 'underline');
            await expect(currentLink).toHaveCSS('background-color', 'rgb(224, 242, 254)');
          }

          await expectHeaderFits(page, signedIn);
        }
      });

      test(`skip link and header controls work with a keyboard when ${sessionLabel}`, async ({
        page,
        seedAuthenticatedSession,
      }) => {
        if (signedIn) await seedAuthenticatedSession();
        await page.goto('/');
        const skipLink = page.getByRole('link', { name: 'Skip to main content' });

        await page.keyboard.press('Tab');
        await expect(skipLink).toBeFocused();
        await expect(skipLink).toBeInViewport({ ratio: 1 });
        await expect(skipLink).toHaveCSS('outline-style', 'solid');
        await page.keyboard.press('Enter');
        await expect(page.getByRole('main')).toBeFocused();
        await expect(page).toHaveURL('/#main-content');

        await page.goto('/');
        await page.keyboard.press('Tab');
        await expect(skipLink).toBeFocused();
        for (const control of await page.getByRole('banner').locator('a, button').all()) {
          await page.keyboard.press('Tab');
          await expect(control).toBeFocused();
          await expect(control).toHaveCSS('outline-style', 'solid');
          await expect(control).toHaveCSS('outline-width', '3px');
          await expect(control).toBeInViewport({ ratio: 1 });
        }

        if (signedIn) {
          await page.keyboard.press('Enter');
          await expect(page).toHaveURL('/sign-in');
          await expectHeaderFits(page, false);
        } else {
          await page.keyboard.press('Shift+Tab');
          await page.keyboard.press('Shift+Tab');
          await page.keyboard.press('Shift+Tab');
          await expect(page.getByRole('navigation').getByRole('link', { name: 'Search' })).toBeFocused();
          await page.keyboard.press('Enter');
          await expect(page).toHaveURL('/search');
        }
      });
    }
  });
}
