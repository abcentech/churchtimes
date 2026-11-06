// Data saver ("lite") markup, shared by the browser and the public host. Pure string functions.
// Preference: 'on' | 'off' stored in localStorage and a first-party cookie; unset means automatic (Save-Data).
export const LITE_KEY='ct-lite';
const cookiePref=cookie=>(/(?:^|;\s*)ct-lite=(on|off)(?:;|$)/.exec(cookie||'')||[])[1];
export function liteRequest(headers={}) {
  const pref=cookiePref(headers.cookie);
  return pref ? pref==='on' : /^on$/i.test(String(headers['save-data']||'').trim());
}
// The placeholder keeps the exact intrinsic ratio, so revealing the image never shifts layout.
export const litePlaceholder=(width,height)=>`data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${width} ${height}'/%3E`;
function liteImg(tag) {
  if(/\sdata-lite-src=/.test(tag))return tag;
  const src=/\ssrc="([^"]*)"/.exec(tag);
  if(!src||src[1].startsWith('data:'))return tag;
  const width=+(/\swidth="(\d+)"/.exec(tag)||[])[1]||4,height=+(/\sheight="(\d+)"/.exec(tag)||[])[1]||3;
  return tag.replace(/\ssrcset="/,' data-lite-srcset="').replace(src[0],()=>` src="${litePlaceholder(width,height)}" data-lite-src="${src[1]}"`).replace(/\sfetchpriority="high"/,'');
}
export function liteHTML(html) {
  return String(html).replace(/<link\b[^>]*\bas="image"[^>]*>/g,tag=>/\brel="preload"/.test(tag)?'':tag)
    .replace(/<source\b[^>]*>/g,tag=>tag.replace(/\ssrcset="/,' data-lite-srcset="'))
    .replace(/<img\b[^>]*>/g,liteImg);
}
