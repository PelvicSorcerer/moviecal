import { expect, test } from './test-fixtures';

test('authenticated users can view and rotate a deterministic calendar subscription URL', async ({
  page,
  request,
  seedAuthenticatedSession,
}) => {
  await seedAuthenticatedSession();
  await page.goto('/settings/calendar');

  await expect(
    page.getByRole('heading', { name: 'Calendar settings' }),
  ).toBeVisible();

  const subscriptionUrl = page.locator('code');
  const initialUrl = (await subscriptionUrl.textContent())?.trim();

  expect(initialUrl).toContain('/api/calendar/');

  const initialStatus = (await request.get(initialUrl ?? '')).status();

  expect(initialStatus).toBe(200);

  await page.getByRole('button', { name: 'Rotate subscription URL' }).click();
  await expect(page).toHaveURL('/settings/calendar');
  await expect(subscriptionUrl).not.toHaveText(initialUrl ?? '');

  const rotatedUrl = (await subscriptionUrl.textContent())?.trim();

  expect(rotatedUrl).toContain('/api/calendar/');
  expect(rotatedUrl).not.toBe(initialUrl);

  const [oldStatus, newStatus] = await Promise.all([
    request.get(initialUrl ?? '').then((response) => response.status()),
    request.get(rotatedUrl ?? '').then((response) => response.status()),
  ]);

  expect(oldStatus).toBe(404);
  expect(newStatus).toBe(200);
});
