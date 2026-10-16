import {test,expect} from '@playwright/test';
const cms=process.env.PUBLIC_CMS_TEST_URL,publicHost=process.env.PUBLIC_SSR_TEST_URL;
test('owner SEO configuration is inert in the real-CMS article browser journey',async({page,request})=>{
 const fixture=await (await request.get(cms+'/__test/fixtures')).json();
 const network=[];page.on('request',request=>network.push(request.url()));
 await page.goto(publicHost+'/reports/'+fixture.publishedSlug+'/');await expect(page.locator('.article-header h1')).toBeVisible();
 await expect(page.locator('meta[name="google-site-verification"]')).toHaveAttribute('content','synthetic-owner-verification');
 const response=await request.get(publicHost+'/ads.txt');expect(response.status()).toBe(200);expect(await response.text()).toBe('example.test, synthetic-publisher, DIRECT\n');
 expect(network.filter(url=>!new Set([new URL(cms).origin,new URL(publicHost).origin]).has(new URL(url).origin))).toEqual([]);
 const robots=await request.get(publicHost+'/robots.txt');expect(await robots.text()).toBe('User-agent: *\nDisallow: /\n');
 const feed=await request.get(publicHost+'/feed.xml');expect(feed.headers()['x-robots-tag']).toBe('noindex');
});
