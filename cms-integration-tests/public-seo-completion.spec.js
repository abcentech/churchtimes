// A13: real Payload REST + disposable PostgreSQL; synthetic migrated-style article.
// This is rendering/discovery proof, not the archive importer or CMS C7 endpoint.
import {test,expect} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createPublicServer} from '../tools/serve-public.mjs';
const cms=process.env.PUBLIC_CMS_TEST_URL,canonicalOrigin='https://staging-public.example.test';
const evidence=process.env.CAPTURE_PUBLIC_SEO_EVIDENCE==='1';
for(const template of ['/reports/{slug}/','/{slug}/'])for(const indexable of [false,true])test('real archive-style SEO/discovery '+template+' indexable='+indexable,async({browser,request},testInfo)=>{
 const fixture=await (await request.get(cms+'/__test/fixtures')).json();
 const result=await request.get(cms+'/api/articles?where[status][equals]=published&where[slug][equals]='+fixture.seoFallbackSlug+'&depth=1');
 expect(result.status()).toBe(200);const article=(await result.json()).docs[0];
 expect(article.publishedAt).toBe('2020-01-01T00:00:00.000Z');expect(article.bylineName).toBe('Synthetic archive contributor');
 expect(article.seoTitle||'').toBe('');expect(article.seoDescription||'').toBe('');
 const server=createPublicServer({dist:process.env.PUBLIC_TEST_DIST,cmsUrl:cms,siteUrl:canonicalOrigin,articlePathTemplate:template,indexable,redirectsFile:'',redirectsUrl:'',redirectPatterns:''});await server.publicReady;
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+server.address().port,path=template.replace('{slug}',article.slug),canonical=canonicalOrigin+path;
 const context=await browser.newContext({...testInfo.project.use,javaScriptEnabled:false});const page=await context.newPage();
 try {
  const response=await page.goto(origin+path);expect(response.status()).toBe(200);expect(response.headers()['x-robots-tag']).toBe(indexable?'index,follow':'noindex,nofollow');
  await expect(page.locator('h1')).toHaveText(article.title);await expect(page).toHaveTitle(article.title+' — Church Times Nigeria');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href',canonical);
  await expect(page.locator('meta[name="description"]')).toHaveAttribute('content',article.excerpt);
  for(const [key,value] of Object.entries({'og:type':'article','og:title':article.title,'og:description':article.excerpt,'og:url':canonical,'og:site_name':'Church Times Nigeria','article:published_time':article.publishedAt,'article:section':article.category.title}))await expect(page.locator('meta[property="'+key+'"]')).toHaveAttribute('content',value);
  await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute('content','summary_large_image');
  const schema=JSON.parse(await page.locator('#article-schema').textContent());
  expect(schema).toMatchObject({'@context':'https://schema.org','@type':'NewsArticle',headline:article.title,description:article.excerpt,url:canonical,mainEntityOfPage:canonical,datePublished:'2020-01-01T00:00:00.000Z',author:{'@type':'Person',name:'Synthetic archive contributor'},articleSection:article.category.title,publisher:{'@type':'Organization',name:'Church Times Nigeria'}});
  expect(Object.keys(schema.author).sort()).toEqual(['@type','name']);expect(JSON.stringify(schema)).not.toMatch(/email|password|staffRoles|apiKey/);
  const image=await page.locator('meta[property="og:image"]').getAttribute('content');expect(image).toMatch(new RegExp('^'+cms.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/api/media/file/'));
  expect(schema.image[0].url).toBe(image);expect(schema.image[0].width).toBeGreaterThanOrEqual(800);expect(schema.image[0].height).toBeGreaterThan(0);
  expect(Number(await page.locator('meta[property="og:image:width"]').getAttribute('content'))).toBe(schema.image[0].width);
  expect(Number(await page.locator('meta[property="og:image:height"]').getAttribute('content'))).toBe(schema.image[0].height);
  await expect(page.locator('.newsroom-figure img')).toHaveAttribute('width',/\d+/);await expect(page.locator('.newsroom-figure img')).toHaveAttribute('height',/\d+/);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const locations=[];
  for(const [route,root] of [['sitemap.xml','urlset'],['feed.xml','rss']]) {
   const xmlResponse=await request.get(origin+'/'+route);expect(xmlResponse.status()).toBe(200);expect(xmlResponse.headers()['x-robots-tag']).toBe(indexable?undefined:'noindex');
   const xml=await xmlResponse.text();expect(xml).not.toContain(fixture.draftSlug);
   const parsed=await page.evaluate(xml=>{const doc=new DOMParser().parseFromString(xml,'application/xml');return {errors:doc.querySelectorAll('parsererror').length,root:doc.documentElement.localName,locations:[...doc.querySelectorAll('loc')].map(n=>n.textContent),items:[...doc.querySelectorAll('item')].map(n=>({title:n.querySelector('title').textContent,link:n.querySelector('link').textContent,guid:n.querySelector('guid').textContent,description:n.querySelector('description').textContent,date:n.querySelector('pubDate').textContent,image:n.getElementsByTagNameNS('http://search.yahoo.com/mrss/','content')[0]?.getAttribute('url')}))};},xml);
   expect(parsed.errors).toBe(0);expect(parsed.root).toBe(root);
   if(root==='urlset'){locations.push(...parsed.locations);expect(parsed.locations).toContain(canonical);}
   else {expect(parsed.items.length).toBeLessThanOrEqual(30);const item=parsed.items.find(row=>row.guid===canonical);expect(item).toMatchObject({title:article.title,link:canonical,guid:canonical,description:article.excerpt,date:'Wed, 01 Jan 2020 00:00:00 GMT',image});}
  }
  for(const route of ['/','/latest/','/about/','/contact/','/advertise/','/category/'+article.category.slug+'/'])expect(locations).toContain(canonicalOrigin+route);
  const homeResponse=await request.get(origin+'/');expect(homeResponse.status()).toBe(200);expect(homeResponse.headers()['x-robots-tag']).toBe(indexable?'index,follow':'noindex,nofollow');
  const home=await page.evaluate(html=>{const doc=new DOMParser().parseFromString(html,'text/html');const meta=name=>doc.querySelector('meta[property="'+name+'"]')?.content;return {type:meta('og:type'),title:meta('og:title'),description:meta('og:description'),url:meta('og:url'),site:meta('og:site_name')};},await homeResponse.text());
  expect(home).toMatchObject({type:'website',title:'Church Times Nigeria — Faith in the world',url:canonicalOrigin+'/',site:'Church Times Nigeria'});expect(home.description.length).toBeGreaterThan(30);
  const robots=await (await request.get(origin+'/robots.txt')).text();expect(robots).toBe(indexable?'User-agent: *\nAllow: /\nSitemap: '+canonicalOrigin+'/sitemap.xml\n':'User-agent: *\nDisallow: /\n');
  expect(await page.locator('link[rel="alternate"][hreflang]').count()).toBe(0); // One English edition, no invented language duplicates.
  if(evidence && template==='/{slug}/' && !indexable) {
   const directory=resolve('docs/evidence/wave3-seo');await mkdir(directory,{recursive:true});await page.evaluate(()=>document.fonts.ready);
   await page.screenshot({path:resolve(directory,'archive-'+testInfo.project.name+'.png'),fullPage:true});
   await writeFile(resolve(directory,'archive-'+testInfo.project.name+'.json'),JSON.stringify({kind:'real anonymous Payload REST + disposable PostgreSQL; synthetic migrated-style article; no C7/import claim',device:testInfo.project.name,articleTemplate:template,indexable,originalPublicationDate:article.publishedAt,structuredDataType:schema['@type'],largeImageWidth:schema.image[0].width,validSitemapAndRss:true,canonicalMatchesAcrossHtmlSchemaAndFeed:true,categoryAndStaticPagesCovered:true,stagingNoindex:true},null,2)+'\n');
  }
 }finally {await context.close();await new Promise(resolve=>server.close(resolve));}
});
