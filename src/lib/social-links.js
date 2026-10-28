// Single source of truth for Church Times Nigeria's official social pages. Edit here only.
// Verification status (owner-supplied 2026-10-28):
//  - facebook: owner gave web.facebook.com/churchtimes.nigeria; the www host is used as canonical. Not verified by us.
//  - whatsapp: this is a GROUP INVITE link (chat.whatsapp.com), not a whatsapp.com/channel/ broadcast channel.
//  - x, instagram, youtube, telegram, tiktok: handle "churchtimesng" was owner-supplied (corrected from "churchtimes") and is not verified by us (UNVERIFIED HANDLE).
export const SOCIAL_LINKS=[
  {id:'facebook',name:'Facebook',url:'https://www.facebook.com/churchtimes.nigeria'},
  {id:'x',name:'X',url:'https://x.com/churchtimesng',unverified:true},
  {id:'instagram',name:'Instagram',url:'https://www.instagram.com/churchtimesng/',unverified:true},
  {id:'youtube',name:'YouTube',url:'https://www.youtube.com/@churchtimesng',unverified:true},
  {id:'whatsapp',name:'WhatsApp',url:'https://chat.whatsapp.com/H3BOK96gdA7LZTKbMaTsKc'},
  {id:'telegram',name:'Telegram',url:'https://t.me/churchtimesng',unverified:true},
  {id:'tiktok',name:'TikTok',url:'https://www.tiktok.com/@churchtimesng',unverified:true},
];
export const SOCIAL_SAME_AS=SOCIAL_LINKS.map(link=>link.url);
// Inline 24x24 glyphs (no icon font, no remote assets). They inherit currentColor.
export const SOCIAL_ICONS={
  facebook:'<path fill="currentColor" d="M14 8V6.5c0-.7.2-1 1-1h2V2h-3c-3 0-4.5 1.8-4.5 4.5V8H7v3.5h2.5V22H14V11.5h2.8L17.5 8z"/>',
  x:'<path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>',
  instagram:'<rect x="3" y="3" width="18" height="18" rx="5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="17.5" cy="6.5" r="1.2" fill="currentColor"/>',
  youtube:'<rect x="2" y="5" width="20" height="14" rx="4" fill="none" stroke="currentColor" stroke-width="2"/><path fill="currentColor" d="m10 9 5 3-5 3z"/>',
  whatsapp:'<path fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" d="M3 21l1.6-4.6A8.5 8.5 0 1 1 8 19.6z"/><path fill="currentColor" d="M9 8c-.5.5-.7 1.3-.2 2.3 1 2 2.6 3.4 4.6 4.2 1 .4 1.7 0 2.1-.6l.2-.7-1.8-.9-.8.8c-1-.4-1.9-1.3-2.4-2.3l.6-.8-.8-1.7z"/>',
  telegram:'<path fill="currentColor" d="M21.5 3 2.5 10.5l5.5 2L19 6l-9 8.5V20l3-3.5 4.5 3.5z"/>',
  tiktok:'<path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M15 3v11.2a3.7 3.7 0 1 1-3.7-3.7M15 3c.3 2.6 2 4.3 4.5 4.6"/>',
  linkedin:'<rect x="3" y="9" width="4" height="12" fill="currentColor"/><circle cx="5" cy="5" r="2.2" fill="currentColor"/><path fill="currentColor" d="M10 9h3.8v1.8c.6-1.1 1.9-2 3.7-2 3 0 3.5 2 3.5 4.6V21h-4v-6.2c0-1.3-.2-2.4-1.6-2.4S14 13.5 14 14.8V21h-4z"/>',
  email:'<rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path fill="none" stroke="currentColor" stroke-width="2" d="m3 7 9 6 9-6"/>',
  link:'<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  share:'<g fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m9 10 6-3M9 14l6 3"/></g>',
};
export const socialIcon=id=>`<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">${SOCIAL_ICONS[id]}</svg>`;
const esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function socialLinksHTML(links=SOCIAL_LINKS) {
  return `<ul class="social-links">${links.map(l=>`<li><a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer me" aria-label="Church Times Nigeria on ${esc(l.name)}">${socialIcon(l.id)}</a></li>`).join('')}</ul>`;
}
