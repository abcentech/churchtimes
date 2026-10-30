// Pull quote and gallery Lexical blocks (apps/cms/docs/w12/schema-contract.md section 1.1). Text only, never HTML.
import {normalizePublicMedia,cmsImage} from './cms-media.js';
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const text=(value,max)=>typeof value==='string'?value.trim().slice(0,max):'';

export function renderPullQuote(fields) {
  const quote=text(fields?.quote,400),attribution=text(fields?.attribution,120);
  if(!quote)return '';
  return `<figure class="reader-pullquote"><blockquote><p>${escape(quote)}</p></blockquote>${attribution?`<figcaption>${escape(attribution)}</figcaption>`:''}</figure>`;
}

export function renderGallery(fields,{baseUrl}={}) {
  const rows=(Array.isArray(fields?.images)?fields.images:[]).slice(0,12).map(row=>({media:normalizePublicMedia(row?.image,baseUrl),caption:text(row?.caption,300)})).filter(row=>row.media);
  if(!rows.length)return '';
  const items=rows.map(({media,caption})=>{
    const note=[caption||media.caption,media.credit?`Credit: ${media.credit}`:''].filter(Boolean).map(escape).join(' · ');
    const image=cmsImage(media,{card:true,fallbackAlt:'Gallery photo'});
    return image?`<li><figure class="cms-figure">${image}${note?`<figcaption>${note}</figcaption>`:''}</figure></li>`:'';
  }).filter(Boolean);
  if(!items.length)return '';
  const label=items.length===1?'Gallery: 1 photo':`Gallery: ${items.length} photos`;
  return `<section class="reader-gallery" aria-label="${label}"><ul${items.length===1?' class="reader-gallery-single"':''}>${items.join('')}</ul></section>`;
}
