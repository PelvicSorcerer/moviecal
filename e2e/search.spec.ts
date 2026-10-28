import { expect, test } from './test-fixtures';
import {
  createE2ESharedWatchlist,
  createE2EWatchlistMember,
  E2E_SEARCH_UNAVAILABLE_QUERY,
} from '../src/lib/e2e/fixtures';
import { TEST_TMDB_IDS } from '../src/lib/test-data/catalog';

test.describe('full-stack search through the app backend path', () => {
  test('anonymous visitors receive catalog results from the real search endpoint', async ({
    page,
    getMovieSearchViaApi,
  }) => {
    await page.goto('/search');
    await page.getByRole('searchbox', { name: 'Search for a movie' }).fill('matrix');
    await page.getByRole('button', { name: 'Search' }).click();

    await expect(page.getByRole('heading', { name: 'Search results' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'The Matrix' })).toBeVisible();
    await expect(page.getByText('Mar 31, 1999')).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Sign in to add movies to your watchlist' }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/search\?q=matrix$/);

    const payload = await getMovieSearchViaApi('matrix');

    expect(payload.results.map((movie) => movie.tmdbId)).toEqual([TEST_TMDB_IDS.MATRIX]);
  });

  test('empty catalog matches show the handled empty state without crashing', async ({
    page,
    getMovieSearchViaApi,
  }) => {
    await page.goto('/search');
    await page.getByRole('searchbox', { name: 'Search for a movie' }).fill('unknown');
    await page.getByRole('button', { name: 'Search' }).click();

    await expect(page.getByRole('heading', { name: 'No matches yet' })).toBeVisible();
    await expect(page.getByText('No movies matched')).toContainText('unknown');
    await expect(page).toHaveURL(/\/search\?q=unknown$/);
    await expect(page.getByText('Search unavailable')).toHaveCount(0);

    const payload = await getMovieSearchViaApi('unknown');

    expect(payload.results).toEqual([]);
  });

  test('authenticated visitors can add a search result through the real backend path', async ({
    page,
    getMovieSearchViaApi,
    getPersonalWatchlistViaApi,
    seedAuthenticatedSession,
  }) => {
    await seedAuthenticatedSession([TEST_TMDB_IDS.INCEPTION]);

    await page.goto('/search');
    await page.getByRole('searchbox', { name: 'Search for a movie' }).fill('matrix');
    await page.getByRole('button', { name: 'Search' }).click();

    await expect(page.getByRole('heading', { name: 'Search results' })).toBeVisible();
    await expect(
      (await getMovieSearchViaApi('matrix')).results.map((movie) => movie.tmdbId),
    ).toEqual([TEST_TMDB_IDS.MATRIX]);

    await page.getByRole('button', { name: 'Add to watchlist' }).click();

    await expect(page.getByRole('button', { name: 'Added' })).toBeVisible();
    await expect(page.getByText('Saved to My watchlist.')).toBeVisible();
    await expect(
      (await getPersonalWatchlistViaApi()).items.map((item) => item.movie.tmdbId).sort(),
    ).toEqual([TEST_TMDB_IDS.INCEPTION, TEST_TMDB_IDS.MATRIX].sort());
  });

  test('handled search endpoint failures show a degraded error state instead of a hard crash', async ({
    page,
  }) => {
    await page.goto('/search');
    await page
      .getByRole('searchbox', { name: 'Search for a movie' })
      .fill(E2E_SEARCH_UNAVAILABLE_QUERY);
    await page.getByRole('button', { name: 'Search' }).click();

    await expect(page.getByText('Search unavailable')).toBeVisible();
    await expect(
      page.getByText('Movie search is unavailable right now.'),
    ).toBeVisible();
    await expect(page).toHaveURL(
      new RegExp(`/search\\?q=${encodeURIComponent(E2E_SEARCH_UNAVAILABLE_QUERY)}$`),
    );
  });
});

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

test('search explains how to start and announces an empty result at mobile width', async ({
  page,
  stubMovieSearchWithScenario,
}) => {
  const query = 'unmatched'.repeat(20);
  await page.setViewportSize({ width: 375, height: 812 });
  await stubMovieSearchWithScenario({ query, results: [] });
  await page.goto('/search');

  const status = page.locator('[aria-live="polite"]');
  await expect(status).toHaveAttribute('aria-atomic', 'true');
  await expect(status.getByRole('heading', { name: 'Find a movie' })).toBeVisible();
  await expect(status).toContainText('Enter a movie title above and select Search');
  await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);

  await page.getByRole('searchbox', { name: 'Search for a movie' }).fill(query);
  await page.getByRole('button', { name: 'Search', exact: true }).click();

  await expect(status.getByRole('heading', { name: 'No matches yet' })).toBeVisible();
  await expect(status).toContainText(query);
  await expect(status).toContainText('Check the spelling or try another title');
  await expect(status).not.toContainText('Search unavailable');
  expect(await page.evaluate(() => (
    document.documentElement.scrollWidth <= window.innerWidth
  ))).toBe(true);
});

for (const failure of ['server', 'network'] as const) {
  test(`search announces ${failure} failure and retries the original query at mobile width`, async ({
    page,
    stubMovieSearch,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await stubMovieSearch();
    const requests: string[] = [];
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.route('**/api/movies/search**', async (route) => {
      requests.push(new URL(route.request().url()).searchParams.get('q') ?? '');
      if (requests.length > 1) {
        await route.fallback();
      } else if (failure === 'network') {
        await route.abort('failed');
      } else {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Movie search is unavailable right now.' }),
        });
      }
    });
    await page.goto('/search?q=matrix');

    const status = page.locator('[aria-live="polite"]');
    await expect(status).toContainText('Search unavailable');
    await expect(status).toContainText('Try again, or search for another title.');
    await expect(status.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(status).not.toContainText('No movies matched');
    expect(await page.evaluate(() => (
      document.documentElement.scrollWidth <= window.innerWidth
    ))).toBe(true);

    await page.getByRole('searchbox', { name: 'Search for a movie' }).fill('another title');
    await page.getByRole('button', { name: 'Try again' }).click();

    await expect(page.getByRole('heading', { name: 'The Matrix' })).toBeVisible();
    await expect(status).toContainText('Search complete: 1 match for matrix.');
    await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
    await expect(page).toHaveURL(/\/search\?q=matrix$/);
    expect(requests).toEqual(['matrix', 'matrix']);
    expect(pageErrors).toEqual([]);
  });
}

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
  await expect(page.locator('[aria-live="polite"]')).toContainText('Searching…');
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
