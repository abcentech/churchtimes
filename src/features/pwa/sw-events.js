/* Service-worker event wiring. The public host serves this after `const CT_PWA={...}` and sw-core.js.
   Classic script on purpose: module workers are not yet universal. */
const SHELL_CACHE=SHELL_PREFIX+CT_PWA.version;
const config={...CT_PWA,origin:self.location.origin};
const absolute=path=>new URL(path,self.location.origin).href;
async function stamp(response,title='') {
  const body=await response.blob();
  if(body.size>MAX_PAGE_BYTES)return null;
  const headers=new Headers(response.headers);
  headers.set('x-ct-at',String(Date.now()));
  if(title)headers.set('x-ct-title',encodeURIComponent(title));
  return new Response(body,{status:response.status,statusText:response.statusText,headers});
}
async function trim(name,max) {
  const cache=await caches.open(name),keys=await cache.keys();
  if(keys.length<=max)return;
  const entries=await Promise.all(keys.map(async key=>({key,at:Number((await cache.match(key))?.headers.get('x-ct-at'))||0})));
  await Promise.all(evictions(entries,max).map(key=>cache.delete(key)));
}
async function remember(url,response,kind) {
  const title=kind==='article'?pageTitle(await response.clone().text()):'';
  const copy=await stamp(response,title);
  if(!copy)return;
  const name=kind==='article'?PAGES_CACHE:SHELL_CACHE;
  await (await caches.open(name)).put(pageKey(url),copy);
  if(kind==='article')await trim(PAGES_CACHE,MAX_PAGES);
}
async function cached(url,kind) {
  const name=kind==='article'?PAGES_CACHE:kind==='home'?SHELL_CACHE:null;
  return name?(await caches.open(name)).match(pageKey(url)):undefined;
}
async function offline() {
  return (await (await caches.open(SHELL_CACHE)).match(absolute(CT_PWA.offline)))
    || new Response('You are offline.',{status:503,headers:{'Content-Type':'text/plain; charset=utf-8'}});
}
async function navigate(event,kind) {
  const request=event.request;
  try {
    const response=(await event.preloadResponse)||await fetch(request);
    if((kind==='article'||kind==='home')&&storable(response,kind))event.waitUntil(remember(request.url,response.clone(),kind).catch(()=>{}));
    // A temporarily unavailable newsroom still shows the copy this reader already has.
    if(response.status>=500)return (await cached(request.url,kind))||response;
    return response;
  } catch {
    return (await cached(request.url,kind))||offline();
  }
}
async function cacheFirst(event,kind) {
  const name=kind==='asset'?ASSETS_CACHE:SHELL_CACHE,cache=await caches.open(name);
  const hit=await cache.match(event.request);
  if(hit)return hit;
  const response=await fetch(event.request);
  if(storable(response,kind))event.waitUntil(stamp(response.clone()).then(copy=>copy&&cache.put(event.request,copy)).then(()=>kind==='asset'&&trim(ASSETS_CACHE,MAX_ASSETS)).catch(()=>{}));
  return response;
}
self.addEventListener('install',event=>{
  event.waitUntil((async()=>{
    const shell=await caches.open(SHELL_CACHE);
    // The offline page is required; everything else is best effort (usually an HTTP-cache hit).
    await shell.add(new Request(absolute(CT_PWA.offline),{cache:'reload'}));
    // The front page is the offline shell: the bundled edition renders without the network.
    await shell.add(absolute(CT_PWA.base)).catch(()=>{});
    await Promise.all(CT_PWA.statics.filter(path=>path!=='offline.html').map(path=>shell.add(absolute(CT_PWA.base+path)).catch(()=>{})));
    const assets=await caches.open(ASSETS_CACHE);
    await Promise.all(CT_PWA.precache.map(absolute).map(async url=>{
      if(await assets.match(url))return;
      const response=await fetch(url).catch(()=>null);
      const copy=response&&storable(response,'asset')?await stamp(response):null;
      if(copy)await assets.put(url,copy);
    }));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    await Promise.all(staleCaches(await caches.keys(),CT_PWA.version).map(name=>caches.delete(name)));
    await trim(ASSETS_CACHE,MAX_ASSETS);
    if(self.registration.navigationPreload)await self.registration.navigationPreload.enable().catch(()=>{});
    await self.clients.claim();
  })());
});
self.addEventListener('fetch',event=>{
  const kind=classify(event.request,config);
  if(kind==='skip')return;
  event.respondWith(kind==='asset'||kind==='static'?cacheFirst(event,kind):navigate(event,kind));
});
