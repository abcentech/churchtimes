import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const report = { id: 400, status: 'published', slug: 'mobile-report', title: 'CommunityCare'.repeat(20), excerpt: 'LongHeadline'.repeat(40), category: 'News', content: 'Readers need clear paragraphs on small screens.\n\n' + 'AnUnbrokenWord'.repeat(100) };
const send = (route, docs, extra = {}) => route.fulfill({ json: { docs, ...extra } });

for (const width of [320, 360, 390, 430, 768, 1024, 1440]) {
  test(`mocked feed, article, loading and error states fit ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route('**/api/articles?**', async route => {
      const url = new URL(route.request().url());
      expect(url.searchParams.get('where[status][equals]')).toBe('published');
      await send(route, [report, { ...report, status: 'draft', title: 'Private story' }]);
    });
    for (const route of ['latest', 'report/mobile-report']) {
      await page.goto(`/#${route}`);
      await expect(page.locator(route === 'latest' ? '.newsroom-card' : '.newsroom-article-body')).toBeVisible();
      await expect(page.locator('main')).not.toContainText('Private story');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
      expect(result.violations).toEqual([]);
    }
    await page.unrouteAll({ behavior: 'wait' });
    let release;
    const gate = new Promise(resolve => release = resolve);
    await page.route('**/api/articles?**', async route => { await gate; await route.fulfill({ status: 503, body: 'Unavailable' }); });
    await page.goto('/#latest');
    await expect(page.locator('#cms-latest')).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByText('Loading published reports…')).toBeVisible();
    release();
    await expect(page.getByRole('heading', { name: 'We couldn’t reach the newsroom.' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('pagination keeps focus on new reports and announces results', async ({ page }) => {
  await page.route('**/api/articles?**', route => {
    const next = new URL(route.request().url()).searchParams.get('page') === '2';
    return next ? send(route, [{ ...report, slug: 'next-report', title: 'Another public report' }]) : send(route, [report], { hasNextPage: true, nextPage: 2 });
  });
  await page.goto('/#latest');
  await page.getByRole('button', { name: 'More reports' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#newsroom-grid h2 a').nth(1)).toBeFocused();
  await expect(page.locator('#feed-announcement')).toHaveText('1 report loaded. 2 reports shown.');
});

test('report sharing offers a selectable URL when clipboard access fails', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { throw new Error('Denied'); } } }));
  await page.route('**/api/articles?**', route => send(route, [report]));
  await page.goto('/#report/mobile-report');
  await page.getByRole('button', { name: 'Copy article link' }).click();
  await expect(page.getByLabel('Article link', { exact: true })).toHaveValue(page.url());
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Copy article link' })).toBeFocused();
});
