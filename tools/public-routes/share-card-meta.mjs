// Open Graph share cards on article pages (CMS endpoint GET /api/public/share-card/:slug.png, apps/cms
// src/endpoints/publicShareCard.ts). PUBLIC_SHARE_CARDS on the public host must match SHARE_CARDS_ENABLED on the CMS,
// otherwise the tags would point at a 404:
//   unset/"false"  no card tags (default);
//   "fallback"     card only for articles without a featured image (the photo stays the share image);
//   "always"       card for every article.
// Nothing here reaches the browser bundle; the server adds a few <meta> tags to the HTML it already sends.
import {escapeAttribute as escape} from '../../src/lib/public-metadata.js';
import {publicOrigin} from '../../src/lib/public-url.js';

export function shareCardMode(value=process.env.PUBLIC_SHARE_CARDS){
  return value==='always' || value==='fallback' ? value : 'off';
}

const SLUG=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Absolute card URL with a cache-busting version, or '' when it cannot be built safely. */
export function shareCardUrl(article,cmsUrl){
  if(!article || !SLUG.test(article.slug||'') || !cmsUrl || !publicOrigin(cmsUrl))return '';
  try {
    const url=new URL(`/api/public/share-card/${article.slug}.png`,new URL(cmsUrl));
    const version=article.updatedAt||article.publishedAt;
    if(version)url.searchParams.set('v',version);
    return url.href;
  } catch {return '';}
}

/** Replaces or adds the image tags in an article page's <head> according to the mode. */
export function applyShareCardMeta(html,article,{cmsUrl,mode=shareCardMode()}={}){
  if(mode==='off' || !article)return html;
  const hasImage=/<meta\b[^>]*property="og:image"/.test(html);
  if(mode==='fallback' && hasImage)return html;
  const url=shareCardUrl(article,cmsUrl);
  if(!url)return html;
  const tags={'og:image':url,'og:image:type':'image/png','og:image:width':'1200','og:image:height':'630','og:image:alt':article.title||'Church Times Nigeria','twitter:image':url};
  html=html.replace(/<meta\b[^>]*(?:property|name)="(?:og:image(?::[a-z]+)?|twitter:image)"[^>]*>/g,'');
  html=html.replace(/(<meta\b[^>]*name="twitter:card" content=")[^"]*(")/,'$1summary_large_image$2');
  const meta=Object.entries(tags).map(([key,value])=>`<meta data-public-metadata ${key.startsWith('twitter:')?'name':'property'}="${key}" content="${escape(value)}">`).join('');
  return html.replace('</head>',()=>meta+'</head>');
}
