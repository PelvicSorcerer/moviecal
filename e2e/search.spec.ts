import { expect, test } from './test-fixtures';
import {
  createE2ESharedWatchlist,
  createE2EWatchlistMember,
} from '../src/lib/e2e/fixtures';

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
  await seedAuthenticatedSession({
    sharedWatchlists: [
      {
        id: 'e2e-shared-watchlist-1',
        name: 'Friday movie night',
      },
    ],
  });
  await stubMovieSearch();

  await page.goto('/search');
  await page.getByRole('searchbox', { name: 'Search for a movie' }).fill('matrix');
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByLabel('Save to').selectOption('e2e-shared-watchlist-1');
  await page.getByRole('button', { name: 'Add to watchlist' }).click();

  await expect(page.getByRole('button', { name: 'Added' })).toBeVisible();
  await expect(page.getByText('Saved to Friday movie night.')).toBeVisible();

  await page.goto('/watchlist/e2e-shared-watchlist-1');
  await expect(page.getByRole('heading', { name: 'The Matrix' })).toBeVisible();
  await page.getByRole('button', { name: 'Remove' }).click();

  await expect(
    page.getByText('Removed The Matrix from Friday movie night.'),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'This watchlist is empty' })).toBeVisible();
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

test('authenticated search excludes read-only watchlists from add targets', async ({
  page,
  seedAuthenticatedSession,
  stubMovieSearch,
}) => {
  const sharedWatchlist = createE2ESharedWatchlist('Curated picks', 0, false);

  await seedAuthenticatedSession({
    sharedState: {
      inviteLinks: [],
      memberships: [
        createE2EWatchlistMember({
          userId: 'e2e-collaborator-user',
          watchlistId: sharedWatchlist.id,
        }),
      ],
    },
    user: 'collaborator',
    watchlists: [
      {
        canEdit: true,
        id: 'e2e-personal-watchlist-e2e-user',
        kind: 'personal',
        name: 'Owner watchlist',
        ownerUserId: 'e2e-user',
      },
      sharedWatchlist,
    ],
  });
  await stubMovieSearch();

  await page.goto('/search');
  await page.getByRole('searchbox', { name: 'Search for a movie' }).fill('matrix');
  await page.getByRole('button', { name: 'Search' }).click();

  await expect(page.getByRole('heading', { name: 'Search results' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'The Matrix' })).toBeVisible();
  await expect(page.getByLabel('Save to')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add to watchlist' })).toHaveCount(0);
  await expect(
    page.getByText(
      'You can view shared watchlists, but none of your current targets allow edits.',
    ),
  ).toBeVisible();
  await expect(
    page.getByText(
      'Your current watchlist memberships are read-only, so you cannot add this movie from search.',
    ),
  ).toBeVisible();
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
