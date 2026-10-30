import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import edition from '../src/data/stories.json' with { type: 'json' };

const widths = [320, 360, 390, 430, 768, 1024, 1440];
for (const width of widths) {
  test(`public pages fit ${width}px and retain usable navigation`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    for (const route of ['home', 'search/faith', 'search/zzzzmissing', 'saved', 'contact', 'advertise', 'latest', `story/${edition.stories[3].slug}`]) {
      await page.goto(`./#${route}`);
      await expect(page.locator('main h1')).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      // Detect clipped content even if an ancestor happens to hide overflow.
      expect(await page.locator('main').evaluate(main => [...main.querySelectorAll('h1,h2,h3,p,input,button')].filter(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && (r.right > innerWidth + 1 || r.left < -1);
      }).map(el => el.className || el.tagName))).toEqual([]);
    }
    await page.goto('./');
    if (width <= 1000) {
      const menu = page.getByRole('button', { name: 'Open sections menu' });
      await expect(menu).toBeVisible();
      await menu.click();
      await expect(menu).toHaveAttribute('aria-expanded', 'true');
      for (const name of ['Latest newsroom reports', 'Your reading list', 'Contact', 'Advertise']) {
        await expect(page.locator('#menu-dialog').getByRole('link', { name, exact: true })).toBeVisible();
      }
      await page.keyboard.press('Escape');
      await expect(menu).toBeFocused();
      await expect(menu).toHaveAttribute('aria-expanded', 'false');
      const target = await menu.boundingBox();
      expect(target.width).toBeGreaterThanOrEqual(44);
      expect(target.height).toBeGreaterThanOrEqual(44);
    }
    expect(errors).toEqual([]);
  });
}

test('public pages and search dialog have no detected WCAG AA violations', async ({ page }) => {
  test.setTimeout(120_000); // six full-page axe scans exceed the 30 s default on busy machines
  for (const route of ['home', 'contact', 'advertise', 'search/faith', `story/${edition.stories[3].slug}`, 'saved']) {
    await page.goto(`./#${route}`);
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    expect(result.violations, route).toEqual([]);
  }
  await page.getByRole('button', { name: 'Search stories' }).click();
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(result.violations).toEqual([]);
});

test('dialog traps keyboard focus, escapes and restores its opener', async ({ page }) => {
  await page.goto('./');
  const opener = page.getByRole('button', { name: 'Search stories' });
  await opener.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Search headlines, topics or authors')).toBeFocused();
  // Native dialogs can yield focus to browser chrome (BODY), never to background controls.
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement === document.body || !!document.activeElement.closest('#search-dialog'))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(opener).toBeFocused();
  expect(await opener.evaluate(el => getComputedStyle(el).outlineStyle)).toBe('solid');
});

test('filters announce changes and loading more retains keyboard focus', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: 'Business', exact: true }).click();
  await expect(page.locator('#toast')).toHaveText('2 Business stories shown.');
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await page.getByRole('button', { name: 'More stories', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#latest-grid .story-card').nth(6).locator('h3 a')).toBeFocused();
  await expect(page.locator('#toast')).toHaveText('12 stories shown.');
});

test('sharing works when clipboard permission is unavailable', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { throw new Error('Denied'); } } }));
  const story = edition.stories[3];
  await page.goto(`./#story/${story.slug}`);
  const share = page.getByRole('button', { name: 'Copy original article link' });
  await share.click();
  await expect(page.getByRole('dialog', { name: 'Share this story' })).toBeVisible();
  await expect(page.getByLabel('Article link', { exact: true })).toHaveValue(story.source);
  await expect(page.getByLabel('Article link', { exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(share).toBeFocused();
});

test('responsive images reserve dimensions and reduced motion removes hover transforms', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('./');
  const hero = page.locator('.lead-photo img');
  await expect(hero).toHaveAttribute('width', '1024');
  await expect(hero).toHaveAttribute('height', '576');
  await expect(hero).toHaveAttribute('srcset', /responsive/);
  await expect(hero).toHaveJSProperty('complete', true);
  expect(await hero.evaluate(img => img.naturalWidth)).toBeGreaterThan(0);
  await page.locator('.lead-story').hover();
  expect(await hero.evaluate(img => getComputedStyle(img).transform)).toBe('none');
  await expect(page.locator('#latest-grid img').first()).toHaveAttribute('loading', 'lazy');
});
