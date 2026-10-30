// PWA host routes: web app manifest, the offline-first service worker and its offline page.
// The worker is served by this host (never bundled) so it can carry the build version and scope.
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {RESERVED_ROOT_SLUGS,articlePathTemplate as validTemplate,HOST_ARTICLE_PATH_TEMPLATE} from '../../src/lib/public-routes.js';
import {liteRequest,liteHTML} from '../../src/features/pwa/lite.js';
const source=name=>readFile(fileURLToPath(new URL('../../src/features/pwa/'+name,import.meta.url)),'utf8');
export const PWA_THEME='#172b2e';
export const PWA_BACKGROUND='#f7f5ef';
export const PWA_ICONS=[
  {src:'site/pwa/icon-192.png',sizes:'192x192',type:'image/png',purpose:'any'},
  {src:'site/pwa/icon-512.png',sizes:'512x512',type:'image/png',purpose:'any'},
  {src:'site/pwa/icon-maskable-512.png',sizes:'512x512',type:'image/png',purpose:'maskable'},
];
export const PWA_STATICS=['offline.html','manifest.webmanifest',...PWA_ICONS.map(icon=>icon.src)];
export function pwaManifest(basePath='/') {
  return {
    id:basePath,name:'Church Times Nigeria',short_name:'Church Times',
    description:'News, features and perspectives on faith and public life in Nigeria.',
    lang:'en',dir:'ltr',start_url:basePath,scope:basePath,display:'standalone',
    background_color:PWA_BACKGROUND,theme_color:PWA_THEME,categories:['news'],icons:PWA_ICONS,
  };
}
// Initial JS/CSS and preloaded fonts from the compiled entry, as absolute same-origin paths.
export function entryAssets(html,basePath='/') {
  const refs=[...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="\.\/((?:site\/)?assets\/[^"?#]+\.(?:js|css|woff2))"/g)].map(match=>basePath+match[1]);
  return [...new Set(refs)];
}
export async function serviceWorkerSource({html,basePath='/',template=HOST_ARTICLE_PATH_TEMPLATE}) {
  const [core,events]=await Promise.all([source('sw-core.js'),source('sw-events.js')]);
  const settings={base:basePath,template,reserved:[...RESERVED_ROOT_SLUGS],offline:basePath+'offline.html',statics:PWA_STATICS,precache:entryAssets(html,basePath)};
  const body=core.replace(/^export /gm,'')+'\n'+events;
  const version=createHash('sha256').update(JSON.stringify(settings)).update(JSON.stringify(pwaManifest(basePath))).update(OFFLINE_HTML).update(html).update(body).digest('hex').slice(0,16);
  return `// Church Times Nigeria offline worker ${version}. Same-origin public pages and assets only.\nconst CT_PWA=${JSON.stringify({...settings,version})};\n${body}`;
}
export const OFFLINE_HTML=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><meta name="theme-color" content="${PWA_THEME}"><title>You are offline — Church Times Nigeria</title><style>:root{color-scheme:light dark;--ink:#172b2e;--paper:#f7f5ef;--clay:#9c4d35}body{margin:0;font:17px/1.6 Georgia,'Times New Roman',serif;background:var(--paper);color:var(--ink)}main{max-width:40rem;margin:0 auto;padding:3rem 1.25rem}h1{font-size:2rem;line-height:1.2;margin:0 0 1rem}a,button{color:var(--clay);font:inherit}a:focus-visible,button:focus-visible{outline:3px solid var(--clay);outline-offset:4px}ul{padding-left:1.2rem}li{margin:.5rem 0}button{background:none;border:1px solid currentColor;padding:.5rem 1rem;cursor:pointer;margin-top:1rem}@media (prefers-color-scheme:dark){:root{--ink:#eef0ea;--paper:#10201f;--clay:#e0a283}}</style></head><body><main id="main"><p>Church Times Nigeria</p><h1>You are offline.</h1><p>This page is not saved on this device. Check your connection and try again.</p><p><a href="./">Try the front page</a></p><section aria-labelledby="saved-title"><h2 id="saved-title">Saved for offline reading</h2><p id="saved-status" role="status">Looking for stories saved on this device…</p><ul id="saved-list"></ul><button type="button" id="saved-clear" hidden>Remove saved copies from this device</button></section></main><script>
(async()=>{const status=document.getElementById('saved-status'),list=document.getElementById('saved-list'),clear=document.getElementById('saved-clear');
try{const cache=await caches.open('ct-pages-v1'),keys=await cache.keys(),rows=[];
for(const key of keys){const res=await cache.match(key);rows.push({url:key.url,at:Number(res&&res.headers.get('x-ct-at'))||0,title:decodeURIComponent((res&&res.headers.get('x-ct-title'))||'')||new URL(key.url).pathname});}
rows.sort((a,b)=>b.at-a.at);
for(const row of rows){const li=document.createElement('li'),a=document.createElement('a');a.href=row.url;a.textContent=row.title;li.append(a);list.append(li);}
status.textContent=rows.length?rows.length+(rows.length===1?' story is':' stories are')+' saved on this device.':'No stories are saved yet. Stories you read while online are kept here, up to 25.';
clear.hidden=!rows.length;clear.addEventListener('click',async()=>{await caches.delete('ct-pages-v1');list.replaceChildren();clear.hidden=true;status.textContent='Saved copies were removed from this device.';});
}catch{status.textContent='Saved stories are unavailable in this browser.';}})();
</script></body></html>`;
// Registered once in serve-public.mjs. Returns true when it answered the request.
export function createPwaRoutes({dist,basePath='/',articlePathTemplate}) {
  const template=validTemplate(articlePathTemplate,HOST_ARTICLE_PATH_TEMPLATE);
  const manifest=JSON.stringify(pwaManifest(basePath));
  return async function pwaRoute(req,url,respond) {
    // Data saver: honour Save-Data or the reader's lite cookie on server-rendered HTML too (no image bytes before tap).
    if(liteRequest(req.headers))respond.transform=liteHTML;
    const rel=url.pathname.startsWith(basePath)?url.pathname.slice(basePath.length):null;
    if(rel==='manifest.webmanifest')return respond(200,'application/manifest+json',manifest,{'Cache-Control':'public, max-age=3600'}),true;
    if(rel==='offline.html')return respond(200,'text/html; charset=utf-8',OFFLINE_HTML,{'Cache-Control':'no-cache','X-Robots-Tag':'noindex'}),true;
    if(rel==='sw.js') {
      const html=await readFile(join(dist,'index.html'),'utf8');
      // no-cache: browsers revalidate the worker on every update check; the scope is the public base path.
      return respond(200,'text/javascript; charset=utf-8',await serviceWorkerSource({html,basePath,template}),{'Cache-Control':'no-cache','Service-Worker-Allowed':basePath,'X-Robots-Tag':'noindex'}),true;
    }
    return false;
  };
}
