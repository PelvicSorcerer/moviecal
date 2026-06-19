import { expect, test } from './test-fixtures';

test('homepage preserves the unauthenticated watchlist redirect entry point', async ({ page }) => {
  await page.goto('/');

  await expect(page.locator('h2')).toContainText(
    'Track release dates without losing the privacy of your own watchlist.',
  );
  await page.getByRole('link', { name: 'Open protected watchlist' }).click();

  await expect(page).toHaveURL(/\/sign-in\?next=%2Fwatchlist$/);
  await expect(
    page.getByRole('heading', { name: 'Sign in to moviecal' }),
  ).toBeVisible();
});
