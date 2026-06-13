import { expect, test } from '@playwright/test';

test('search page renders results from the server-side endpoint', async ({ page }) => {
  await page.route('**/api/movies/search?q=matrix', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        results: [
          {
            tmdbId: 603,
            title: 'The Matrix',
            releaseDate: '1999-03-31',
            posterPath: '/matrix.jpg',
            overview: 'A hacker discovers the truth.',
          },
        ],
      }),
    });
  });

  await page.goto('/search');
  await page.getByRole('searchbox', { name: 'Search for a movie' }).fill('matrix');
  await page.getByRole('button', { name: 'Search' }).click();

  await expect(page.getByRole('heading', { name: 'Search results' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'The Matrix' })).toBeVisible();
  await expect(page.getByText('Mar 31, 1999')).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Sign in to add movies to your watchlist' }),
  ).toBeVisible();
});
