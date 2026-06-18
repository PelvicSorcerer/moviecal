import { expect, test } from './test-fixtures';

test('anonymous search visitors see deterministic results and a sign-in CTA', async ({
  page,
  stubMovieSearch,
}) => {
  await stubMovieSearch();

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

test('authenticated visitors can add a deterministic fixture movie to the watchlist', async ({
  page,
  seedAuthenticatedSession,
  stubMovieSearch,
}) => {
  await seedAuthenticatedSession();
  await stubMovieSearch();

  await page.goto('/search');
  await page.getByRole('searchbox', { name: 'Search for a movie' }).fill('matrix');
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByRole('button', { name: 'Add to watchlist' }).click();

  await expect(page.getByRole('button', { name: 'Added' })).toBeVisible();
  await expect(
    page.getByText('The authenticated add flow succeeded for this movie.'),
  ).toBeVisible();

  await page.goto('/watchlist');
  await expect(page.getByRole('heading', { name: 'The Matrix' })).toBeVisible();
});
