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

test('authenticated visitors can add and remove a deterministic fixture movie through the watchlist flow', async ({
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
  await page.getByRole('button', { name: 'Remove' }).click();

  await expect(
    page.getByText('Removed The Matrix from your watchlist.'),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your watchlist is empty' })).toBeVisible();
});

test('authenticated search shows the loading state while the app endpoint is pending', async ({
  page,
  seedAuthenticatedSession,
  stubMovieSearchWithScenario,
}) => {
  await seedAuthenticatedSession();
  await stubMovieSearchWithScenario({
    delayMs: 1_000,
    query: 'matrix',
  });

  await page.goto('/search');
  await page.getByRole('searchbox', { name: 'Search for a movie' }).fill('matrix');
  await page.getByRole('button', { name: 'Search' }).click();

  await expect(page.getByRole('heading', { name: 'Searching…' })).toBeVisible();
  await expect(page.getByText('Looking up matches for')).toContainText('matrix');
  await expect(page).toHaveURL(/\/search\?q=matrix$/);
  await expect(page.getByRole('heading', { name: 'Search results' })).toBeVisible();
});

test('authenticated search shows the empty state for zero mocked results', async ({
  page,
  seedAuthenticatedSession,
  stubMovieSearchWithScenario,
}) => {
  await seedAuthenticatedSession();
  await stubMovieSearchWithScenario({
    query: 'unknown',
    results: [],
  });

  await page.goto('/search');
  await page.getByRole('searchbox', { name: 'Search for a movie' }).fill('unknown');
  await page.getByRole('button', { name: 'Search' }).click();

  await expect(page.getByRole('heading', { name: 'No matches yet' })).toBeVisible();
  await expect(page.getByText('No movies matched')).toContainText('unknown');
  await expect(page).toHaveURL(/\/search\?q=unknown$/);
});

test('authenticated search shows server-endpoint errors without live TMDb access', async ({
  page,
  seedAuthenticatedSession,
  stubMovieSearchWithScenario,
}) => {
  await seedAuthenticatedSession();
  await stubMovieSearchWithScenario({
    query: 'matrix',
    status: 503,
    error: 'Movie search is unavailable right now.',
  });

  await page.goto('/search');
  await page.getByRole('searchbox', { name: 'Search for a movie' }).fill('matrix');
  await page.getByRole('button', { name: 'Search' }).click();

  await expect(page.getByText('Search unavailable')).toBeVisible();
  await expect(
    page.getByText('Movie search is unavailable right now.'),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/search\?q=matrix$/);
});

test('authenticated search calls the app server endpoint with the query string', async ({
  page,
  seedAuthenticatedSession,
}) => {
  await seedAuthenticatedSession();

  const requests: string[] = [];

  await page.route('**/api/movies/search**', async (route) => {
    requests.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        results: [],
      }),
    });
  });

  await page.goto('/search');
  await page.getByRole('searchbox', { name: 'Search for a movie' }).fill('the matrix');
  await page.getByRole('button', { name: 'Search' }).click();

  await expect(page.getByRole('heading', { name: 'No matches yet' })).toBeVisible();
  expect(requests).toEqual([
    expect.stringContaining('/api/movies/search?q=the%20matrix'),
  ]);
  expect(requests[0]).not.toContain('api.themoviedb.org');
});
