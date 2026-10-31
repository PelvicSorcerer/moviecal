import type { Page } from '@playwright/test';

import { expect, test } from './test-fixtures';

const routes = [
  { path: '/', label: 'Home', title: 'moviecal' },
  { path: '/search', label: 'Search', title: 'Search | moviecal' },
  { path: '/watchlist', label: 'Watchlists', title: 'Watchlists | moviecal' },
  { path: '/settings/calendar', label: 'Calendar', title: 'Calendar settings | moviecal' },
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
  test.describe(`site footer at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    for (const signedIn of [false, true]) {
      test(`footer is consistent when signed ${signedIn ? 'in' : 'out'}`, async ({
        page,
        seedAuthenticatedSession,
      }) => {
        if (signedIn) await seedAuthenticatedSession();

        for (const path of [...routes.map((route) => route.path), '/missing-footer-page']) {
          await page.goto(path);
          const footer = page.getByRole('contentinfo');
          await expect(footer).toHaveCount(1);
          await expect(footer.getByText('moviecal', { exact: true })).toBeVisible();
          await expect(footer.getByText(
            'This product uses the TMDb API but is not endorsed or certified by TMDb.',
            { exact: true },
          )).toBeVisible();
          await expect(footer.getByRole('link')).toHaveCount(3);
          for (const [label, href] of [
            ['Search', '/search'],
            ['Watchlists', '/watchlist'],
            ['Calendar settings', '/settings/calendar'],
          ]) {
            const link = footer.getByRole('link', { name: label, exact: true });
            await expect(link).toBeVisible();
            await expect(link).toHaveAttribute('href', href);
          }
          expect(await page.evaluate(() => (
            document.documentElement.scrollWidth <= document.documentElement.clientWidth
          ))).toBe(true);
          const mainBounds = await page.getByRole('main').boundingBox();
          const footerBounds = await footer.boundingBox();
          expect(mainBounds).not.toBeNull();
          expect(footerBounds).not.toBeNull();
          expect(footerBounds!.y).toBeGreaterThanOrEqual(mainBounds!.y + mainBounds!.height);
        }
      });
    }

    test('footer stays at the bottom of short pages and supports keyboard navigation', async ({
      page,
      seedAuthenticatedSession,
    }) => {
      await seedAuthenticatedSession();
      await page.goto('/search');
      const footer = page.getByRole('contentinfo');
      const bounds = await footer.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.y + bounds!.height).toBeGreaterThanOrEqual(900 - 1);

      await page.getByRole('main').focus();
      const searchLink = footer.getByRole('link', { name: 'Search', exact: true });
      for (let presses = 0; presses < 30; presses += 1) {
        await page.keyboard.press('Tab');
        if (await searchLink.evaluate((link) => link === document.activeElement)) break;
      }
      for (const link of await footer.getByRole('link').all()) {
        await expect(link).toBeFocused();
        await expect(link).toHaveCSS('outline-style', 'solid');
        await expect(link).toHaveCSS('outline-width', '3px');
        await expect(link).toBeInViewport({ ratio: 1 });
        await page.keyboard.press('Tab');
      }
      for (const path of ['/search', '/watchlist', '/settings/calendar']) {
        await footer.locator(`a[href="${path}"]`).focus();
        await page.keyboard.press('Enter');
        await expect(page).toHaveURL(path);
      }
    });
  });

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

        await expect(page).toHaveTitle('moviecal');

        for (const { path, label, title } of routes) {
          await navigation.getByRole('link', { name: label, exact: true }).click();

          if (!signedIn && (path === '/watchlist' || path === '/settings/calendar')) {
            await expect(page).toHaveURL(
              new RegExp(`/sign-in\\?next=${encodeURIComponent(path)}$`),
            );
            await expect(navigation.locator('[aria-current]')).toHaveCount(0);
            await expect(page).toHaveTitle('Sign in | moviecal');
          } else {
            await expect(page).toHaveURL(path);
            await expect(page).toHaveTitle(title);
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
          await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Search' })).toBeFocused();
          await page.keyboard.press('Enter');
          await expect(page).toHaveURL('/search');
        }
      });
    }
  });
}

test.describe('browser page titles', () => {
  test('direct visits use descriptive titles and preserve the default description', async ({
    page,
    seedAuthenticatedSession,
  }) => {
    await seedAuthenticatedSession({
      sharedWatchlists: [{ id: 'e2e-title-watchlist', name: 'Friday movie night' }],
    });

    for (const { path, title } of routes) {
      await page.goto(path);
      await expect(page).toHaveURL(path);
      await expect(page).toHaveTitle(title);
      await expect(page.locator('head title')).toHaveCount(1);

      if (path === '/' || path === '/settings/calendar') {
        await expect(page.locator('meta[name="description"]')).toHaveAttribute(
          'content',
          'Keep private and shared movie watchlists, and follow release dates with a personal iCalendar feed.',
        );
      }
    }

    await page.goto('/watchlist/e2e-title-watchlist');
    await expect(page.getByRole('heading', { level: 1, name: 'Friday movie night' })).toBeVisible();
    await expect(page).toHaveTitle('Watchlist | moviecal');

    await page.goto('/watchlist/invite/invalid-invite');
    await expect(page).toHaveURL('/watchlist/invite/invalid-invite');
    await expect(page).toHaveTitle('Watchlist invite | moviecal');
  });

  test('signed-out pages and protected-page redirects use the sign-in title', async ({ page }) => {
    for (const path of [
      '/sign-in',
      '/watchlist',
      '/settings/calendar',
      '/watchlist/e2e-title-watchlist',
      '/watchlist/invite/invalid-invite',
    ]) {
      await page.goto(path);
      await expect(page).toHaveURL(path === '/sign-in'
        ? '/sign-in'
        : new RegExp(`/sign-in\\?next=${encodeURIComponent(path)}$`));
      await expect(page).toHaveTitle('Sign in | moviecal');
      await expect(page.getByRole('heading', { name: 'Sign in to moviecal' })).toBeVisible();
    }
  });

  test('signed-in sign-in redirects use the destination title', async ({
    page,
    seedAuthenticatedSession,
  }) => {
    await seedAuthenticatedSession();

    for (const path of ['/sign-in', '/sign-in?next=%2Fsettings%2Fcalendar']) {
      await page.goto(path);
      const calendarRedirect = path.includes('next=');
      await expect(page).toHaveURL(calendarRedirect ? '/settings/calendar' : '/watchlist');
      await expect(page).toHaveTitle(calendarRedirect
        ? 'Calendar settings | moviecal'
        : 'Watchlists | moviecal');
    }
  });
});
