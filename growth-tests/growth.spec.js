import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
// Every CMS response here is a STUB (page.route); no real CMS, newsletter or WhatsApp service is contacted.
const card = (slug, title, day = '20', extra = {}) => ({ id: slug, slug, title, excerpt: `Synthetic excerpt about ${title}.`, publishedAt: `2026-10-${day}T08:00:00.000Z`, category: { title: 'News', slug: 'news' }, ...extra });
async function stubCMS(page, { search, topics = {}, offlineTopics = false } = {}) {
  const calls = { search: [], topics: [] };
  await page.route('https://challenges.cloudflare.com/**', route => route.abort());
  await page.route(/\/api\//, async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/public/search') { calls.search.push(url); return search ? search(url, route) : route.fulfill({ json: { docs: [card('faith-in-lagos', 'Faith in Lagos'), card('church-growth', 'Church growth report', '19')], totalDocs: 2, hasNextPage: false } }); }
    if (url.pathname === '/api/categories') return route.fulfill({ json: { docs: [{ id: 1, slug: 'news', title: 'News' }, { id: 2, slug: 'faith', title: 'Faith' }] } });
    if (url.pathname === '/api/public/topics') return route.fulfill({ json: { docs: Object.values(topics).map(t => t.topic) } });
    const topic = url.pathname.match(/^\/api\/public\/(topics|authors)\/([^/]+)$/);
    if (topic) { calls.topics.push(topic[2]); if (offlineTopics) return route.abort(); const body = topics[topic[2]]; return body ? route.fulfill({ json: body }) : route.fulfill({ status: 404, json: {} }); }
    if (url.pathname === '/api/articles') return route.fulfill({ json: { docs: [], hasNextPage: false, totalPages: 1 } });
    return route.fulfill({ status: 404, json: {} });
  });
  return calls;
}
const youth = { topic: { name: 'Youth ministry', slug: 'youth-ministry', kind: 'ministry', description: 'Young people and the church.' }, articles: [card('youth-camp', 'Youth camp opens', '21'), card('older-story', 'Older youth story', '02')] };
const axe = page => new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']);

test('connect band carries the existing newsletter sign-up (source home) instead of the mailto, once per page', async ({ page }) => {
  await stubCMS(page);
  await page.goto('/');
  const band = page.locator('#connect');
  await expect(band.locator('form[data-reader-form="newsletter"]')).toHaveAttribute('data-source', 'home');
  await expect(band.getByRole('link', { name: 'Request updates' })).toHaveCount(0);
  await expect(band).toContainText('confirm by email, unsubscribe at any time');
  await expect(page.locator('form[data-reader-form="newsletter"]')).toHaveCount(1);
  await expect(band.getByRole('checkbox')).toBeVisible();
  await page.goto('/#about');
  await expect(page.locator('#connect form[data-reader-form="newsletter"]')).toHaveAttribute('data-source', 'footer');
  expect((await axe(page).include('#connect').analyze()).violations).toEqual([]);
});

test('search suggestions: debounced combobox, keyboard selection, Escape closes the popup before the dialog', async ({ page }) => {
  const calls = await stubCMS(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Search stories' }).click();
  const input = page.getByRole('combobox', { name: 'Search headlines, topics or authors' });
  await input.pressSequentially('fai', { delay: 20 });
  await input.pressSequentially('th', { delay: 20 });
  const listbox = page.getByRole('listbox', { name: 'Search suggestions' });
  await expect(listbox.getByRole('option')).toHaveCount(3);
  expect(calls.search).toHaveLength(1);
  expect(calls.search[0].searchParams.get('q')).toBe('faith');expect(calls.search[0].searchParams.get('limit')).toBe('5');
  await expect(input).toHaveAttribute('aria-expanded', 'true');
  await expect(listbox.locator('mark.growth-mark').first()).toHaveText('Faith');
  await input.press('ArrowDown');
  await expect(input).toHaveAttribute('aria-activedescendant', 'search-suggest-0');
  await expect(listbox.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
  expect((await axe(page).include('#search-dialog').analyze()).violations).toEqual([]);
  await input.press('Escape');
  await expect(listbox).toBeHidden();
  await expect(page.locator('#search-dialog')).toBeVisible();
  await input.press('ArrowDown');
  await expect(listbox).toBeVisible();
  await input.press('ArrowUp');
  await expect(input).toHaveAttribute('aria-activedescendant', 'search-suggest-2');
  await input.press('Enter');
  await expect(page).toHaveURL(/#search\/faith$/);
  await page.getByRole('button', { name: 'Search stories' }).click();
  await page.locator('#search-input').fill('faith');
  const suggestions = page.getByRole('listbox', { name: 'Search suggestions' }).getByRole('option');
  await expect(suggestions.first()).toBeVisible();
  await suggestions.first().click();
  await expect(page).toHaveURL(/\/faith-in-lagos\/$/);
});

test('search: 429 pauses suggestions, offline is explained, results are highlighted and filterable, recent searches are kept', async ({ page, context }) => {
  let busy = true;
  const calls = await stubCMS(page, { search: (url, route) => busy && url.searchParams.get('limit') === '5' ? route.fulfill({ status: 429, headers: { 'Retry-After': '30' }, json: {} }) : route.fulfill({ json: { docs: [card('faith-in-lagos', 'Faith in Lagos')], totalDocs: 1, hasNextPage: false } }) });
  await page.goto('/');
  await page.getByRole('button', { name: 'Search stories' }).click();
  await page.getByRole('combobox').fill('faith');
  await expect(page.locator('.growth-suggest-status')).toContainText('paused');
  await page.getByRole('combobox').fill('faith and');
  await page.waitForTimeout(500);
  expect(calls.search.filter(u => u.searchParams.get('limit') === '5')).toHaveLength(1);
  busy = false;
  await page.getByRole('combobox').press('Enter');
  await expect(page.locator('#cms-search mark.growth-mark').first()).toHaveText('Faith');
  await page.getByLabel('Section', { exact: true }).selectOption('faith');
  await expect.poll(() => calls.search.some(u => u.searchParams.get('category') === 'faith' && u.searchParams.get('q') === 'faith and')).toBe(true);
  await page.getByLabel('Year', { exact: true }).selectOption('2025');
  await expect.poll(() => calls.search.some(u => u.searchParams.get('category') === 'faith' && u.searchParams.get('year') === '2025')).toBe(true);
  await expect(page.getByRole('status').filter({ hasText: 'filtered by Faith, 2025' })).toBeVisible();
  expect((await axe(page).include('#main').analyze()).violations).toEqual([]);
  await page.getByRole('button', { name: 'Search stories' }).click();
  await expect(page.getByRole('list', { name: 'RECENT SEARCHES' }).getByRole('button', { name: 'faith and' })).toBeVisible();
  await context.setOffline(true);
  await page.locator('#search-input').fill('lagos');
  await expect(page.locator('.growth-suggest-status')).toContainText('offline');
  await context.setOffline(false);
  await page.getByRole('button', { name: 'Clear recent searches' }).click();
  await expect(page.locator('.growth-recent')).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('ct-recent-searches'))).toBeNull();
});

test('topic page: follow locally, Following feed on the home page, offline copy, unfollow', async ({ page, context }) => {
  await stubCMS(page, { topics: { 'youth-ministry': youth } });
  await page.goto('/#topic/youth-ministry');
  await expect(page.getByRole('heading', { level: 1, name: 'Youth ministry' })).toBeVisible();
  await expect(page).toHaveTitle('Youth ministry — Church Times Nigeria');
  const follow = page.getByRole('button', { name: 'Follow Youth ministry' });
  await expect(follow).toHaveAttribute('aria-pressed', 'false');
  expect((await axe(page).include('#main').analyze()).violations).toEqual([]);
  await follow.click();
  await expect(page.getByRole('button', { name: 'Following Youth ministry' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#toast')).toContainText('You are following Youth ministry');
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem('ct-following')))).toEqual([{ kind: 'topic', slug: 'youth-ministry', name: 'Youth ministry' }]);
  await page.goto('/');
  const feed = page.locator('#growth-following');
  await expect(feed.getByRole('heading', { name: 'From the topics and writers you follow.' })).toBeVisible();
  await expect(feed.locator('.story-card h2')).toHaveText(['Youth camp opens', 'Older youth story']);
  expect((await axe(page).include('#growth-following').analyze()).violations).toEqual([]);
  // Offline (navigator.onLine false): the saved copy is shown without any request.
  await context.setOffline(true);
  await page.evaluate(() => { location.hash = 'latest'; });
  await page.evaluate(() => { location.hash = 'home'; });
  await expect(feed).toContainText('You are offline. Showing the list saved');
  await expect(feed.locator('.story-card h2')).toHaveText(['Youth camp opens', 'Older youth story']);
  await context.setOffline(false);
  // Online but the newsroom is unreachable: the saved copy is shown with an honest note.
  await stubCMS(page, { topics: { 'youth-ministry': youth }, offlineTopics: true });
  await page.goto('/');
  await expect(feed).toContainText('We could not reach the newsroom. Showing the list saved');
  await expect(feed.locator('.story-card h2')).toHaveText(['Youth camp opens', 'Older youth story']);
  await feed.getByText('Manage what you follow (1)').click();
  await feed.getByRole('button', { name: 'Unfollow Youth ministry' }).click();
  await expect(page.locator('#growth-following')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('ct-following'))).toBeNull();
});

test('topic index and unavailable topic', async ({ page }) => {
  await stubCMS(page, { topics: { 'youth-ministry': youth } });
  await page.goto('/#topic/');
  await expect(page.getByRole('heading', { level: 1, name: 'Topics.' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Youth ministry' })).toHaveAttribute('href', '/topic/youth-ministry/');
  await expect(page.getByRole('button', { name: 'Follow Youth ministry' })).toBeVisible();
  await page.goto('/#topic/does-not-exist');
  await expect(page.getByRole('heading', { level: 1, name: 'Topic unavailable.' })).toBeVisible();
});

test('WhatsApp group prompt: honest wording, plain link, dismissal remembered', async ({ page }) => {
  await stubCMS(page);
  await page.goto('/');
  const prompt = page.getByRole('complementary', { name: 'Join our WhatsApp group' });
  await expect(prompt).toBeVisible();
  await expect(prompt).toContainText('other members can see your phone number');
  await expect(prompt.getByRole('link', { name: /Join the WhatsApp group/ })).toHaveAttribute('href', /^https:\/\/chat\.whatsapp\.com\//);
  expect((await axe(page).include('#growth-wa').analyze()).violations).toEqual([]);
  await prompt.getByRole('button', { name: 'No thanks' }).click();
  await expect(prompt).toHaveCount(0);
  await page.reload();
  await page.waitForTimeout(1500);
  await expect(page.locator('#growth-wa')).toHaveCount(0);
});

test('home shows the KJV verse of the day; CMS report bodies get scripture cards that are removed on route change', async ({ page }) => {
  await stubCMS(page);
  const article = { ...card('scripture-story', 'Scripture story'), status: 'published', content: { root: { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', text: 'The preacher read John 3:16 to the congregation.' }] }] } } };
  await page.route(/\/api\/articles\?/, route => route.fulfill({ json: { docs: new URL(route.request().url()).searchParams.get('where[slug][equals]') === 'scripture-story' ? [article] : [], hasNextPage: false, totalPages: 1 } }));
  await page.goto('/');
  const verse = page.getByRole('region', { name: 'Verse of the day' });
  await expect(verse).toBeVisible();
  await expect(verse).toContainText('KJV');
  expect((await axe(page).include('#growth-verse').analyze()).violations).toEqual([]);
  await page.goto('/#report/scripture-story');
  const ref = page.getByRole('button', { name: /John 3:16: show/ });
  await expect(ref).toBeVisible();
  await ref.click();
  await expect(ref).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.newsroom-article-body')).toContainText('For God so loved the world');
  const prompt = page.locator('#growth-wa');
  await expect(prompt).toBeVisible();
  expect(await prompt.evaluate(el => el.nextElementSibling?.classList.contains('newsroom-article-end'))).toBe(true);
  await page.evaluate(() => { location.hash = 'about'; });
  await expect(page.locator('.ct-scripture-ref')).toHaveCount(0);
});

test('dark theme: growth UI keeps WCAG AA contrast (search suggestions with highlights, topic, Following, WhatsApp)', async ({ page }) => {
  await page.addInitScript(() => { try { localStorage.setItem('ct-theme', 'dark'); } catch {} });
  await stubCMS(page, { topics: { 'youth-ministry': youth } });
  await page.goto('/#topic/youth-ministry');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'Follow Youth ministry' }).click();
  expect((await axe(page).include('#main').analyze()).violations).toEqual([]);
  await page.goto('/');
  await expect(page.locator('#growth-following .story-card')).toHaveCount(2);
  await expect(page.locator('#growth-wa')).toBeVisible();
  expect((await axe(page).include('#growth-following').include('#growth-wa').include('#connect').analyze()).violations).toEqual([]);
  await page.getByRole('button', { name: 'Search stories' }).click();
  await page.locator('#search-input').fill('faith');
  await expect(page.locator('#search-suggest-list mark.growth-mark').first()).toBeVisible();
  expect((await axe(page).include('#search-dialog').analyze()).violations).toEqual([]);
});
