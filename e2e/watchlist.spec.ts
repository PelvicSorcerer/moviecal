import { expect, test } from './test-fixtures';
import {
  createE2ESharedWatchlist,
  createE2EWatchlistMember,
  createE2EWatchlistInviteLink,
} from '../src/lib/e2e/fixtures';
import { TEST_TMDB_IDS } from '../src/lib/test-data/catalog';

test.describe('full-stack watchlist persistence', () => {
  test('seeded state survives add, remove, and reload through the app backend path', async ({
    page,
    getPersonalWatchlistViaApi,
    seedAuthenticatedSession,
    stubMovieSearch,
  }) => {
    await seedAuthenticatedSession([TEST_TMDB_IDS.INCEPTION]);
    await page.goto('/watchlist');

    await expect(page.getByRole('heading', { name: 'Inception' })).toBeVisible();
    await expect(
      (await getPersonalWatchlistViaApi()).items.map((item) => item.movie.tmdbId),
    ).toEqual([TEST_TMDB_IDS.INCEPTION]);

    await stubMovieSearch([TEST_TMDB_IDS.MATRIX]);
    await page.goto('/search');
    await page.getByRole('searchbox', { name: 'Search for a movie' }).fill('matrix');
    await page.getByRole('button', { name: 'Search' }).click();
    await page.getByRole('button', { name: 'Add to watchlist' }).click();

    await expect(page.getByText('Saved to My watchlist.')).toBeVisible();
    await expect(
      (await getPersonalWatchlistViaApi()).items.map((item) => item.movie.tmdbId).sort(),
    ).toEqual([TEST_TMDB_IDS.INCEPTION, TEST_TMDB_IDS.MATRIX].sort());

    await page.goto('/watchlist');
    await page.reload();

    await expect(page.getByRole('heading', { name: 'Inception' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'The Matrix' })).toBeVisible();

    await page
      .getByRole('listitem')
      .filter({ hasText: 'Inception' })
      .getByRole('button', { name: 'Remove' })
      .click();

    await expect(
      page.getByText('Removed Inception from My watchlist.'),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Inception' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'The Matrix' })).toBeVisible();

    await page.reload();

    await expect(page.getByRole('heading', { name: 'Inception' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'The Matrix' })).toBeVisible();
    await expect(
      (await getPersonalWatchlistViaApi()).items.map((item) => item.movie.tmdbId),
    ).toEqual([TEST_TMDB_IDS.MATRIX]);
  });
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
    page.getByText('Removed The Matrix from My watchlist.'),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your watchlist is empty' })).toBeVisible();
});

test('authorized users can open a shared watchlist detail page and only see that target', async ({
  page,
  seedAuthenticatedSession,
}) => {
  await seedAuthenticatedSession({
    personalTmdbIds: [603],
    sharedWatchlists: [
      {
        id: 'e2e-shared-watchlist-1',
        name: 'Friday movie night',
        tmdbIds: [27205],
      },
    ],
  });
  await page.goto('/watchlist/e2e-shared-watchlist-1');

  await expect(
    page.getByRole('heading', { level: 1, name: 'Friday movie night' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Inception' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'The Matrix' })).toHaveCount(0);
});

test('removing a movie from one watchlist target does not remove it from another target', async ({
  page,
  seedAuthenticatedSession,
}) => {
  await seedAuthenticatedSession({
    personalTmdbIds: [603],
    sharedWatchlists: [
      {
        id: 'e2e-shared-watchlist-1',
        name: 'Friday movie night',
        tmdbIds: [603],
      },
    ],
  });
  await page.goto('/watchlist/e2e-shared-watchlist-1');
  await page.getByRole('button', { name: 'Remove' }).click();

  await expect(
    page.getByText('Removed The Matrix from Friday movie night.'),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'This watchlist is empty' })).toBeVisible();

  await page.goto('/watchlist');
  await expect(page.getByRole('heading', { name: 'The Matrix' })).toBeVisible();
});

test('read-only shared memberships hide mutation affordances on the detail page', async ({
  page,
  seedAuthenticatedSession,
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
      {
        ...sharedWatchlist,
      },
    ],
  });
  await page.goto(`/watchlist/${sharedWatchlist.id}`);

  await expect(page.getByText('Read-only access')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove' })).toHaveCount(0);
});

test('authenticated users can create a shared watchlist from the overview', async ({
  page,
  seedAuthenticatedSession,
}) => {
  await seedAuthenticatedSession();
  await page.goto('/watchlist');

  await page.getByLabel('Watchlist name').fill('Friday movie night');
  await page.getByRole('button', { name: 'Create shared watchlist' }).click();

  await expect(
    page.getByText('Created shared watchlist Friday movie night.'),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Friday movie night' }),
  ).toBeVisible();
});

test('invite links can be accepted by another signed-in user', async ({
  page,
  seedAuthenticatedSession,
  switchAuthenticatedUser,
}) => {
  const sharedWatchlist = createE2ESharedWatchlist('Friday movie night', 0);

  await seedAuthenticatedSession({
    sharedState: {
      inviteLinks: [
        createE2EWatchlistInviteLink({
          token: 'secret-invite-token',
          watchlistId: sharedWatchlist.id,
        }),
      ],
      memberships: [],
    },
    user: 'owner',
    watchlists: [
      {
        id: `e2e-personal-watchlist-e2e-user`,
        kind: 'personal',
        name: 'My watchlist',
        ownerUserId: 'e2e-user',
      },
      sharedWatchlist,
    ],
  });
  await switchAuthenticatedUser('collaborator');
  await page.goto('/watchlist/invite/secret-invite-token');

  await expect(
    page.getByRole('heading', { name: 'Friday movie night' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Join Friday movie night' }).click();

  await expect(page).toHaveURL(`/watchlist/${sharedWatchlist.id}`);
  await expect(
    page.getByText('Owner-managed access'),
  ).toBeVisible();
});

test('owners can inspect and remove shared watchlist members', async ({
  page,
  seedAuthenticatedSession,
}) => {
  const sharedWatchlist = createE2ESharedWatchlist('Friday movie night', 0);

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
    user: 'owner',
    watchlists: [
      {
        id: `e2e-personal-watchlist-e2e-user`,
        kind: 'personal',
        name: 'My watchlist',
        ownerUserId: 'e2e-user',
      },
      sharedWatchlist,
    ],
  });
  await page.goto(`/watchlist/${sharedWatchlist.id}`);

  await expect(page.getByText('friend@example.com')).toBeVisible();
  await page.getByRole('button', { name: 'Remove access' }).click();
  await page.getByRole('button', { name: 'Confirm removal' }).click();

  await expect(
    page.getByText('Removed friend@example.com from Friday movie night.'),
  ).toBeVisible();
  await expect(
    page.getByRole('listitem').filter({ hasText: 'friend@example.com' }),
  ).toHaveCount(0);
});

test('editors can leave a shared watchlist and lose access', async ({
  page,
  seedAuthenticatedSession,
}) => {
  const sharedWatchlist = createE2ESharedWatchlist('Friday movie night', 0);

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
        id: 'e2e-personal-watchlist-e2e-user',
        kind: 'personal',
        name: 'Owner watchlist',
        ownerUserId: 'e2e-user',
      },
      sharedWatchlist,
    ],
  });
  await page.goto(`/watchlist/${sharedWatchlist.id}`);

  await page.getByRole('button', { name: 'Leave watchlist' }).click();
  await page.getByRole('button', { name: 'Confirm leave' }).click();

  await expect(page).toHaveURL('/watchlist');

  const response = await page.goto(`/watchlist/${sharedWatchlist.id}`);

  expect(response?.status()).toBe(404);
});

test('owners cannot leave their own shared watchlist', async ({
  page,
  seedAuthenticatedSession,
}) => {
  const sharedWatchlist = createE2ESharedWatchlist('Friday movie night', 0);

  await seedAuthenticatedSession({
    sharedState: { inviteLinks: [], memberships: [] },
    user: 'owner',
    watchlists: [
      {
        id: 'e2e-personal-watchlist-e2e-user',
        kind: 'personal',
        name: 'My watchlist',
        ownerUserId: 'e2e-user',
      },
      sharedWatchlist,
    ],
  });
  await page.goto(`/watchlist/${sharedWatchlist.id}`);

  await expect(page.getByRole('button', { name: 'Leave watchlist' })).toHaveCount(0);

  const status = await page.evaluate(async (watchlistId) => {
    const response = await fetch(`/api/watchlist/shared/${watchlistId}/membership`, {
      method: 'DELETE',
    });

    return response.status;
  }, sharedWatchlist.id);

  expect(status).toBe(403);
  await page.reload();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Friday movie night' }),
  ).toBeVisible();
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
