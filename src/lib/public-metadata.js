import {cmsSources,cmsPreload} from './cms-media.js';
export const SITE_NAME='Church Times Nigeria';
export const HOME_TITLE='Church Times Nigeria — Faith in the world';
export const HOME_DESCRIPTION='Church Times Nigeria: news, features, interviews and perspectives on faith and public life.';
export const escapeAttribute=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function siteCanonical(path,{siteUrl}={}) {
  try {
    const url=new URL(siteUrl);
    return url.protocol==='https:' && !url.username && !url.password && !url.search && !url.hash ? new URL(path,url.origin).href : '';
  } catch {return '';}
}
export function socialMetadata(article,canonical) {
  const image=cmsSources(article?.featuredImage);
  return {
    'og:type':article?'article':'website',
    'og:title':article?.seoTitle || article?.title || HOME_TITLE,
    'og:description':article?.seoDescription || article?.excerpt || HOME_DESCRIPTION,
    'og:site_name':SITE_NAME,
    ...(canonical?{'og:url':canonical}:{}),
    ...(image?{'og:image':image.url,'og:image:alt':article.featuredImage.alt || article.title,
      ...(image.width?{'og:image:width':String(image.width),'og:image:height':String(image.height)}:{})}:{}),
    ...(article?.publishedAt?{'article:published_time':article.publishedAt}:{}),
    ...(article?.category?{'article:section':article.category}:{}),
    'twitter:card':article?'summary_large_image':'summary',
  };
}
export function socialHTML(article,canonical) {
  return Object.entries(socialMetadata(article,canonical)).map(([key,value])=>`<meta data-public-metadata ${key.startsWith('twitter:')?'name':'property'}="${key}" content="${escapeAttribute(value)}">`).join('')+cmsPreload(article?.featuredImage);
}
export function replaceSocialHTML(html,article,canonical) {
  return html.replace(/<meta\b[^>]*(?:property|name)="(?:og:|article:|twitter:)[^"]*"[^>]*>/g,'').replace('</head>',()=>socialHTML(article,canonical)+'</head>');
}
