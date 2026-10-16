// C7/C2 and legacy-ID responses below are SYNTHETIC API STUBS, not end-to-end CMS proof.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createPublicServer} from '../tools/serve-public.mjs';
import {fetchPublishedLegacyArticle} from '../src/lib/published-articles.js';
test('published legacy-ID lookup uses existing anonymous API filters and verifies returned ID/status',async()=>{
 let count=0;
 const options={baseUrl:'https://cms.example.test',legacyId:'123',fetchImpl:async(url,options)=>{
  count++;assert.equal(options.credentials,'omit');const u=new URL(url);assert.equal(u.pathname,'/api/articles');assert.equal(u.searchParams.get('where[status][equals]'),'published');assert.equal(u.searchParams.get('where[legacyId][equals]'),'123');
  return Response.json({docs:[{id:1,status:'published',legacyId:123,slug:'synthetic-report',title:'Synthetic'}]});
 }};
 assert.equal((await fetchPublishedLegacyArticle(options)).slug,'synthetic-report');
 assert.equal(await fetchPublishedLegacyArticle({...options,legacyId:'../private'}),null);assert.equal(count,1);
 for(const record of [{status:'draft',legacyId:123},{status:'published',legacyId:124}])assert.equal(await fetchPublishedLegacyArticle({...options,fetchImpl:async()=>Response.json({docs:[{id:1,slug:'synthetic-report',title:'Synthetic',...record}]})}),null);
});
test('public host rejects junk before any CMS/redirect-map IO; opt-in legacy-ID redirects one hop',async t=>{
 const dist=await mkdtemp(join(tmpdir(),'public-junk-'));await writeFile(join(dist,'index.html'),await readFile(new URL('../src/index.template.html',import.meta.url),'utf8'));
 let calls=0;
 const server=createPublicServer({dist,cmsUrl:'https://cms.example.test',siteUrl:'https://public.example.test',redirectPatterns:{legacyId:'/reports/{slug}/'},redirectsUrl:'https://cms.example.test/api/public/redirects',fetchImpl:async url=>{
  calls++;const u=new URL(url);
  return Response.json(u.pathname==='/api/public/redirects'?{version:'sha256:synthetic',generatedAt:'2026-10-16T00:00:00Z',count:0,rules:[]}:{docs:[{status:'published',title:'Synthetic',slug:'synthetic-report',legacyId:123}]});
 }});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dist,{recursive:true,force:true});});
 const origin='http://127.0.0.1:'+server.address().port;
 for(const path of ['/tel:123','/%74el:123','/%ZZ','/reports/a%2fb/','/'+ 'x'.repeat(2050)])assert.equal((await fetch(origin+path,{redirect:'manual'})).status,404);
 for(const path of ['/newsletter/confirm?token=synthetic-private','/newsletter/unsubscribe/?token=synthetic-private']) {
  const page=await fetch(origin+path);assert.equal(page.status,200);assert.equal(page.headers.get('referrer-policy'),'no-referrer');assert.equal(page.headers.get('cache-control'),'no-store');assert.equal(page.headers.get('x-robots-tag'),'noindex,nofollow');const html=await page.text();assert.doesNotMatch(html,/synthetic-private|rel="canonical"/);assert.match(html,/Newsletter preferences/);
 }
 assert.equal(calls,0);
 const result=await fetch(origin+'/?p=123',{redirect:'manual'});assert.equal(result.status,301);assert.equal(result.headers.get('location'),'/reports/synthetic-report/');assert.equal(calls,2);
 const final=await fetch(origin+result.headers.get('location'),{redirect:'manual'});assert.equal(final.status,200);
});
