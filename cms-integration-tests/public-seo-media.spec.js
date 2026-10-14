import {test,expect} from '@playwright/test';
const cms=process.env.PUBLIC_CMS_TEST_URL;
const ssr=process.env.PUBLIC_SSR_TEST_URL;
async function fixtures(request) {
 const fixture=await (await request.get(cms+'/__test/fixtures')).json();
 const article=(await (await request.get(cms+'/api/articles?depth=1&where[slug][equals]='+fixture.publishedSlug)).json()).docs[0];
 return {fixture,article};
}
test('production host serves valid published-only XML and staging robots',async({page,request})=>{
 const {fixture,article}=await fixtures(request);
 await page.goto(ssr+'/');
 for(const [path,root] of [['sitemap.xml','urlset'],['feed.xml','rss']]) {
  const response=await request.get(ssr+'/'+path);expect(response.status()).toBe(200);expect(response.headers()['x-robots-tag']).toBe('noindex');
  const xml=await response.text();expect(xml).toContain('/reports/'+fixture.publishedSlug+'/');expect(xml).not.toContain(fixture.draftSlug);
  const parsed=await page.evaluate(({xml,root})=>{
   const document=new DOMParser().parseFromString(xml,'application/xml');
   return {errors:document.querySelectorAll('parsererror').length,root:document.documentElement.localName,items:[...document.querySelectorAll('item')].map(item=>({title:item.querySelector('title').textContent,description:item.querySelector('description').textContent,image:item.getElementsByTagNameNS('http://search.yahoo.com/mrss/','content').length})),locations:[...document.querySelectorAll('loc')].map(node=>node.textContent)};
  },{xml,root});
  expect(parsed.errors).toBe(0);expect(parsed.root).toBe(root);
  if(root==='rss'){const item=parsed.items.find(item=>item.title===article.title);expect(item.description).toBe(article.excerpt);expect(item.image).toBe(1);expect(parsed.items.length).toBeLessThanOrEqual(30);}
  else {expect(parsed.locations).toContain('https://staging-public.example.test/category/'+article.category.slug+'/');expect(parsed.locations).toContain('https://staging-public.example.test/about/');}
 }
 expect(await (await request.get(ssr+'/robots.txt')).text()).toBe('User-agent: *\nDisallow: /\n');
});
test('SSR social metadata, responsive hero and inline captions survive hydration',async({page,request},testInfo)=>{
 const {fixture,article}=await fixtures(request);
 const response=await request.get(ssr+'/reports/'+fixture.publishedSlug+'/');expect(response.status()).toBe(200);
 const html=await response.text();expect(html).toContain('name="twitter:card" content="summary_large_image"');expect(html).toContain('property="og:type" content="article"');
 const calls=[];page.on('request',request=>{if(new URL(request.url()).pathname==='/api/articles')calls.push(request.url());});
 await page.goto(ssr+'/reports/'+fixture.publishedSlug+'/');await expect(page.locator('.article-header h1')).toHaveText(article.title);
 const hero=page.locator('.newsroom-figure').first();await expect(hero.locator('img')).toHaveAttribute('srcset',/\d+w/);await expect(hero.locator('img')).toHaveAttribute('sizes',/100vw/);await expect(hero.locator('img')).toHaveAttribute('width',/\d+/);await expect(hero.locator('img')).toHaveAttribute('height',/\d+/);await expect(hero.locator('figcaption')).toContainText('CMS integration caption');
 await expect(page.locator('.newsroom-article-body .cms-figure img')).toHaveAttribute('srcset',/\d+w/);
 await expect(page.locator('.newsroom-article-body figcaption')).toContainText('Credit: CMS integration credit');
 expect(calls).toHaveLength(0);
 const metadata=await page.evaluate(()=>{
  const schema=JSON.parse(document.querySelector('#article-schema').textContent);
  return {image:document.querySelector('meta[property="og:image"]').content,width:document.querySelector('meta[property="og:image:width"]').content,canonical:document.querySelector('link[rel="canonical"]').href,schema};
 });
 expect(metadata.image).toBe(metadata.schema.image[0].url);expect(Number(metadata.width)).toBeGreaterThanOrEqual(800);expect(metadata.canonical).toBe(metadata.schema.url);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:testInfo.outputPath('article-'+testInfo.project.name+'.png'),fullPage:true});
 await page.goto(ssr+'/category/'+article.category.slug+'/');await expect(page.locator('h1')).toHaveText(article.category.title);await expect(page.locator('#newsroom-grid')).toContainText(article.title);
 await page.goto(ssr+'/about/');await expect(page.locator('h1')).toContainText('A wider lens.');
});
