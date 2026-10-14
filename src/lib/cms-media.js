import { normalizePublicMedia, mediaUrl } from './published-articles.js';
export { normalizePublicMedia };
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const CMS_CARD_SIZES='(max-width: 760px) calc(100vw - 38px), 420px';
export const CMS_HERO_SIZES='(max-width: 760px) calc(100vw - 38px), 1000px';
export function cmsSources(media,{card=false}={}) {
  if(!media || !mediaUrl(media.url))return null;
  const valid=v=>v && mediaUrl(v.url,media.url) && Number.isSafeInteger(v.width) && v.width>0 && v.width<=20000 && Number.isSafeInteger(v.height) && v.height>0 && v.height<=20000;
  const variants=[...(media.variants || []),{url:media.url,width:media.width,height:media.height},
    {url:media.cardUrl,width:media.cardWidth,height:media.cardHeight},
    {url:media.heroUrl,width:media.heroWidth,height:media.heroHeight}].map(v=>({...v,url:mediaUrl(v.url,media.url)})).filter(valid)
    .sort((a,b)=>a.width-b.width).filter((v,i,all)=>all.findIndex(other=>other.width===v.width)===i);
  const preferred=variants.find(v=>v.width>=(card?420:800)) || variants.at(-1) || {url:mediaUrl(media.url)};
  // A crop and an original with different aspect ratios are not interchangeable
  // resolution candidates: changing natural ratio after load would cause CLS.
  const responsive=variants.filter(v=>Math.abs(v.width/v.height-preferred.width/preferred.height)<0.01);
  return {...preferred,variants:responsive,sizes:card?CMS_CARD_SIZES:CMS_HERO_SIZES};
}
export function cmsImage(media, { eager = false, card = false, fallbackAlt = 'Article image' } = {}) {
  const source=cmsSources(media,{card});
  if(!source)return '';
  const dimensions=source.width && source.height ? `width="${source.width}" height="${source.height}"` : '';
  const responsive=source.variants.length ? `srcset="${source.variants.map(v=>`${escape(v.url)} ${v.width}w`).join(', ')}"` : '';
  return `<img class="cms-image" src="${escape(source.url)}" ${responsive} sizes="${source.sizes}" ${dimensions} alt="${escape(media.alt || fallbackAlt)}" loading="${eager?'eager':'lazy'}" ${eager?'fetchpriority="high"':''} decoding="async">`;
}
export function cmsPreload(media) {
  const source=cmsSources(media);
  return source ? `<link data-public-metadata rel="preload" as="image" href="${escape(source.url)}" imagesizes="${source.sizes}"${source.variants.length?` imagesrcset="${source.variants.map(v=>`${escape(v.url)} ${v.width}w`).join(', ')}"`:''} fetchpriority="high">` : '';
}

export function cmsFigure(media, options) {
  if (!cmsSources(media)) return '';
  const caption = [media.caption,media.credit ? `Credit: ${media.credit}` : ''].filter(Boolean).map(escape).join(' · ');
  return `<figure class="cms-figure newsroom-figure">${cmsImage(media,options)}${caption?`<figcaption>${caption}</figcaption>`:''}</figure>`;
}

export function bindCMSImages(root) {
  root.querySelectorAll('img.cms-image').forEach(image=>{
    if(image.dataset.errorBound)return;
    image.dataset.errorBound='true';
    const remove=()=>image.closest('.cms-figure,.newsroom-card-image')?.remove();
    image.addEventListener('error',remove,{once:true});
    if(image.complete && image.naturalWidth===0)remove();
  });
}
