import { expect, test } from './test-fixtures';

const PROTECTED_ROUTES = ['/watchlist', '/settings/calendar'] as const;

test.describe('auth and session smoke', () => {
  test('signed-out visitors are redirected from protected routes', async ({
    assertRedirectsToSignIn,
  }) => {
    for (const protectedPath of PROTECTED_ROUTES) {
      await assertRedirectsToSignIn(protectedPath);
    }
  });

  test('stubbed sign-in reaches the intended protected route without live credentials', async ({
    page,
    signInAsTestUser,
  }) => {
    await signInAsTestUser('/settings/calendar');

    await expect(page).toHaveURL('/settings/calendar');
    await expect(
      page.getByRole('heading', { name: 'Calendar settings' }),
    ).toBeVisible();
    await expect(page.getByRole('main').getByText('e2e@example.com')).toBeVisible();
  });

  test('seeded authenticated sessions can open protected routes directly', async ({
    page,
    seedAuthenticatedSession,
  }) => {
    await seedAuthenticatedSession();

    for (const protectedPath of PROTECTED_ROUTES) {
      await page.goto(protectedPath);
      await expect(page).toHaveURL(protectedPath);
      await expect(page.getByRole('main').getByText('e2e@example.com')).toBeVisible();
    }
  });

  test('authenticated sessions persist across key app routes', async ({
    page,
    seedAuthenticatedSession,
  }) => {
    await seedAuthenticatedSession();

    await page.goto('/watchlist');
    await expect(page.getByText('Signed in as')).toContainText('e2e@example.com');

    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Search', exact: true }).click();
    await expect(page).toHaveURL('/search');
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();

    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Calendar', exact: true }).click();
    await expect(page).toHaveURL('/settings/calendar');
    await expect(
      page.getByRole('heading', { name: 'Calendar settings' }),
    ).toBeVisible();
    await expect(page.getByRole('main').getByText('e2e@example.com')).toBeVisible();
  });

  test('sign-out clears the session and re-protects app routes', async ({
    page,
    seedAuthenticatedSession,
    signOutAsTestUser,
    assertRedirectsToSignIn,
  }) => {
    await seedAuthenticatedSession();
    await page.goto('/watchlist');
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();

    await signOutAsTestUser();

    await expect(page).toHaveURL('/sign-in');
    await expect(
      page.getByRole('heading', { name: 'Sign in to moviecal' }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();

    for (const protectedPath of PROTECTED_ROUTES) {
      await assertRedirectsToSignIn(protectedPath);
    }
  });
});
