// Lazy PWA layer: worker registration, data-saver image controls, offline badges and the install prompt.
import './enhance.css';
import {LITE_KEY} from './lite.js';
import {isLite,setLiteFlag,documentNav} from './boot.js';
export const PAGES_CACHE='ct-pages-v1';
const PUSH_WORKER=/\/OneSignalSDKWorker\.js$/;
const store={get(key){try {return JSON.parse(localStorage.getItem(key)||'null');} catch {return null;}},set(key,value){try {localStorage.setItem(key,JSON.stringify(value));} catch {}}};
export function revealImages(root) {
  for(const image of root.querySelectorAll('img[data-lite-src]')) {
    if(image.parentElement?.tagName==='PICTURE')for(const source of image.parentElement.querySelectorAll('source[data-lite-srcset]')){source.srcset=source.dataset.liteSrcset;source.removeAttribute('data-lite-srcset');}
    if(image.dataset.liteSrcset)image.srcset=image.dataset.liteSrcset;
    image.src=image.dataset.liteSrc;
    image.removeAttribute('data-lite-src');image.removeAttribute('data-lite-srcset');
  }
}
// The worker owns the public base path. A legacy OneSignal worker registered at that same scope keeps it:
// replacing it would silently break push for readers who already opted in.
export async function registerWorker({container=navigator.serviceWorker,baseURI=document.baseURI,doc=document}={}) {
  if(!container||!window.isSecureContext)return null;
  const script=new URL('sw.js',baseURI),scope=new URL('./',script).href;
  const registrations=await container.getRegistrations();
  if(registrations.some(r=>r.scope===scope&&PUSH_WORKER.test((r.active||r.waiting||r.installing)?.scriptURL||'')))return null;
  const registration=await container.register(script.href,{scope,updateViaCache:'none'});
  if(!doc.querySelector('link[rel="manifest"]')) {
    const link=doc.createElement('link');link.rel='manifest';link.href=new URL('manifest.webmanifest',scope).href;doc.head.append(link);
  }
  return registration;
}
export const pageKey=href=>{const url=new URL(href,location.href);return url.origin+url.pathname;};
async function cachedPages() {
  try {return new Set((await (await caches.open(PAGES_CACHE)).keys()).map(request=>pageKey(request.url)));} catch {return new Set();}
}
async function markOffline(root) {
  if(!('caches' in window))return;
  const pages=await cachedPages();
  const article=root.querySelector('#cms-report article .article-header, .newsroom-report article .article-header');
  if(article&&pages.has(pageKey(location.href))&&!root.querySelector('.ct-offline-note')) {
    const note=document.createElement('p');note.className='ct-offline-note';note.textContent='Saved for offline reading on this device.';article.append(note);
  }
  for(const link of root.querySelectorAll("[data-story-slug] h2 a[href]:not([href^='#']), [data-story-slug] h3 a[href]:not([href^='#'])")) {
    const card=link.closest('[data-story-slug]'),saved=pages.has(pageKey(link.href));
    let badge=card.querySelector('.ct-offline-badge');
    // Card badges only matter while offline: they show which stories can still be opened.
    if(saved&&!navigator.onLine) {if(!badge){badge=document.createElement('span');badge.className='ct-offline-badge';badge.textContent='Available offline';link.closest('h2,h3').after(badge);}}
    else badge?.remove();
  }
}
function litePill() {
  let pill=document.querySelector('.ct-lite-pill');
  const hidden=isLite()&&document.querySelector('#app img[data-lite-src]');
  if(!hidden){pill?.remove();return;}
  if(pill)return;
  // In the page flow at the top of the content (never a fixed overlay that could hide focus or content).
  pill=document.createElement('div');pill.className='ct-lite-pill';
  pill.innerHTML='<p>Data saver is on: images load when you ask.</p><button type="button" data-lite-show>Show images</button>';
  pill.querySelector('button').addEventListener('click',()=>{revealImages(document);pill.remove();});
  const main=document.querySelector('#main');
  if(main)main.prepend(pill);else document.body.prepend(pill);
}
// Never on a first visit: offered from the third separate visit, once per 60 days if dismissed.
export function installEligible(visits,now=Date.now()) {
  return !!visits&&visits.count>=3&&!(visits.dismissedAt&&now-visits.dismissedAt<60*864e5);
}
function countVisit() {
  const visits=store.get('ct-visits')||{count:0};
  try {if(!sessionStorage.getItem('ct-visit')){sessionStorage.setItem('ct-visit','1');visits.count++;store.set('ct-visits',visits);}} catch {}
  return visits;
}
function installPrompt(event) {
  const visits=countVisit();
  if(isLite()||!installEligible(visits)||matchMedia('(display-mode: standalone)').matches||document.querySelector('.ct-install'))return;
  const box=document.createElement('aside');box.className='ct-install';box.setAttribute('aria-label','Install Church Times Nigeria');
  box.innerHTML='<p>Add Church Times Nigeria to your home screen for faster reading, even offline.</p><div><button type="button" data-install>Install</button> <button type="button" data-dismiss>Not now</button></div>';
  const close=()=>{box.remove();};
  box.querySelector('[data-install]').addEventListener('click',async()=>{close();try {await event.prompt();} catch {}});
  box.querySelector('[data-dismiss]').addEventListener('click',()=>{store.set('ct-visits',{...visits,dismissedAt:Date.now()});close();});
  document.body.append(box);
}
let rules;
// Speculation rules (Chromium): prefetch article links on a moderate hint; prerender only the lead newsroom story.
// Never in data-saver mode (Chrome itself also skips speculation under Save-Data).
export function speculate(doc=document) {
  rules?.remove();rules=null;
  if(isLite()||!HTMLScriptElement.supports?.('speculationrules'))return;
  rules=doc.createElement('script');rules.type='speculationrules';
  const link="[data-story-slug] a[href]:not([href^='#']), a[data-ct-article]";
  rules.textContent=JSON.stringify({
    prefetch:[{where:{and:[{selector_matches:link},{not:{selector_matches:'[target], [download]'}}]},eagerness:'moderate'}],
    prerender:[{where:{selector_matches:"#newsroom-home .newsroom-card:first-child h2 a, .lead-story h1 a:not([href^='#'])"},eagerness:'moderate'}],
  });
  doc.head.append(rules);
}
export function toggleLite() {
  const on=!isLite();
  setLiteFlag(on);
  try {localStorage.setItem(LITE_KEY,on?'on':'off');} catch {}
  // Lets server-rendered pages honour the choice too. A preference only: no identifier.
  document.cookie=LITE_KEY+'='+(on?'on':'off')+'; Path=/; Max-Age=31536000; SameSite=Lax'+(location.protocol==='https:'?'; Secure':'');
  for(const button of document.querySelectorAll('[data-lite-toggle]'))button.setAttribute('aria-pressed',String(on));
  speculate();
  if(!on)revealImages(document);
  litePill();
}
let started;
export function startEnhance() {
  if(started)return;started=true;
  speculate();
  countVisit();
  addEventListener('beforeinstallprompt',event=>{event.preventDefault();installPrompt(event);});
  if(import.meta.env.PROD)registerWorker().catch(()=>{});
  // Data saver: a tapped image outside a link loads on its own; everything else via "Show images".
  document.addEventListener('click',event=>{
    const image=event.target.closest?.('img[data-lite-src]');
    if(image&&!image.closest('a'))revealImages(image.parentElement);
    // Cross-document view transition: name the chosen card's headline and image for this navigation only.
    const link=event.target.closest?.('a[href]'),card=link?.closest('[data-story-slug]');
    if(card&&!event.defaultPrevented&&documentNav()&&!link.getAttribute('href').startsWith('#')&&!document.querySelector('.article-header h1')) {
      const heading=card.querySelector('h1,h2,h3'),picture=card.querySelector('img');
      if(heading)heading.style.viewTransitionName='ct-title';
      if(picture)picture.style.viewTransitionName='ct-hero';
    }
  });
  addEventListener('pageshow',()=>{for(const el of document.querySelectorAll('[style*="view-transition-name"]'))el.style.viewTransitionName='';});
  const app=document.querySelector('#app');
  let timer;
  const refresh=()=>{clearTimeout(timer);timer=setTimeout(()=>{litePill();markOffline(document).catch(()=>{});},150);};
  if(app)new MutationObserver(refresh).observe(app,{childList:true,subtree:true});
  for(const name of ['online','offline'])addEventListener(name,refresh);
  refresh();
  // The worker stores a just-read article after the response; look again once it has.
  setTimeout(refresh,3000);
}
