import {cmsSources} from './cms-media.js';
export const validReportSlug = slug => typeof slug==='string' && slug.length<=160 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
export function normalizeBasePath(value='/') {
  if(!/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(value)) throw new Error('Base path must use directory segments and a trailing slash');
  return value;
}
export const DEFAULT_ARTICLE_PATH_TEMPLATE='/reports/{slug}/';
export const HOST_ARTICLE_PATH_TEMPLATE='/{slug}/';
export function articlePathTemplate(value,fallback=DEFAULT_ARTICLE_PATH_TEMPLATE) {
  const configured=value ?? (typeof document!=='undefined' ? document.querySelector('meta[name="public-article-path-template"]')?.content : undefined);
  const template=configured==null || (typeof configured==='string'&&!configured.trim()) ? fallback : typeof configured==='string'?configured.trim():configured;
  if(!['/{slug}/',DEFAULT_ARTICLE_PATH_TEMPLATE].includes(template))throw new Error('Article path template must be /{slug}/ or /reports/{slug}/');
  return template;
}
// Mirrors apps/cms/src/lib/reservedSlugs.ts (case-insensitive): first path segments that real routes own under /{slug}/.
const reservedSlugs=new Set(['admin','api','graphql','newsroom','login','logout','account','preview','static','assets','media','uploads','health','healthz','newsletter','contact','search','category','categories','tag','tags','author','authors','topic','topics','section','sections','reports','report','articles','live','events','submit','tips','advertise','advertising','about','privacy','terms','corrections','subscribe','unsubscribe','feed','feeds','rss','sitemap','sitemap.xml','robots.txt','ads.txt','favicon.ico','manifest.json','wp-content','wp-admin','wp-json','wp-includes','wp-login.php','xmlrpc.php','page','comments','attachment','trackback','embed','amp','latest','site','index','saved']);
export const isReservedRootSlug=slug=>typeof slug==='string' && reservedSlugs.has(slug.toLowerCase());
export const reportPath = (slug, base='/', template) => {
  if(!validReportSlug(slug)) return '';
  const pattern=articlePathTemplate(template);
  if(pattern==='/{slug}/' && isReservedRootSlug(slug))return '';
  return normalizeBasePath(base)+pattern.slice(1).replace('{slug}',slug);
};
export function reportSlug(path,base='/',template) {
  const pattern=articlePathTemplate(template);
  const prefix=normalizeBasePath(base)+(pattern==='/{slug}/'?'':'reports/');
  if(!path.startsWith(prefix)) return null;
  const value=path.slice(prefix.length).replace(/\/$/,'');
  return validReportSlug(value) && reportPath(value,base,pattern) ? value : null;
}
export function articleCanonical(slug,{siteUrl,basePath='/',articlePathTemplate:template}={}) {
  const path=reportPath(slug,basePath,template);
  if(!path) return '';
  try {
    const url=new URL(siteUrl);
    if(url.protocol!=='https:' || url.username || url.password || url.search || url.hash) return '';
    return new URL(path,url.origin).href;
  } catch { return ''; }
}
export function articleSchema(article,canonical) {
  const image=cmsSources(article.featuredImage);
  return {'@context':'https://schema.org','@type':'NewsArticle',headline:article.title,description:article.seoDescription || article.excerpt,
    ...(canonical ? {url:canonical,mainEntityOfPage:canonical} : {}),
    ...(article.publishedAt ? {datePublished:article.publishedAt} : {}),
    ...(article.bylineName ? {author:{'@type':'Person',name:article.bylineName}} : {}),
    ...(article.category ? {articleSection:article.category} : {}),
    ...(image ? {image:[{'@type':'ImageObject',url:image.url,...(image.width?{width:image.width,height:image.height}:{})}]} : {}),
    publisher:{'@type':'Organization',name:'Church Times Nigeria'}};
}
export const safeJSON = value => JSON.stringify(value).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
