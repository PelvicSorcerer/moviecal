import { test, expect } from '@playwright/test';

test('homepage shows scaffold message', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('h2')).toContainText('Early MVP scaffold');
});
