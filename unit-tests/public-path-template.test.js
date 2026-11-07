// Synthetic C2 projection fixtures and anonymous API STUB. Not real CMS integration.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {reportPath,reportSlug,articleCanonical,articlePathTemplate,isReservedRootSlug} from '../src/lib/public-routes.js';
import {normalizePublishedArticle} from '../src/lib/published-articles.js';
import {socialMetadata} from '../src/lib/public-metadata.js';
import {createPublicServer} from '../tools/serve-public.mjs';
const raw={id:1,status:'published',slug:'synthetic-report',title:'Editorial title',excerpt:'Editorial excerpt',seoTitle:'Search <title> & "story"',seoDescription:'Search <description> & details',publishedAt:'2026-10-16T00:00:00Z',corrections:[],content:'Synthetic body'};
test('both article templates share parsing and canonical generation; default remains reports',()=>{
 assert.equal(reportPath('synthetic-report'),'/reports/synthetic-report/');
 for(const template of ['/{slug}/','/reports/{slug}/']) {
  const path=reportPath(raw.slug,'/journal/',template);
  assert.equal(path,'/journal'+template.replace('{slug}',raw.slug));
  assert.equal(reportSlug(path,'/journal/',template),raw.slug);
  assert.equal(articleCanonical(raw.slug,{basePath:'/journal/',siteUrl:'https://public.example.test',articlePathTemplate:template}),'https://public.example.test'+path);
  for(const bad of ['../admin','%2fadmin','a/b','a?b'])assert.equal(reportPath(bad,'/',template),'');
 }
 assert.throws(()=>articlePathTemplate('/arbitrary/{slug}/'));
 assert.equal(articlePathTemplate(''),'\/reports/{slug}/');assert.equal(articlePathTemplate('  '),'\/reports/{slug}/');
 assert.equal(reportSlug('/about/','/','/{slug}/'),null);
 assert.equal(reportSlug('/reports/private/','/','/{slug}/'),null);
});
test('C2 fixture preserves optional SEO fields with fixed fallback and no canonical override',()=>{
 const article=normalizePublishedArticle({...raw,canonicalOverride:'https://evil.example.test/' });
 assert.equal(article.seoTitle,raw.seoTitle);assert.equal(article.seoDescription,raw.seoDescription);
 assert.equal(article.canonicalOverride,undefined);
 assert.equal(socialMetadata(article,'')['og:description'],raw.seoDescription);
 const absent=normalizePublishedArticle({...raw,seoTitle:null,seoDescription:undefined});
 assert.equal(socialMetadata(absent,'')['og:title'],raw.title);assert.equal(socialMetadata(absent,'')['og:description'],raw.excerpt);
 assert.equal(normalizePublishedArticle({...raw,seoTitle:'a'.repeat(90)}).seoTitle.length,70);
});
for(const template of ['/{slug}/','/reports/{slug}/'])test('anonymous API STUB: template '+template+' applies to HTML, latest, sitemap and RSS',async t=>{
 const dist=await mkdtemp(join(tmpdir(),'public-template-'));
 await writeFile(join(dist,'index.html'),await readFile(new URL('../src/index.template.html',import.meta.url),'utf8'));
 const server=createPublicServer({dist,cmsUrl:'https://cms.example.test',siteUrl:'https://public.example.test',basePath:'/journal/',articlePathTemplate:template,fetchImpl:async(url,options)=>{
  assert.equal(options.credentials,'omit');
  return Response.json({docs:new URL(url).pathname==='/api/categories'?[]:[raw],totalPages:1});
 }});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dist,{recursive:true,force:true});});
 const origin='http://127.0.0.1:'+server.address().port;
 const path=reportPath(raw.slug,'/journal/',template),canonical='https://public.example.test'+path;
 const response=await fetch(origin+path);assert.equal(response.status,200);const html=await response.text();
 assert.ok(html.includes('rel="canonical" href="'+canonical+'"'));
 assert.ok(html.includes('<meta name="public-article-path-template" content="'+template+'">'));
 assert.match(html,/<title>Search &lt;title&gt; &amp; &quot;story&quot; — Church Times Nigeria<\/title>/);
 assert.match(html,/<h1>Editorial title<\/h1>/);assert.match(html,/content="Search &lt;description&gt; &amp; details"/);
 assert.equal((await fetch(origin+path.slice(0,-1),{redirect:'manual'})).headers.get('location'),path);
 for(const endpoint of ['sitemap.xml','feed.xml','latest/']) {
  const body=await (await fetch(origin+'/journal/'+endpoint)).text();
  assert.ok(body.includes(endpoint==='latest/'?path:canonical),endpoint);
  if(endpoint==='feed.xml'){assert.match(body,/<description>Editorial excerpt<\/description>/);assert.doesNotMatch(body,/Search &lt;description/);}
 }
});


test('synthetic root-template feed skips reserved slugs without breaking discovery',async t=>{
 const warnings=[];t.mock.method(console,'warn',record=>warnings.push(record));
 const dist=await mkdtemp(join(tmpdir(),'public-template-reserved-'));await writeFile(join(dist,'index.html'),await readFile(new URL('../src/index.template.html',import.meta.url),'utf8'));
 const server=createPublicServer({dist,cmsUrl:'https://cms.example.test',siteUrl:'https://public.example.test',articlePathTemplate:'/{slug}/',fetchImpl:async url=>Response.json({docs:new URL(url).pathname==='/api/categories'?[]:[{...raw,slug:'about'},raw],totalPages:1})});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dist,{recursive:true,force:true});});
 for(const route of ['sitemap.xml','feed.xml']){const response=await fetch('http://127.0.0.1:'+server.address().port+'/'+route);assert.equal(response.status,200);const body=await response.text();assert.match(body,/synthetic-report/);if(route==='feed.xml')assert.equal((body.match(/<item>/g)||[]).length,1);}
 assert.ok(warnings.length>=2);assert.match(warnings[0],/public_discovery_reserved_slug_skipped/);assert.doesNotMatch(JSON.stringify(warnings),/example.test|synthetic-report|\"about\"/);
});

test('the public host defaults to /{slug}/ (owner decision D1) and keeps the environment override',async t=>{
 const dist=await mkdtemp(join(tmpdir(),'public-template-default-'));await writeFile(join(dist,'index.html'),await readFile(new URL('../src/index.template.html',import.meta.url),'utf8'));
 t.after(()=>rm(dist,{recursive:true,force:true}));
 const fetchImpl=async url=>Response.json({docs:new URL(url).pathname==='/api/categories'?[]:[raw],totalPages:1});
 const previous=process.env.PUBLIC_ARTICLE_PATH_TEMPLATE;
 t.after(()=>{if(previous===undefined)delete process.env.PUBLIC_ARTICLE_PATH_TEMPLATE;else process.env.PUBLIC_ARTICLE_PATH_TEMPLATE=previous;});
 for(const [env,expected] of [[undefined,'/{slug}/'],['','/{slug}/'],['/{slug}/','/{slug}/'],['/reports/{slug}/','/reports/{slug}/']]) {
  if(env===undefined)delete process.env.PUBLIC_ARTICLE_PATH_TEMPLATE;else process.env.PUBLIC_ARTICLE_PATH_TEMPLATE=env;
  const server=createPublicServer({dist,cmsUrl:'https://cms.example.test',siteUrl:'https://public.example.test',fetchImpl});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
   const response=await fetch('http://127.0.0.1:'+server.address().port+expected.replace('{slug}',raw.slug));assert.equal(response.status,200);
   assert.ok((await response.text()).includes('<meta name="public-article-path-template" content="'+expected+'">'));
  } finally {await new Promise(resolve=>server.close(resolve));}
 }
 assert.throws(()=>createPublicServer({dist,articlePathTemplate:'/news/{slug}/'}));
});
test('root-template reserved slugs mirror the CMS list and never become article paths',()=>{
 for(const slug of ['admin','api','newsletter','search','wp-admin','about','latest','page','live','feed'])assert.equal(reportPath(slug,'/','/{slug}/'),'',slug);
 assert.equal(isReservedRootSlug('ADMIN'),true);assert.equal(reportPath('admin','/','/reports/{slug}/'),'/reports/admin/');
 assert.equal(reportPath('a-real-story','/','/{slug}/'),'/a-real-story/');
});
