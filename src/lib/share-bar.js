import {socialIcon} from './social-links.js';
// Plain share links: no third-party scripts, nothing loaded until a reader follows a link.
const esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function shareTargets({title,url}) {
  const t=encodeURIComponent(title),u=encodeURIComponent(url);
  return [
    {id:'facebook',name:'Facebook',href:`https://www.facebook.com/sharer/sharer.php?u=${u}`},
    {id:'x',name:'X',href:`https://twitter.com/intent/tweet?text=${t}&url=${u}`},
    {id:'whatsapp',name:'WhatsApp',href:`https://wa.me/?text=${encodeURIComponent(`${title} ${url}`)}`},
    {id:'telegram',name:'Telegram',href:`https://t.me/share/url?url=${u}&text=${t}`},
    {id:'linkedin',name:'LinkedIn',href:`https://www.linkedin.com/sharing/share-offsite/?url=${u}`},
    {id:'email',name:'Email',href:`mailto:?subject=${t}&body=${encodeURIComponent(`${title}\n\n${url}`)}`,external:false},
  ];
}
export function shareBarHTML({title,url}) {
  const links=shareTargets({title,url}).map(l=>`<li><a href="${esc(l.href)}"${l.external===false?'':' target="_blank" rel="noopener noreferrer"'} aria-label="Share on ${l.name}" title="${l.name}">${socialIcon(l.id)}</a></li>`).join('');
  return `<section class="share-bar" aria-labelledby="share-bar-title" data-share-bar data-share-title="${esc(title)}" data-share-url="${esc(url)}"><h2 id="share-bar-title">Share this story</h2><ul>${links}<li><button type="button" data-share-native hidden aria-label="Share using your device">${socialIcon('share')}</button></li><li><button type="button" data-share-copy aria-label="Copy link">${socialIcon('link')}</button></li></ul><p class="share-status" role="status" aria-live="polite" data-share-status></p></section>`;
}
export function bindShareBar(root,nav=globalThis.navigator) {
  const bar=root?.querySelector?.('[data-share-bar]');
  if(!bar)return;
  const {shareTitle:title,shareUrl:url}=bar.dataset,status=bar.querySelector('[data-share-status]');
  const native=bar.querySelector('[data-share-native]');
  if(nav?.share)native.hidden=false;
  native.addEventListener('click',()=>nav.share({title,url}).catch(()=>{}));
  bar.querySelector('[data-share-copy]').addEventListener('click',async()=>{
    try {await nav.clipboard.writeText(url);status.textContent='Link copied.';}
    catch {status.textContent='Copy is unavailable. Copy the address from your browser.';}
  });
}
