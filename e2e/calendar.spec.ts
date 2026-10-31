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
  await page.getByRole('button', { name: 'Confirm rotation' }).click();
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

test('copy link copies the exact subscription URL and announces success', async ({
  context,
  page,
  seedAuthenticatedSession,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await seedAuthenticatedSession();
  await page.goto('/settings/calendar');

  const subscriptionUrl = (await page.locator('code').textContent())?.trim();

  await page.getByRole('button', { name: 'Copy link' }).click();

  await expect(page.getByRole('status')).toContainText('Link copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    subscriptionUrl,
  );
});

test('cancelling rotation leaves the subscription URL unchanged', async ({
  page,
  seedAuthenticatedSession,
}) => {
  await seedAuthenticatedSession();
  await page.goto('/settings/calendar');

  const subscriptionUrl = page.locator('code');
  const initialUrl = (await subscriptionUrl.textContent())?.trim();

  await page.getByRole('button', { name: 'Rotate subscription URL' }).click();
  await expect(
    page.getByText('Existing subscriptions will stop updating'),
  ).toBeVisible();
  // Keyboard activation: the Next dev overlay can cover the Cancel button in CI.
  await page.getByRole('button', { name: 'Cancel' }).press('Enter');

  await expect(
    page.getByRole('button', { name: 'Confirm rotation' }),
  ).toHaveCount(0);
  await expect(subscriptionUrl).toHaveText(initialUrl ?? '');
});

test('rotation can be confirmed by keyboard alone at a narrow viewport', async ({
  page,
  seedAuthenticatedSession,
}) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await seedAuthenticatedSession();
  await page.goto('/settings/calendar');

  const subscriptionUrl = page.locator('code');
  const initialUrl = (await subscriptionUrl.textContent())?.trim();

  const rotateButton = page.getByRole('button', {
    name: 'Rotate subscription URL',
  });
  await rotateButton.focus();
  await page.keyboard.press('Enter');

  // The subscription UI itself must fit the 375px viewport.
  // Scoped to the calendar section: the app shell's Sign out button already
  // overflows at 375px independently of this page.
  const overflowing = await page.evaluate(() => {
    const section = document.querySelector('code')?.closest('section');

    return ['code', 'button', 'form'].flatMap((selector) =>
      [...(section?.querySelectorAll(selector) ?? [])]
        .map((el) => ({
          selector,
          text: el.textContent?.trim().slice(0, 30),
          right: Math.round(el.getBoundingClientRect().right),
          viewport: window.innerWidth,
        }))
        .filter((box) => box.right > box.viewport),
    );
  });
  expect(overflowing).toEqual([]);

  // Cancel receives focus first; Cancel returns focus to the trigger.
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(rotateButton).toBeFocused();
  await expect(subscriptionUrl).toHaveText(initialUrl ?? '');

  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await expect(
    page.getByRole('button', { name: 'Confirm rotation' }),
  ).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(subscriptionUrl).not.toHaveText(initialUrl ?? '');
});
