import { expect, test, type Page } from '@playwright/test';

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`Missing required full-stack test environment variable ${name}.`);
  }

  return value;
}

async function readCalendarSubscriptionUrl(page: Page): Promise<string> {
  const subscriptionUrl = (await page.locator('code').textContent())?.trim() ?? '';

  if (!subscriptionUrl.includes('/api/calendar/')) {
    throw new Error('Calendar settings did not render a subscription URL.');
  }

  return subscriptionUrl;
}

test('disposable Supabase runtime proves real auth, calendar rotation, and watchlist persistence', async ({
  page,
  request,
}) => {
  const email = requireEnv('MOVIECAL_FULL_STACK_USER_EMAIL');
  const password = requireEnv('MOVIECAL_FULL_STACK_USER_PASSWORD');
  const movieTitle = requireEnv('MOVIECAL_FULL_STACK_MOVIE_TITLE');

  await page.goto('/sign-in?next=%2Fwatchlist');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL('/watchlist');
  await expect(page.getByText(email)).toBeVisible();
  await expect(page.getByRole('heading', { name: movieTitle })).toBeVisible();

  await page.goto('/settings/calendar');
  await expect(
    page.getByRole('heading', { name: 'Calendar settings' }),
  ).toBeVisible();

  const initialUrl = await readCalendarSubscriptionUrl(page);
  const initialFeedResponse = await request.get(initialUrl);

  expect(initialFeedResponse.status()).toBe(200);
  expect(await initialFeedResponse.text()).toContain(movieTitle);

  await page.getByRole('button', { name: 'Rotate subscription URL' }).click();
  await expect(page).toHaveURL('/settings/calendar');

  const rotatedUrl = await readCalendarSubscriptionUrl(page);

  if (rotatedUrl === initialUrl) {
    throw new Error('Calendar token did not rotate.');
  }

  const [oldFeedStatus, rotatedFeedResponse] = await Promise.all([
    request.get(initialUrl).then((response) => response.status()),
    request.get(rotatedUrl),
  ]);

  expect(oldFeedStatus).toBe(404);
  expect(rotatedFeedResponse.status()).toBe(200);
  expect(await rotatedFeedResponse.text()).toContain(movieTitle);

  await page.goto('/watchlist');
  await expect(page.getByRole('heading', { name: movieTitle })).toBeVisible();

  await page
    .getByRole('listitem')
    .filter({ hasText: movieTitle })
    .getByRole('button', { name: 'Remove' })
    .click();

  await expect(
    page.getByText(`Removed ${movieTitle} from My watchlist.`),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: movieTitle })).toHaveCount(0);

  await page.reload();

  await expect(page.getByRole('heading', { name: movieTitle })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Your watchlist is empty' })).toBeVisible();
});
