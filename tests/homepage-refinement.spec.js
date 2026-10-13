import { test, expect } from '@playwright/test';
async function uniqueStories(page) {
  const slugs=await page.locator('main article[data-story-slug]').evaluateAll(articles=>articles.map(article=>article.dataset.storySlug));
  expect(new Set(slugs).size).toBe(slugs.length);
}
test('homepage has a strong lead, limited sections and no duplicate stories',async({page})=>{
  await page.goto('./');
  await expect(page.locator('.lead-story h1')).toBeVisible();
  await expect(page.locator('.homepage-latest h2')).toHaveText('Latest news.');
  await expect(page.locator('.homepage-perspectives')).toHaveCount(1);
  await expect(page.locator('.society-section,.interview-feature,.publication-strip')).toHaveCount(0);
  await uniqueStories(page);
  await page.getByRole('button',{name:'More stories',exact:true}).click();
  await uniqueStories(page);
  await page.getByRole('button',{name:'Opinion',exact:true}).click();
  await uniqueStories(page);
  await expect(page.locator('#latest-grid .story-card')).toHaveCount(3);
});
test('unconfigured advertising leaves no slot or external advertising request',async({page})=>{
  const requests=[];page.on('request',request=>requests.push(request.url()));
  await page.goto('./');
  await expect(page.locator('.advertising-slot,template[data-ad-placement]')).toHaveCount(0);
  expect(requests.filter(url=>/googlesyndication|doubleclick|adsbygoogle/.test(url))).toEqual([]);
});
