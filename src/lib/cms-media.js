import { normalizePublicMedia } from './published-articles.js';
export { normalizePublicMedia };
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function cmsImage(media, { eager = false, card = false, fallbackAlt = 'Article image' } = {}) {
  if (!media) return '';
  const variants = [{url:media.url,width:media.width,height:media.height},
    {url:media.cardUrl,width:media.cardWidth,height:media.cardHeight},
    {url:media.heroUrl,width:media.heroWidth,height:media.heroHeight}]
    .filter((v,i,all)=>v.width && v.height && all.findIndex(item=>item.width===v.width)===i).sort((a,b)=>a.width-b.width);
  const preferred = {url:card ? media.cardUrl : media.heroUrl,
    width:card ? media.cardWidth : media.heroWidth, height:card ? media.cardHeight : media.heroHeight};
  const dimensions = preferred.width && preferred.height ? `width="${preferred.width}" height="${preferred.height}"` : '';
  const responsive = variants.length ? `srcset="${variants.map(v=>`${escape(v.url)} ${v.width}w`).join(', ')}"` : '';
  return `<img class="cms-image" src="${escape(preferred.url)}" ${responsive} sizes="${card?'(max-width: 760px) calc(100vw - 38px), 420px':'(max-width: 760px) calc(100vw - 38px), 1000px'}" ${dimensions} alt="${escape(media.alt || fallbackAlt)}" loading="${eager?'eager':'lazy'}" ${eager?'fetchpriority="high"':''} decoding="async">`;
}

export function cmsFigure(media, options) {
  if (!media) return '';
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
