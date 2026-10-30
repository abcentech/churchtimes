// Production build + the real public host + a real Chromium service worker. The CMS API is a STUB.
import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {execFileSync} from 'node:child_process';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPublicServer} from '../tools/serve-public.mjs';
const cms='https://cms.example.test';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64');
const image={id:4,url:'/api/media/file/choir.jpg',mimeType:'image/jpeg',width:1200,height:675,alt:'The choir at dawn',sizes:{card:{url:'/api/media/file/choir-800x450.webp',width:800,height:450,mimeType:'image/webp'}}};
const story=(slug,title)=>({id:slug,status:'published',slug,title,excerpt:'Synthetic excerpt for '+title,publishedAt:'2026-10-29T08:00:00Z',category:'News',bylineName:'Synthetic Reporter',content:'Synthetic article text for '+title,corrections:[],featuredImage:image});
const articles=[story('bishops-meet-in-abuja','Bishops meet in Abuja'),story('choir-tour-begins','Choir tour begins')];
let dist;
test.beforeAll(async()=>{
  dist=await mkdtemp(join(tmpdir(),'public-pwa-build-'));
  execFileSync(process.execPath,['node_modules/vite/bin/vite.js','build','--outDir',dist],{env:{...process.env,VITE_PUBLIC_CMS_URL:cms,VITE_PUBLIC_SITE_URL:'https://public.example.test'},stdio:'pipe'});
  // STUB legacy push worker (no provider code): proves the offline worker never takes over its scope.
  await writeFile(join(dist,'OneSignalSDKWorker.js'),"self.addEventListener('push',()=>{});\n");
});
test.afterAll(async()=>{await rm(dist,{recursive:true,force:true});});
async function host() {
  const fetchImpl=async url=>{const slug=new URL(url).searchParams.get('where[slug][equals]');return Response.json({docs:slug?articles.filter(a=>a.slug===slug):articles,totalPages:1,hasNextPage:false});};
  const server=createPublicServer({dist,cmsUrl:cms,siteUrl:'https://public.example.test',articlePathTemplate:'/{slug}/',fetchImpl});
  await server.publicReady;await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {server,origin:'http://127.0.0.1:'+server.address().port,stop:()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();})};
}
async function stubCMS(page,images=[]) {
  await page.route(cms+'/**',route=>{
    const url=new URL(route.request().url());
    if(url.pathname.startsWith('/api/media/file/')){images.push(url.pathname);return route.fulfill({contentType:'image/png',body:png});}
    const slug=url.searchParams.get('where[slug][equals]');
    return route.fulfill({json:{docs:slug?articles.filter(a=>a.slug===slug):articles,totalPages:1,hasNextPage:false}});
  });
}
const controlled=page=>page.waitForFunction(()=>!!navigator.serviceWorker.controller,null,{timeout:20000});
const savedPages=page=>page.evaluate(async()=>(await (await caches.open('ct-pages-v1')).keys()).map(r=>new URL(r.url).pathname));

test('offline: the shell and read articles are kept; unread pages get the offline page',async({page})=>{
  const {origin,stop}=await host();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  try {
    await stubCMS(page);
    await page.goto(origin+'/');
    await controlled(page);
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href',origin+'/manifest.webmanifest');
    const manifest=await page.evaluate(async()=>(await fetch('/manifest.webmanifest')).json());
    expect(manifest).toMatchObject({start_url:'/',scope:'/',display:'standalone',theme_color:'#172b2e'});
    for(const icon of manifest.icons)expect((await page.request.get(origin+'/'+icon.src)).status()).toBe(200);
    // A document navigation through the worker stores the article.
    await page.goto(origin+'/bishops-meet-in-abuja/');
    await expect(page.getByRole('heading',{level:1,name:'Bishops meet in Abuja'})).toBeVisible();
    await expect.poll(()=>savedPages(page)).toContain('/bishops-meet-in-abuja/');
    await expect(page.locator('.ct-offline-note')).toHaveText('Saved for offline reading on this device.',{timeout:10000});
    for(const path of ['/admin/','/newsletter/confirm/','/give/'])await page.goto(origin+path).catch(()=>{});
    expect(await savedPages(page)).toEqual(['/bishops-meet-in-abuja/']);
    await stop();
    await page.goto(origin+'/bishops-meet-in-abuja/');
    await expect(page.getByRole('heading',{level:1,name:'Bishops meet in Abuja'})).toBeVisible();
    await expect(page.locator('.newsroom-article-body')).toContainText('Synthetic article text for Bishops meet in Abuja');
    await page.goto(origin+'/choir-tour-begins/');
    await expect(page.getByRole('heading',{level:1,name:'You are offline.'})).toBeVisible();
    await expect(page.getByRole('link',{name:'Bishops meet in Abuja'})).toHaveAttribute('href',origin+'/bishops-meet-in-abuja/');
    expect((await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze()).violations).toEqual([]);
    await page.goto(origin+'/');
    await expect(page.locator('.lead-story h1')).toBeVisible();
    expect(errors).toEqual([]);
  } finally {await stop().catch(()=>{});}
});

test('data saver: the reader toggle defers images until tapped, stops speculation and is honoured server-side',async({page,request})=>{
  const {origin,stop}=await host();
  try {
    const images=[];await stubCMS(page,images);
    const local=[];page.on('request',r=>{if(r.resourceType()==='image'&&r.url().includes('/news-media/'))local.push(r.url());});
    await page.goto(origin+'/');
    await expect(page.locator('script[type="speculationrules"]')).toHaveCount(1,{timeout:15000});
    const rules=JSON.parse(await page.locator('script[type="speculationrules"]').textContent());
    expect(rules.prefetch[0].eagerness).toBe('moderate');expect(rules.prerender).toHaveLength(1);
    const toggle=page.getByRole('button',{name:'Data saver'});
    await expect(toggle).toHaveAttribute('aria-pressed','false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed','true');
    await expect(page.locator('script[type="speculationrules"]')).toHaveCount(0);
    local.length=0;images.length=0;
    await page.reload();
    await expect(page.locator('.lead-story h1')).toBeVisible();
    await expect(page.locator('#newsroom-home .newsroom-card')).toHaveCount(2);
    expect(await page.locator('#app img[data-lite-src]').count()).toBeGreaterThan(3);
    // Boxes are reserved: every placeholder already has its final aspect ratio.
    expect(await page.locator('#app img[data-lite-src]').evaluateAll(list=>list.every(img=>img.getAttribute('width')&&img.src.startsWith('data:image/svg+xml')))).toBe(true);
    await page.waitForTimeout(1500);
    expect(local).toEqual([]);expect(images).toEqual([]);
    const show=page.getByRole('button',{name:'Show images'});
    await expect(show).toBeVisible({timeout:10000});
    // Scope: the new controls only (pre-existing footer social icons are outside this feature).
    const axe=await new AxeBuilder({page}).include('.ct-lite-pill').include('[data-lite-toggle]').withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze();
    expect(axe.violations.map(v=>[v.id,v.nodes.map(n=>n.target.join(' '))])).toEqual([]);
    await show.click();
    await expect.poll(()=>local.length+images.length).toBeGreaterThan(0);
    await expect(page.locator('#app img[data-lite-src]')).toHaveCount(0);
    // The cookie lets the server-rendered article skip its image bytes too; Save-Data does the same.
    expect((await page.context().cookies()).find(c=>c.name==='ct-lite')?.value).toBe('on');
    for(const headers of [{cookie:'ct-lite=on'},{'save-data':'on'}]) {
      const html=await (await request.get(origin+'/bishops-meet-in-abuja/',{headers})).text();
      expect(html).toContain('data-lite-src="'+cms+'/api/media/file/');expect(html).not.toMatch(/fetchpriority="high"|rel="preload" as="image"/);
    }
    const normal=await (await request.get(origin+'/bishops-meet-in-abuja/')).text();
    expect(normal).not.toContain('data-lite-src');expect(normal).toContain('fetchpriority="high"');
  } finally {await stop();}
});

test('push: an existing root OneSignal worker keeps its scope; the push sub-scope coexists with the offline worker',async({page})=>{
  const {origin,stop}=await host();
  try {
    await stubCMS(page);
    await page.goto(origin+'/offline.html');
    await page.evaluate(async()=>{await navigator.serviceWorker.register('/OneSignalSDKWorker.js',{scope:'/'});await navigator.serviceWorker.ready;});
    await page.goto(origin+'/');
    await expect(page.locator('script[type="speculationrules"]')).toHaveCount(1,{timeout:15000});
    await page.waitForTimeout(1500);
    const scripts=()=>page.evaluate(async()=>(await navigator.serviceWorker.getRegistrations()).map(r=>[new URL(r.scope).pathname,new URL((r.active||r.waiting||r.installing).scriptURL).pathname]).sort());
    expect(await scripts()).toEqual([['/','/OneSignalSDKWorker.js']]);
    // Fresh reader: the offline worker owns '/', OneSignal (as configured in public-push.js) registers under /push/onesignal/.
    await page.evaluate(async()=>{for(const r of await navigator.serviceWorker.getRegistrations())await r.unregister();});
    await page.reload();await controlled(page);
    await page.evaluate(async()=>{await navigator.serviceWorker.register('/OneSignalSDKWorker.js',{scope:'/push/onesignal/'});});
    await expect.poll(scripts).toEqual([['/','/sw.js'],['/push/onesignal/','/OneSignalSDKWorker.js']]);
  } finally {await stop();}
});

test('install prompt: never on a first visit, offered from the third, dismissible and remembered',async({browser})=>{
  const {origin,stop}=await host();
  try {
    for(const [count,shown] of [[0,false],[2,true]]) {
      const context=await browser.newContext();const page=await context.newPage();await stubCMS(page);
      await page.addInitScript(count=>{if(!sessionStorage.getItem('seeded')){sessionStorage.setItem('seeded','1');localStorage.setItem('ct-visits',JSON.stringify({count}));}},count);
      await page.goto(origin+'/');
      await expect(page.locator('script[type="speculationrules"]')).toHaveCount(1,{timeout:15000});
      await page.evaluate(()=>{const event=new Event('beforeinstallprompt',{cancelable:true});event.prompt=async()=>{window.prompted=true;};dispatchEvent(event);});
      const box=page.getByRole('complementary',{name:'Install Church Times Nigeria'});
      if(!shown){await expect(box).toHaveCount(0);await context.close();continue;}
      await expect(box).toBeVisible();
      expect((await new AxeBuilder({page}).include('.ct-install').withTags(['wcag2a','wcag2aa','wcag21aa','wcag22aa']).analyze()).violations).toEqual([]);
      await box.getByRole('button',{name:'Not now'}).click();
      await expect(box).toHaveCount(0);
      expect(JSON.parse(await page.evaluate(()=>localStorage.getItem('ct-visits'))).dismissedAt).toBeGreaterThan(0);
      await page.evaluate(()=>{const event=new Event('beforeinstallprompt');event.prompt=async()=>{};dispatchEvent(event);});
      await expect(box).toHaveCount(0);
      await context.close();
    }
  } finally {await stop();}
});

test('Yoruba and Igbo dotted vowels load the lazy Newsreader subset; English pages never fetch it',async({page})=>{
  const {origin,stop}=await host();
  try {
    await stubCMS(page);const fonts=[];page.on('request',r=>{if(r.url().endsWith('.woff2'))fonts.push(r.url());});
    await page.goto(origin+'/');await expect(page.locator('.lead-story h1')).toBeVisible();await page.waitForTimeout(500);
    expect(fonts.filter(url=>url.includes('vietnamese'))).toEqual([]);
    const faces=await page.evaluate(async()=>{const p=document.createElement('p');p.style.font="20px 'Newsreader Variable'";p.textContent='Ẹ̀kọ́ ọmọ ịkụ';document.querySelector('main').append(p);return (await document.fonts.load("20px 'Newsreader Variable'",'Ẹ̀kọ́ ọmọ ịkụ')).map(face=>face.unicodeRange);});
    expect(faces.some(range=>/1EA0-1EF9/i.test(range))).toBe(true);
    expect(fonts.some(url=>url.includes('newsreader-vietnamese-wght-normal'))).toBe(true);
    // View transitions name the article headline (the cross-document rule itself is CSS-only).
    await page.goto(origin+'/bishops-meet-in-abuja/');
    await expect(page.locator('.article-header h1')).toHaveCSS('view-transition-name','ct-title');
  } finally {await stop();}
});
