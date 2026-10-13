import { test, expect } from '@playwright/test';

test('newsroom without a CMS retains a navigable current edition', async ({ page }) => {
  await page.goto('./#latest');
  await expect(page.getByRole('heading', { name: 'The latest reports.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'The newsroom is taking shape.' })).toBeVisible();
  await expect(page.locator('main')).toHaveCount(1);
  await page.locator('main').getByRole('link', { name: 'Explore the current edition' }).click();
  await expect(page.locator('.lead-story h1')).toBeVisible();
});

test('unconfigured direct newsroom article links offer the current edition', async ({ page }) => {
  await page.goto('./#report/faith-in-public-life');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('The newsroom is taking shape.');
  await expect(page.locator('#cms-report')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('main').getByRole('link', { name: 'Explore the current edition' })).toBeVisible();
});
