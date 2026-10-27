import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {normalizePublicMedia,normalizePublishedArticle} from '../src/lib/published-articles.js';
import {cmsImage,cmsFigure,cmsPreload,cmsSources} from '../src/lib/cms-media.js';
import {renderArticleContent} from '../src/lib/article-content.js';
import {socialMetadata} from '../src/lib/public-metadata.js';
import {articleSchema} from '../src/lib/public-routes.js';
import {xml} from '../tools/public-feeds.mjs';
import {createPublicServer} from '../tools/serve-public.mjs';
const origin='https://cms.example.test';
const rawMedia={url:'/api/media/file/original.jpg',mimeType:'image/jpeg',filesize:12345,width:2000,height:1200,alt:'People & "faith"',caption:'<script>Caption</script>',credit:'A & B',sizes:{
 thumbnail:{url:'/api/media/file/thumb.jpg',width:320,height:192},card:{url:'/api/media/file/card.jpg',width:640,height:384},feature:{url:'/api/media/file/feature.jpg',width:1200,height:720},
 unsafe:{url:'https://evil.test/api/media/file/evil.jpg',width:800,height:480},private:{url:'/admin/secret',width:900,height:540},badDimensions:{url:'/api/media/file/bad.jpg',width:-1,height:500},
}};
const rawArticle={id:1,slug:'faith-and-life',title:'Faith & "life" <today>',excerpt:'A <report> & excerpt\u0001',status:'published',publishedAt:'2026-10-13T08:00:00Z',updatedAt:'2026-10-14T09:00:00Z',category:{id:2,slug:'faith',title:'Faith & Life'},featuredImage:rawMedia,content:'Published body',corrections:[]};
test('responsive media accepts every safe size, preserves actual dimensions and escapes captions',()=>{
 const media=normalizePublicMedia(rawMedia,origin);
 assert.deepEqual(media.variants.map(v=>v.width),[320,640,1200,2000]);
 assert.equal(media.heroUrl,origin+'/api/media/file/feature.jpg');
 for(const html of [cmsImage(media,{card:true}),cmsFigure(media,{eager:true}),renderArticleContent({root:{type:'root',children:[{type:'upload',relationTo:'media',value:rawMedia}]}},{baseUrl:origin})]) {
  assert.match(html,/thumb.jpg 320w/);assert.match(html,/feature.jpg 1200w/);assert.doesNotMatch(html,/evil.test|admin|bad.jpg|<script>/);
  assert.match(html,/sizes="\(max-width: 760px\)/);assert.match(html,/width="(?:640|1200)" height="(?:384|720)"/);
 }
 assert.match(cmsFigure(media),/<figcaption>&lt;script&gt;Caption&lt;\/script&gt; · Credit: A &amp; B<\/figcaption>/);
 assert.match(cmsPreload(media),/imagesrcset="/);assert.match(cmsImage(media,{eager:true}),/fetchpriority="high"/);
});
test('unsafe variants never inherit original dimensions or bypass checks during rendering',()=>{
 const media=normalizePublicMedia({...rawMedia,sizes:{card:{url:'https://evil.test/api/media/file/evil.jpg',width:600,height:300}}},origin);
 assert.equal(media.cardUrl,origin+'/api/media/file/original.jpg');assert.equal(media.cardWidth,2000);
 const html=cmsImage({...media,variants:[{url:'https://evil.test/api/media/file/evil.jpg',width:800,height:400},{url:'javascript:alert(1)',width:900,height:500}]});
 assert.doesNotMatch(html,/evil|javascript/);
 assert.equal(cmsImage({url:'javascript:alert(1)'}),'');assert.equal(cmsFigure({url:'https://cms.example.test/admin/private'}),'');
 const missing=normalizePublicMedia({...rawMedia,width:null,height:null,sizes:{}},origin);
 assert.doesNotMatch(cmsImage(missing),/width=|height=|srcset=/);assert.match(cmsImage(missing),/original.jpg/);
});
test('social cards and JSON-LD select the same large safe image',()=>{
 const article=normalizePublishedArticle(rawArticle,{baseUrl:origin});const canonical='https://public.example.test/reports/faith-and-life/';
 const social=socialMetadata(article,canonical),schema=articleSchema(article,canonical);
 assert.equal(social['og:image'],origin+'/api/media/file/feature.jpg');assert.equal(social['og:image:width'],'1200');assert.equal(social['og:image:height'],'720');
 assert.equal(schema.image[0].url,social['og:image']);assert.equal(schema.articleSection,social['article:section']);assert.equal(schema.datePublished,social['article:published_time']);assert.equal(schema.url,social['og:url']);assert.equal(social['twitter:card'],'summary_large_image');
 assert.equal(socialMetadata(null,canonical)['og:type'],'website');
 assert.equal(xml('a\u0000\u0001\ud800 & < > " \''),'a &amp; &lt; &gt; &quot; &apos;');
});
async function fixture(t,{indexable=false,totalPages=1,fail=false,basePath='/',articleCount=1}={}) {
 const dist=await mkdtemp(join(tmpdir(),'public-seo-test-'));
 await writeFile(join(dist,'index.html'),await readFile(new URL('../src/index.template.html',import.meta.url),'utf8'));
 const calls=[];
 const server=createPublicServer({dist,basePath,cmsUrl:origin,siteUrl:'https://public.example.test',indexable,fetchImpl:async(url,options)=>{
  const u=new URL(url);calls.push(u);assert.equal(options.credentials,'omit');assert.equal(options.headers.Authorization,undefined);assert.equal(options.headers.Cookie,undefined);
  if(fail)return new Response('private failure',{status:500});
  if(u.pathname==='/api/categories')return Response.json({docs:[{id:2,slug:'faith',title:'Faith & Life'}],totalPages:1});
  assert.equal(u.searchParams.get('where[status][equals]'),'published');
  return Response.json({docs:[...Array.from({length:articleCount},(_,i)=>({...rawArticle,slug:i?'published-'+i:rawArticle.slug})),{...rawArticle,slug:'private-draft',status:'draft'}],hasNextPage:totalPages>Number(u.searchParams.get('page')),nextPage:Number(u.searchParams.get('page'))+1,totalPages});
 }});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dist,{recursive:true,force:true});});
 return {get:(path,options)=>fetch('http://127.0.0.1:'+server.address().port+basePath+path,options),calls};
}
test('staging discovery works but blocks crawling, escapes XML and excludes drafts',async t=>{
 const {get,calls}=await fixture(t);
 const robots=await (await get('robots.txt')).text();assert.equal(robots,'User-agent: *\nDisallow: /\n');
 const feed=await get('feed.xml');assert.equal(feed.headers.get('x-robots-tag'),'noindex');assert.match(feed.headers.get('cache-control'),/max-age=60/);
 const rss=await feed.text();assert.match(rss,/<rss version="2.0"/);assert.match(rss,/Faith &amp; &quot;life&quot; &lt;today&gt;/);assert.match(rss,/<description>A &lt;report&gt; &amp; excerpt<\/description>/);assert.doesNotMatch(rss,/private-draft|\u0001/);assert.match(rss,/<enclosure[^>]*length="12345"/);assert.match(rss,/<media:content[^>]*feature.jpg/);
 assert.equal(calls[0].searchParams.get('limit'),'30');
 const sitemap=await get('sitemap.xml');assert.equal(sitemap.status,200);assert.equal(sitemap.headers.get('x-robots-tag'),'noindex');const map=await sitemap.text();
 assert.match(map,/reports\/faith-and-life\//);assert.match(map,/<lastmod>2026-10-14T09:00:00.000Z<\/lastmod>/);assert.match(map,/category\/faith\//);assert.match(map,/about\//);assert.doesNotMatch(map,/private-draft/);
 const count=calls.length;await get('sitemap.xml');assert.equal(calls.length,count);
});
test('indexable discovery uses canonical subpaths, sitemap index and bounded pages',async t=>{
 const {get}=await fixture(t,{indexable:true,totalPages:3,basePath:'/journal/'});
 const robots=await (await get('robots.txt')).text();assert.match(robots,/Allow: \/\nSitemap: https:\/\/public.example.test\/journal\/sitemap.xml/);
 const response=await get('sitemap.xml');assert.equal(response.headers.get('x-robots-tag'),null);const index=await response.text();assert.match(index,/<sitemapindex/);assert.equal((index.match(/<sitemap>/g)||[]).length,3);assert.match(index,/journal\/sitemap-3.xml/);
 const first=await (await get('sitemap-1.xml')).text();assert.match(first,/journal\/category\/faith\//);assert.match(first,/journal\/reports\/faith-and-life\//);
 const second=await (await get('sitemap-2.xml')).text();assert.doesNotMatch(second,/category\/|about\//);
 assert.equal((await get('sitemap-4.xml')).status,404);assert.equal((await get('sitemap-9999.xml')).status,404);
});
test('discovery fails explicitly rather than publishing partial sitemaps or caching failures',async t=>{
 const {get,calls}=await fixture(t,{fail:true});assert.equal((await get('feed.xml')).status,503);assert.equal((await get('feed.xml')).status,503);assert.equal(calls.length,2);
 const oversized=await fixture(t,{totalPages:1001});assert.equal((await oversized.get('sitemap.xml')).status,503);
});
test('SSR article metadata escapes values, supplies preload, and clean category/static paths resolve',async t=>{
 const {get}=await fixture(t,{indexable:true});
 const response=await get('reports/faith-and-life/');const html=await response.text();assert.equal(response.status,200);
 assert.match(html,/property="og:title" content="Faith &amp; &quot;life&quot; &lt;today&gt;"/);assert.match(html,/property="og:image:width" content="1200"/);assert.match(html,/property="article:section" content="Faith &amp; Life"/);assert.match(html,/name="twitter:card" content="summary_large_image"/);assert.match(html,/imagesrcset="/);assert.match(html,/id="public-article" type="application\/json"/);assert.equal((html.match(/property="og:title"/g)||[]).length,1);
 const home=await get('');assert.equal(home.headers.get('x-robots-tag'),'index,follow');assert.match(await home.text(),/property="og:url" content="https:\/\/public.example.test\/"/);
 for(const path of ['latest/','category/faith/','about/','contact/','advertise/'])assert.equal((await get(path)).status,200,path);
});

test('RSS output remains bounded even if a CMS ignores the requested limit',async t=>{
 const {get}=await fixture(t,{articleCount:150});
 const rss=await (await get('feed.xml')).text();assert.equal((rss.match(/<item>/g)||[]).length,30);
 assert.equal((await get('sitemap.xml')).status,503);
});
test('public text compression negotiates gzip and preserves HEAD semantics',async t=>{
 const {get}=await fixture(t);
 const path='reports/faith-and-life/';
 const plain=await get(path,{headers:{'Accept-Encoding':'identity'}});const text=await plain.text();assert.equal(plain.headers.get('content-encoding'),null);
 const compressed=await get(path,{headers:{'Accept-Encoding':'gzip;q=0.5'}});assert.equal(compressed.headers.get('content-encoding'),'gzip');assert.equal(await compressed.text(),text);
 const head=await get(path,{method:'HEAD',headers:{'Accept-Encoding':'gzip'}});assert.equal(await head.text(),'');assert.equal(head.headers.get('content-length'),compressed.headers.get('content-length'));
 const refused=await get(path,{headers:{'Accept-Encoding':'gzip;q=0'}});assert.equal(refused.headers.get('content-encoding'),null);
});

test('responsive candidates keep one aspect ratio when Payload crops differ from the original',()=>{
 const media=normalizePublicMedia({...rawMedia,width:2000,height:2000,sizes:{
  thumbnail:{url:'/api/media/file/thumb.jpg',width:320,height:240},
  card:{url:'/api/media/file/card.jpg',width:640,height:480},
  feature:{url:'/api/media/file/feature.jpg',width:1200,height:900},
 }},origin);
 const source=cmsSources(media);assert.equal(source.width,1200);assert.equal(source.height,900);
 assert.deepEqual(source.variants.map(v=>v.width),[320,640,1200]);
 assert.doesNotMatch(cmsImage(media),/original.jpg/);
 const originalOnly=normalizePublicMedia({...rawMedia,sizes:{}},origin);
 assert.equal(cmsSources(originalOnly).url,origin+'/api/media/file/original.jpg');
});
