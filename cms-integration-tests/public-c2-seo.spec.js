// Real anonymous Payload REST + disposable PostgreSQL, using synthetic metadata.
// C2 is merged in #53. No C7 endpoint or real migration is claimed here.
import {test,expect} from '@playwright/test';
import {createPublicServer} from '../tools/serve-public.mjs';
const cms=process.env.PUBLIC_CMS_TEST_URL;
for(const template of ['/reports/{slug}/','/{slug}/'])test('real C2 SEO projection survives production hydration with '+template,async({page,request})=>{
 const fixture=await (await request.get(cms+'/__test/fixtures')).json();
 const result=await request.get(cms+'/api/articles?depth=1&where[status][equals]=published&where[slug][equals]='+fixture.publishedSlug);
 expect(result.status()).toBe(200);const article=(await result.json()).docs[0];
 expect(article.seoTitle).toBe('Synthetic search title & public reporting');expect(article.seoDescription).toBe('Synthetic search description for public reporting & community life.');
 const server=createPublicServer({dist:process.env.PUBLIC_TEST_DIST,cmsUrl:cms,siteUrl:'https://staging-public.example.test',articlePathTemplate:template});await server.publicReady;
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {
  const origin='http://127.0.0.1:'+server.address().port,path=template.replace('{slug}',fixture.publishedSlug);
  const response=await page.goto(origin+path);expect(response.status()).toBe(200);
  await expect(page.locator('.article-header h1')).toHaveText(article.title);
  await expect(page).toHaveTitle(article.seoTitle+' — Church Times Nigeria');
  await expect(page.locator('meta[name="description"]')).toHaveAttribute('content',article.seoDescription);
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content',article.seoTitle);
  await expect(page.locator('meta[property="og:description"]')).toHaveAttribute('content',article.seoDescription);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href','https://staging-public.example.test'+path);
  expect(JSON.parse(await page.locator('#article-schema').textContent()).description).toBe(article.seoDescription);
  const feed=await (await request.get(origin+'/feed.xml')).text();expect(feed).toContain(article.excerpt.replaceAll('&','&amp;'));expect(feed).not.toContain(article.seoDescription.replaceAll('&','&amp;'));
  const fallback=(await (await request.get(cms+'/api/articles?where[slug][equals]='+fixture.seoFallbackSlug)).json()).docs[0];expect(fallback.seoTitle||'').toBe('');expect(fallback.seoDescription||'').toBe('');
  await page.goto(origin+template.replace('{slug}',fallback.slug));await expect(page).toHaveTitle(fallback.title+' — Church Times Nigeria');await expect(page.locator('meta[name="description"]')).toHaveAttribute('content',fallback.excerpt);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
