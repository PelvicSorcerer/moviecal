import { test, expect } from '@playwright/test';

test('homepage shows scaffold message', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('h2')).toContainText(
    'Track release dates without losing the privacy of your own watchlist.',
  );
});
