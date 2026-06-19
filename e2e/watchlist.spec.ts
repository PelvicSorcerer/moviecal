import { expect, test } from './test-fixtures';

test('unauthenticated visitors are redirected away from protected app pages', async ({
  assertRedirectsToSignIn,
}) => {
  await assertRedirectsToSignIn('/watchlist');
  await assertRedirectsToSignIn('/settings/calendar');
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

test('seeded authenticated sessions can open protected app pages directly', async ({
  page,
  seedAuthenticatedSession,
}) => {
  await seedAuthenticatedSession();

  await page.goto('/watchlist');

  await expect(page.getByText('Signed in as')).toContainText('e2e@example.com');
  await expect(page.getByRole('heading', { name: 'Your watchlist is empty' })).toBeVisible();

  await page.goto('/settings/calendar');
  await expect(
    page.getByRole('heading', { name: 'Calendar settings' }),
  ).toBeVisible();
  await expect(page.getByRole('main').getByText('e2e@example.com')).toBeVisible();
});

test('seeded watchlist fixtures can be removed deterministically', async ({
  page,
  seedAuthenticatedSession,
}) => {
  await seedAuthenticatedSession([603]);
  await page.goto('/watchlist');

  await expect(page.getByRole('heading', { name: 'The Matrix' })).toBeVisible();
  await page.getByRole('button', { name: 'Remove' }).click();

  await expect(
    page.getByText('Removed The Matrix from your watchlist.'),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your watchlist is empty' })).toBeVisible();
});

test('authenticated users can open calendar settings', async ({
  page,
  seedAuthenticatedSession,
}) => {
  await seedAuthenticatedSession();
  await page.goto('/settings/calendar');

  await expect(
    page.getByRole('heading', { name: 'Calendar settings' }),
  ).toBeVisible();
  await expect(page.getByRole('main').getByText('e2e@example.com')).toBeVisible();
});
