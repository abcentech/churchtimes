import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {classify,articleSlug,storable,evictions,staleCaches,pageTitle,pageKey,MAX_PAGES,PAGES_CACHE,ASSETS_CACHE} from '../src/features/pwa/sw-core.js';
import {liteHTML,liteRequest,litePlaceholder} from '../src/features/pwa/lite.js';
import {pwaManifest,entryAssets,serviceWorkerSource,createPwaRoutes,PWA_STATICS,OFFLINE_HTML} from '../tools/public-routes/pwa.mjs';
import {RESERVED_ROOT_SLUGS} from '../src/lib/public-routes.js';

const origin='https://news.example.test';
const config={origin,base:'/',template:'/{slug}/',reserved:[...RESERVED_ROOT_SLUGS],statics:PWA_STATICS};
const req=(path,{method='GET',mode='cors',headers={}}={})=>({url:new URL(path,origin).href,method,mode,headers:new Headers(headers)});

test('worker policy: only same-origin public GETs; staff, API, giving, newsletter and push paths are never touched',()=>{
  assert.equal(classify(req('/a-story/',{mode:'navigate'}),config),'article');
  assert.equal(classify(req('/',{mode:'navigate'}),config),'home');
  assert.equal(classify(req('/latest/',{mode:'navigate'}),config),'page');
  assert.equal(classify(req('/site/assets/index-abc.js'),config),'asset');
  assert.equal(classify(req('/manifest.webmanifest'),config),'static');
  for(const path of ['/admin/','/admin/collections/articles','/api/public/articles','/api/users/me','/newsletter/confirm/','/give/','/giving/status','/donate/','/push/onesignal/','/OneSignalSDKWorker.js','/sw.js','/feed.xml','/sitemap.xml','/newsroom/'])
    for(const mode of ['navigate','cors'])assert.equal(classify(req(path,{mode}),config),'skip',path+' '+mode);
  assert.equal(classify(req('/a-story/',{mode:'navigate',method:'POST'}),config),'skip');
  assert.equal(classify(req('/api/public/giving/init',{method:'POST'}),config),'skip');
  assert.equal(classify({...req('/a-story/',{mode:'navigate'}),url:'https://cms.example.test/a-story/'},config),'skip');
  assert.equal(classify(req('/site/assets/a.mp3',{headers:{range:'bytes=0-'}}),config),'skip');
  assert.equal(classify(req('/news-media/1.jpg'),config),'skip');
  // Base path and the /reports/{slug}/ template.
  const reports={...config,base:'/beta/',template:'/reports/{slug}/'};
  assert.equal(classify(req('/beta/reports/a-story/',{mode:'navigate'}),reports),'article');
  assert.equal(classify(req('/a-story/',{mode:'navigate'}),reports),'skip');
  assert.equal(articleSlug('latest/',config),null);
  assert.equal(articleSlug('Bad_Slug/',config),null);
  assert.equal(articleSlug('a/b/',config),null);
});
test('worker storage: only plain 200 same-origin HTML; private responses refused; oldest pages evicted first',()=>{
  const html=(init={})=>Object.assign(new Response('<title>x</title>',{status:200,headers:{'content-type':'text/html; charset=utf-8',...init.headers}}),{});
  const basic=response=>Object.defineProperty(response,'type',{value:'basic'});
  assert.equal(storable(basic(html()),'article'),true);
  assert.equal(storable(basic(html({headers:{'cache-control':'private, no-store'}})),'article'),false);
  assert.equal(storable(basic(new Response('{}',{headers:{'content-type':'application/json'}})),'article'),false);
  assert.equal(storable(basic(new Response('x',{status:404,headers:{'content-type':'text/html'}})),'article'),false);
  assert.equal(storable(Object.defineProperty(html(),'type',{value:'opaque'}),'asset'),false);
  const entries=Array.from({length:MAX_PAGES+3},(_,i)=>({key:'k'+i,at:1000+i}));
  assert.deepEqual(evictions(entries.reverse(),MAX_PAGES),['k0','k1','k2']);
  assert.deepEqual(evictions(entries.slice(0,5),MAX_PAGES),[]);
  assert.deepEqual(staleCaches(['ct-shell-old','ct-shell-new',PAGES_CACHE,ASSETS_CACHE,'ct-pages-v0','other-app'],'new'),['ct-shell-old','ct-pages-v0']);
  assert.equal(pageTitle('<title>Bishops &amp; the vote — Church Times Nigeria</title>'),'Bishops & the vote');
  assert.equal(pageKey('https://a.test/x/?utm_source=wa#top'),'https://a.test/x/');
});
test('data saver: Save-Data or the reader cookie defers every image without changing its box',()=>{
  assert.equal(liteRequest({'save-data':'on'}),true);
  assert.equal(liteRequest({'save-data':'on',cookie:'a=1; ct-lite=off'}),false);
  assert.equal(liteRequest({cookie:'ct-lite=on'}),true);
  assert.equal(liteRequest({}),false);
  const markup='<link data-public-metadata rel="preload" as="image" href="https://cms/x.webp"><picture><source type="image/avif" srcset="https://cms/x.avif 800w" sizes="100vw"><img class="cms-image" src="https://cms/x.webp" srcset="https://cms/x.webp 800w" sizes="100vw" width="800" height="450" alt="A choir" loading="eager" fetchpriority="high" decoding="async"></picture>';
  const lite=liteHTML(markup);
  assert.doesNotMatch(lite,/rel="preload"/);
  assert.doesNotMatch(lite,/\ssrcset=|fetchpriority/);
  assert.match(lite,/data-lite-src="https:\/\/cms\/x\.webp"/);
  assert.match(lite,/<source type="image\/avif" data-lite-srcset="https:\/\/cms\/x\.avif 800w"/);
  assert.ok(lite.includes(`src="${litePlaceholder(800,450)}"`));
  assert.match(lite,/width="800" height="450" alt="A choir"/);
  assert.equal(liteHTML(lite),lite,'idempotent');
  assert.equal(liteHTML('<img src="data:image/gif;base64,R0" alt="">'),'<img src="data:image/gif;base64,R0" alt="">');
});
test('manifest and worker source: scoped to the base path, versioned by build, valid script',async()=>{
  const manifest=pwaManifest('/beta/');
  assert.equal(manifest.start_url,'/beta/');assert.equal(manifest.scope,'/beta/');assert.equal(manifest.display,'standalone');
  assert.ok(manifest.icons.some(icon=>icon.purpose==='maskable'&&icon.sizes==='512x512'));
  const html='<script type="module" crossorigin src="./site/assets/index-a.js"></script><link rel="stylesheet" crossorigin href="./site/assets/index-b.css"><link rel="preload" as="font" href="./site/assets/f.woff2"><link rel="icon" href="./site/favicon.svg">';
  assert.deepEqual(new Set(entryAssets(html,'/beta/')),new Set(['/beta/site/assets/index-a.js','/beta/site/assets/f.woff2','/beta/site/assets/index-b.css']));
  const one=await serviceWorkerSource({html,basePath:'/beta/'}),two=await serviceWorkerSource({html:html.replace('index-a','index-c'),basePath:'/beta/'});
  const version=source=>/const CT_PWA=(\{.*\});/.exec(source)[1];
  assert.notEqual(JSON.parse(version(one)).version,JSON.parse(version(two)).version);
  assert.doesNotMatch(one,/^export /m);
  assert.doesNotThrow(()=>new vm.Script(one));
  assert.match(OFFLINE_HTML,/<main id="main">/);
});

// A minimal in-memory Cache Storage, enough to run the real generated worker under node.
function cacheStorage() {
  const stores=new Map(),key=input=>new URL(typeof input==='string'?input:input.url,origin).href;
  const open=async name=>{
    if(!stores.has(name)){const map=new Map();stores.set(name,{
      match:async input=>map.get(key(input))?.clone(),
      put:async(input,response)=>{map.delete(key(input));map.set(key(input),response.clone());},
      delete:async input=>map.delete(key(typeof input==='string'?input:input.url)),
      keys:async()=>[...map.keys()].map(url=>new Request(url)),
      add:async input=>{const response=await globalThis.__fetch(typeof input==='string'?new URL(input,origin).href:input.url);if(!response.ok)throw new TypeError('add failed');map.set(key(input),response);},
      map,
    });}
    return stores.get(name);
  };
  return {stores,open,keys:async()=>[...stores.keys()],delete:async name=>stores.delete(name),match:async input=>{for(const store of stores.values()){const hit=await store.match(input);if(hit)return hit;}}};
}
async function bootWorker({network}) {
  const html='<script type="module" crossorigin src="./site/assets/index-a.js"></script><link rel="stylesheet" crossorigin href="./site/assets/index-b.css">';
  const source=await serviceWorkerSource({html,basePath:'/'});
  const listeners={},caches=cacheStorage();
  const basic=response=>{Object.defineProperty(response,'type',{value:'basic'});return response;};
  globalThis.__fetch=async url=>{const result=await network(new URL(typeof url==='string'?url:url.url,origin));if(result instanceof Error)throw result;return basic(result);};
  const self={location:new URL(origin+'/sw.js'),addEventListener:(type,fn)=>{listeners[type]=fn;},skipWaiting:async()=>{},clients:{claim:async()=>{}},registration:{}};
  vm.runInNewContext(source,{self,caches,fetch:globalThis.__fetch,Response,Request,Headers,URL,Date,JSON,Number,String,Promise,encodeURIComponent,decodeURIComponent,Set,Map,Array,Object,console});
  const extend=async(type,props={})=>{const waits=[];let response;await listeners[type]({...props,waitUntil:p=>waits.push(p),respondWith:p=>{response=p;}});await Promise.all(waits);const result=await response;await Promise.all(waits);return result;};
  const fetchEvent=async(path,{mode='navigate',method='GET'}={})=>{
    const request={url:new URL(path,origin).href,method,mode,headers:new Headers()};
    const waits=[];let response;
    listeners.fetch({request,preloadResponse:Promise.resolve(undefined),waitUntil:p=>waits.push(p),respondWith:p=>{response=p;}});
    const result=await response;await Promise.all(waits);return result;
  };
  await extend('install');await extend('activate');
  return {caches,fetchEvent};
}
const page=(title,headers={})=>new Response(`<!doctype html><title>${title} — Church Times Nigeria</title><p>${title}</p>`,{status:200,headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store',...headers}});
test('generated worker: keeps the last 25 read articles, serves them offline, and falls back to the offline page',async()=>{
  let online=true;
  const network=async url=>{
    if(!online)return new TypeError('offline');
    if(url.pathname==='/offline.html')return page('Offline');
    if(url.pathname.startsWith('/site/'))return new Response('asset',{headers:{'content-type':'text/javascript'}});
    if(url.pathname==='/manifest.webmanifest')return new Response('{}',{headers:{'content-type':'application/manifest+json'}});
    if(url.pathname==='/private-story/')return page('Private',{'cache-control':'private'});
    return page(url.pathname.slice(1,-1)||'Home');
  };
  const {caches,fetchEvent}=await bootWorker({network});
  assert.ok((await caches.keys()).some(name=>name.startsWith('ct-shell-')));
  assert.ok(await (await caches.open(ASSETS_CACHE)).match(origin+'/site/assets/index-a.js'),'entry JS precached');
  for(let i=0;i<MAX_PAGES+2;i++){await fetchEvent(`/story-${i}/`);await new Promise(resolve=>setTimeout(resolve,2));}
  await fetchEvent('/private-story/');
  await fetchEvent('/');
  await fetchEvent('/admin/');await fetchEvent('/api/public/articles',{mode:'cors'});await fetchEvent('/give/');
  const pages=await caches.open(PAGES_CACHE),urls=(await pages.keys()).map(request=>new URL(request.url).pathname);
  assert.equal(urls.length,MAX_PAGES);
  assert.ok(!urls.includes('/story-0/')&&!urls.includes('/story-1/')&&urls.includes(`/story-${MAX_PAGES+1}/`),'oldest two evicted');
  assert.ok(!urls.includes('/private-story/')&&!urls.some(url=>/admin|api|give/.test(url)));
  assert.equal(decodeURIComponent((await pages.match(origin+'/story-5/')).headers.get('x-ct-title')),'story-5');
  online=false;
  assert.match(await (await fetchEvent('/story-5/')).text(),/<p>story-5<\/p>/,'read article offline');
  assert.match(await (await fetchEvent('/')).text(),/<p>Home<\/p>/,'home shell offline');
  assert.match(await (await fetchEvent('/story-0/')).text(),/Offline/,'evicted article: offline page');
  assert.match(await (await fetchEvent('/latest/')).text(),/Offline/,'uncached page: offline page');
  assert.equal(await fetchEvent('/give/'),undefined,'giving left to the browser');
});
test('generated worker: a newsroom outage serves the saved copy instead of the error',async()=>{
  let down=false;
  const {fetchEvent}=await bootWorker({network:async url=>url.pathname==='/offline.html'?page('Offline'):down?new Response('unavailable',{status:503,headers:{'content-type':'text/html'}}):page('Saved story')});
  await fetchEvent('/saved-story/');down=true;
  assert.match(await (await fetchEvent('/saved-story/')).text(),/Saved story/);
  assert.equal((await fetchEvent('/never-read/')).status,503);
});
test('host routes: manifest, worker and offline page with explicit cache headers',async()=>{
  const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const dist=await mkdtemp(join(tmpdir(),'ct-pwa-'));await writeFile(join(dist,'index.html'),'<script type="module" src="./site/assets/i.js"></script>');
  try {
    const route=createPwaRoutes({dist,basePath:'/',articlePathTemplate:'/{slug}/'}),calls=[];
    const respond=(...args)=>calls.push(args);
    const run=async(path,headers={})=>{calls.length=0;delete respond.transform;const handled=await route({headers},new URL(path,origin),respond);return {handled,call:calls[0]};};
    let {handled,call}=await run('/sw.js');
    assert.equal(handled,true);assert.equal(call[3]['Cache-Control'],'no-cache');assert.match(call[1],/javascript/);assert.match(call[2],/const CT_PWA=/);
    ({call}=await run('/manifest.webmanifest'));assert.equal(call[1],'application/manifest+json');assert.equal(JSON.parse(call[2]).scope,'/');
    ({call}=await run('/offline.html'));assert.equal(call[3]['X-Robots-Tag'],'noindex');
    ({handled}=await run('/a-story/'));assert.equal(handled,false);
    await run('/a-story/',{'save-data':'on'});assert.equal(typeof respond.transform,'function');
  } finally {await rm(dist,{recursive:true,force:true});}
});
