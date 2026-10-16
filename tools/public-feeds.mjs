// Public discovery endpoints. All CMS reads use the anonymous, published-only adapter.
import {fetchPublishedPage,fetchPublicCategories} from '../src/lib/published-articles.js';
import {siteCanonical,HOME_DESCRIPTION,SITE_NAME} from '../src/lib/public-metadata.js';
import {reportPath} from '../src/lib/public-routes.js';
import {cmsSources} from '../src/lib/cms-media.js';
export const SITEMAP_PAGE_SIZE=100;
const MAX_SITEMAP_PAGES=1000,MAX_CATEGORY_PAGES=20,CACHE_MS=60000;
export const xml=value=>String(value ?? '').replace(/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu,'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const declaration='<?xml version="1.0" encoding="UTF-8"?>';
export const PUBLIC_STATIC_PAGES=['','latest/','about/','contact/','advertise/'];
export function createPublicFeeds({cmsUrl,siteUrl,basePath='/',indexable=false,articlePathTemplate,fetchImpl=fetch}={}) {
  const articlePath=slug=>reportPath(slug,basePath,articlePathTemplate);
  const canonical=path=>siteCanonical(basePath+path,{siteUrl});
  const options={baseUrl:cmsUrl,fetchImpl,timeoutMs:6000};
  const cache=new Map();
  async function cached(key,load) {
    const old=cache.get(key);if(old && old.expires>Date.now())return old.promise;
    if(cache.size>=64)cache.delete(cache.keys().next().value);
    const entry={expires:Date.now()+CACHE_MS,promise:null};
    entry.promise=load().catch(error=>{if(cache.get(key)===entry)cache.delete(key);throw error;});cache.set(key,entry);return entry.promise;
  }
  async function categories() {
    const items=[];let page=1;
    for(let count=0;count<MAX_CATEGORY_PAGES;count++) {
      const result=await fetchPublicCategories({...options,page});
      if(result.articles.length>100)throw new Error('CMS category page exceeds requested limit');
      items.push(...result.articles);
      if(!result.nextPage)return items;page=result.nextPage;
    }
    throw new Error('Category sitemap capacity exceeded');
  }
  async function sitemap(page) {
    const result=await fetchPublishedPage({...options,page:page || 1,limit:SITEMAP_PAGE_SIZE});
    if(result.articles.length>SITEMAP_PAGE_SIZE)throw new Error('CMS article page exceeds requested limit');
    const pages=result.totalPages || (result.nextPage?0:1);
    if(!pages || pages>MAX_SITEMAP_PAGES)throw new Error('Sitemap capacity exceeded');
    if(page>pages)return null;
    if(!page && pages>1)return declaration+'<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'+Array.from({length:pages},(_,i)=>`<sitemap><loc>${xml(canonical('sitemap-'+(i+1)+'.xml'))}</loc></sitemap>`).join('')+'</sitemapindex>';
    const urls=[];
    if(!page || page===1) {
      urls.push(...PUBLIC_STATIC_PAGES.map(path=>({url:canonical(path)})));
      urls.push(...(await categories()).map(category=>({url:canonical('category/'+category.slug+'/')})));
    }
    const seen=new Set();
    for(const article of result.articles.slice(0,SITEMAP_PAGE_SIZE)) {
      if(seen.has(article.slug))continue;seen.add(article.slug);
      const path=articlePath(article.slug);if(!path)continue;
      urls.push({url:siteCanonical(path,{siteUrl}),lastmod:article.updatedAt || article.publishedAt});
    }
    return declaration+'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'+urls.map(item=>`<url><loc>${xml(item.url)}</loc>${item.lastmod?`<lastmod>${xml(item.lastmod)}</lastmod>`:''}</url>`).join('')+'</urlset>';
  }
  async function feed() {
    const {articles}=await fetchPublishedPage({...options,limit:30});
    const seen=new Set();
    const items=articles.filter(a=>articlePath(a.slug)&&!seen.has(a.slug)&&seen.add(a.slug)).slice(0,30).map(article=>{
      const link=siteCanonical(articlePath(article.slug),{siteUrl});
      const media=article.featuredImage,image=cmsSources(media);
      const enclosure=media?.fileSize?`<enclosure url="${xml(media.url)}" length="${media.fileSize}" type="${xml(media.mimeType)}"/>`:'';
      return `<item><title>${xml(article.title)}</title><link>${xml(link)}</link><guid isPermaLink="true">${xml(link)}</guid>${article.publishedAt?`<pubDate>${xml(new Date(article.publishedAt).toUTCString())}</pubDate>`:''}<description>${xml(article.excerpt)}</description>${enclosure}${image?`<media:content url="${xml(image.url)}" medium="image"${image.width?` width="${image.width}" height="${image.height}"`:''}/>`:''}</item>`;
    }).join('');
    return declaration+`<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:atom="http://www.w3.org/2005/Atom"><channel><title>${xml(SITE_NAME)}</title><link>${xml(canonical(''))}</link><description>${xml(HOME_DESCRIPTION)}</description><language>en-ng</language><atom:link href="${xml(canonical('feed.xml'))}" rel="self" type="application/rss+xml"/>${items}</channel></rss>`;
  }
  return async function publicFeeds(url,respond) {
    const path=url.pathname.slice(basePath.length);
    if(path==='robots.txt') {
      const body=indexable && canonical('')?'User-agent: *\nAllow: /\nSitemap: '+canonical('sitemap.xml')+'\n':'User-agent: *\nDisallow: /\n';
      respond(200,'text/plain; charset=utf-8',body,{'Cache-Control':'public, max-age=60'});return true;
    }
    const part=path.match(/^sitemap-([1-9]\d{0,3})\.xml$/);
    if(!['sitemap.xml','feed.xml'].includes(path) && !part)return false;
    const headers={'Cache-Control':'public, max-age=60',...(!indexable?{'X-Robots-Tag':'noindex'}:{})};
    if(!canonical('') || !cmsUrl) {respond(503,'text/plain','Public discovery is not configured.',{'X-Robots-Tag':'noindex'});return true;}
    try {
      if(part && Number(part[1])>MAX_SITEMAP_PAGES){respond(404,'text/plain','Not found',{'X-Robots-Tag':'noindex'});return true;}
      const body=await cached(path,()=>path==='feed.xml'?feed():sitemap(part?Number(part[1]):0));
      respond(body?200:404,body?(path==='feed.xml'?'application/rss+xml; charset=utf-8':'application/xml; charset=utf-8'):'text/plain',body || 'Not found',headers);
    } catch {respond(503,'text/plain','Public discovery is temporarily unavailable.',{'X-Robots-Tag':'noindex','Retry-After':'60'});}
    return true;
  };
}
