const text = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dimension = value => Number.isSafeInteger(value) && value > 0 && value <= 20000 ? value : null;

export function publicMediaURL(value, baseUrl) {
  if (typeof value !== 'string' || !value.trim()) return '';
  value=value.trim();
  if(value.startsWith('//'))return '';
  try {
    const base = baseUrl ? new URL(baseUrl).origin : undefined;
    const url = new URL(value, base);
    const local = ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
    return (url.protocol === 'https:' || (url.protocol === 'http:' && local)) &&
      !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

export function normalizePublicMedia(value, baseUrl) {
  if (!value || typeof value !== 'object' || !['image/jpeg','image/png','image/webp'].includes(value.mimeType)) return null;
  const url = publicMediaURL(value.url, baseUrl);
  const width = dimension(value.width), height = dimension(value.height);
  if (!url || !width || !height) return null;
  const variants = [{ url, width, height }];
  for (const name of ['thumbnail','card','hero']) {
    const size = value.sizes?.[name];
    const variantURL = publicMediaURL(size?.url, baseUrl);
    if (variantURL && dimension(size.width) && dimension(size.height) && !variants.some(v => v.width === size.width)) {
      variants.push({url:variantURL,width:size.width,height:size.height});
    }
  }
  return {url,width,height,alt:text(value.alt,300),caption:text(value.caption,1000),credit:text(value.credit,200),variants:variants.sort((a,b)=>a.width-b.width)};
}

export function cmsImage(media, { eager = false, card = false, fallbackAlt = 'Article image' } = {}) {
  if (!media) return '';
  const preferred = card ? media.variants.find(v=>v.width>=800) || media.variants.at(-1) : media.variants.at(-1);
  return `<img class="cms-image" src="${escape(preferred.url)}" srcset="${media.variants.map(v=>`${escape(v.url)} ${v.width}w`).join(', ')}" sizes="${card?'(max-width: 760px) calc(100vw - 38px), 420px':'(max-width: 760px) calc(100vw - 38px), 1000px'}" width="${preferred.width}" height="${preferred.height}" alt="${escape(media.alt || fallbackAlt)}" loading="${eager?'eager':'lazy'}" ${eager?'fetchpriority="high"':''} decoding="async">`;
}

export function cmsFigure(media, options) {
  if (!media) return '';
  const caption = [media.caption,media.credit ? `Credit: ${media.credit}` : ''].filter(Boolean).map(escape).join(' · ');
  return `<figure class="cms-figure">${cmsImage(media,options)}${caption?`<figcaption>${caption}</figcaption>`:''}</figure>`;
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
