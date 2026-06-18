import { expect, test } from './test-fixtures';

test('stubbed sign-in reaches the protected watchlist without live credentials', async ({
  page,
  signInAsTestUser,
}) => {
  await signInAsTestUser();

  await expect(page).toHaveURL('/watchlist');
  await expect(page.getByText('Signed in as')).toContainText('e2e@example.com');
  await expect(page.getByRole('heading', { name: 'Your watchlist is empty' })).toBeVisible();
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
