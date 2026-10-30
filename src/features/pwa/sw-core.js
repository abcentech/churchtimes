// Pure service-worker policy. The public host embeds this file (with `export` removed) in /sw.js;
// unit tests import it directly. No browser globals are touched at module load.
export const PAGES_CACHE='ct-pages-v1';
export const ASSETS_CACHE='ct-assets-v1';
export const SHELL_PREFIX='ct-shell-';
export const MAX_PAGES=25;
export const MAX_ASSETS=80;
// Bundled public-domain KJV books (daily verse and scripture cards): kept for offline devotions, capped.
export const SCRIPTURE_CACHE='ct-scripture-v1';
export const MAX_SCRIPTURE=12;
export const MAX_PAGE_BYTES=1048576;
// First path segments the worker never touches, cached or not: staff, APIs, giving, newsletter, feeds and push.
// Other public pages (search, contact, submit) are network-only with the offline page as their fallback.
export const BLOCKED_SEGMENTS=['admin','api','graphql','newsroom','login','logout','account','preview','newsletter','subscribe','unsubscribe','give','giving','donate','donation','donations','comments','feed','feeds','rss','sitemap.xml','robots.txt','ads.txt','sw.js','OneSignalSDKWorker.js','push'];
const SLUG=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export function articleSlug(rel,config) {
  const template=config.template==='/reports/{slug}/'?'reports/':'';
  if(!rel.startsWith(template)||!rel.endsWith('/'))return null;
  const slug=rel.slice(template.length,-1);
  if(slug.length>160||!SLUG.test(slug))return null;
  if(!template&&(config.reserved||[]).includes(slug))return null;
  return slug;
}
// Returns what the worker may do with a request: skip (browser default), asset, home, article, page or static.
export function classify(request,config) {
  if(request.method!=='GET')return 'skip';
  let url;
  try {url=new URL(request.url);} catch {return 'skip';}
  if(url.origin!==config.origin||!url.pathname.startsWith(config.base))return 'skip';
  let rel;
  try {rel=decodeURIComponent(url.pathname.slice(config.base.length));} catch {return 'skip';}
  const first=rel.split('/')[0];
  if(BLOCKED_SEGMENTS.includes(first)||rel.includes('..'))return 'skip';
  // Range requests (audio/video) and credentialed fetch() calls are left to the network.
  if(request.headers&&request.headers.get('range'))return 'skip';
  if(request.mode==='navigate') {
    if(rel===''||rel==='index.html')return 'home';
    // The church calendar is a server-rendered devotional page: keep its default view like the front page.
    if(rel==='church-calendar/')return url.search?'page':'home';
    // Files (feeds, sitemaps, downloads) are not pages: the browser handles them as usual.
    if(/\.[a-z0-9]+$/i.test(rel))return 'skip';
    return articleSlug(rel,config)?'article':'page';
  }
  if(/^(?:site\/)?assets\/[^/]+\.(?:js|css|woff2)$/.test(rel))return 'asset';
  if(/^(?:site\/)?scripture\/kjv\/[a-z0-9-]{1,40}\.json$/.test(rel)&&!url.search)return 'scripture';
  if(config.statics.includes(rel))return 'static';
  return 'skip';
}
export function pageKey(url) {
  const parsed=new URL(url);
  return parsed.origin+parsed.pathname;
}
// Only plain, successful, same-origin public HTML is stored. Anything marked private or no-cache-able by the host is not.
export function storable(response,kind) {
  if(!response||response.status!==200||response.type!=='basic'||response.redirected)return false;
  const control=(response.headers.get('cache-control')||'').toLowerCase();
  if(/\bprivate\b/.test(control))return false;
  if(response.headers.get('set-cookie'))return false;
  const type=(response.headers.get('content-type')||'').toLowerCase();
  if(kind==='article'||kind==='home')return type.startsWith('text/html');
  if(kind==='scripture')return type.includes('json');
  return true;
}
export function pageTitle(html) {
  const match=/<title>([^<]{1,300})<\/title>/i.exec(html);
  return match?match[1].replace(/\s+—\s+Church Times Nigeria$/,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").trim():'';
}
// Oldest-first eviction list: entries beyond `max`, ordered by the stored timestamp header.
export function evictions(entries,max) {
  if(entries.length<=max)return [];
  return [...entries].sort((a,b)=>a.at-b.at).slice(0,entries.length-max).map(entry=>entry.key);
}
export function staleCaches(names,version) {
  return names.filter(name=>name.startsWith('ct-')&&name!==SHELL_PREFIX+version&&name!==PAGES_CACHE&&name!==ASSETS_CACHE&&name!==SCRIPTURE_CACHE);
}
