import {cmsSources} from './cms-media.js';
export const validReportSlug = slug => typeof slug==='string' && slug.length<=160 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
export function normalizeBasePath(value='/') {
  if(!/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(value)) throw new Error('Base path must use directory segments and a trailing slash');
  return value;
}
export const reportPath = (slug, base='/') => {
  if(!validReportSlug(slug)) return '';
  return `${normalizeBasePath(base)}reports/${slug}/`;
};
export function reportSlug(path,base='/') {
  const prefix=normalizeBasePath(base)+'reports/';
  if(!path.startsWith(prefix)) return null;
  const value=path.slice(prefix.length).replace(/\/$/,'');
  return validReportSlug(value) ? value : null;
}
export function articleCanonical(slug,{siteUrl,basePath='/'}={}) {
  const path=reportPath(slug,basePath);
  if(!path) return '';
  try {
    const url=new URL(siteUrl);
    if(url.protocol!=='https:' || url.username || url.password || url.search || url.hash) return '';
    return new URL(path,url.origin).href;
  } catch { return ''; }
}
export function articleSchema(article,canonical) {
  const image=cmsSources(article.featuredImage);
  return {'@context':'https://schema.org','@type':'NewsArticle',headline:article.title,description:article.excerpt,
    ...(canonical ? {url:canonical,mainEntityOfPage:canonical} : {}),
    ...(article.publishedAt ? {datePublished:article.publishedAt} : {}),
    ...(article.bylineName ? {author:{'@type':'Person',name:article.bylineName}} : {}),
    ...(article.category ? {articleSection:article.category} : {}),
    ...(image ? {image:[{'@type':'ImageObject',url:image.url,...(image.width?{width:image.width,height:image.height}:{})}]} : {}),
    publisher:{'@type':'Organization',name:'Church Times Nigeria'}};
}
export const safeJSON = value => JSON.stringify(value).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
