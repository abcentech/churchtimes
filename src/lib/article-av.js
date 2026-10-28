import { mediaUrl } from './published-articles.js';
// Safe rendering of the CMS audioVideo block (contract v1.19). Never autoplays,
// never preloads media bytes, and only builds player URLs from CMS media urls.
const escape = v => String(v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const AV_TYPES = {video: ['video/mp4', 'video/webm'], audio: ['audio/mpeg', 'audio/mp4', 'audio/ogg']};
const text = (v, max) => typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max).replace(/[\uD800-\uDBFF]$/, '') : '';
function webLink(value) {
  if (typeof value !== 'string' || value.length > 2000 || /[\u0000-\u001f\u007f\s\\]/.test(value.trim())) return '';
  value = value.trim();
  if (value.startsWith('/')) return value.startsWith('//') ? '' : value;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}
const anchor = (href, label) => `<a href="${escape(href)}" rel="noopener noreferrer">${escape(label)}</a>`;

export function renderAudioVideo(fields, {baseUrl, inline = false} = {}) {
  if (!fields || typeof fields !== 'object') return '';
  const kind = fields.kind === 'audio' ? 'audio' : fields.kind === 'video' ? 'video' : '';
  if (!kind) return '';
  const title = text(fields.title, 120);
  const caption = text(fields.caption, 500);
  const media = fields.media;
  // A bare id (not public) renders nothing; only a populated media doc is playable.
  const isDoc = media && typeof media === 'object';
  const src = isDoc && AV_TYPES[kind].includes(media.mimeType) ? mediaUrl(media.url, baseUrl) : '';
  const legacy = media == null ? webLink(fields.sourceUrl) : '';
  const transcript = webLink(fields.transcriptUrl);
  const label = title || (kind === 'audio' ? 'Audio' : 'Video');
  if (!src && !legacy) return '';
  const links = [];
  if (!src && legacy) links.push(anchor(legacy, `${kind === 'audio' ? 'Listen' : 'Watch'}: ${label}`));
  if (transcript) links.push(anchor(transcript, 'Transcript'));
  if (inline) return links.length ? links.join(' ') : '';
  let player = '';
  if (src) {
    const poster = kind === 'video' && fields.poster && typeof fields.poster === 'object' && ['image/jpeg', 'image/png', 'image/webp'].includes(fields.poster.mimeType) ? mediaUrl(fields.poster.url, baseUrl) : '';
    player = `<${kind} controls preload="none" src="${escape(src)}"${poster ? ` poster="${escape(poster)}"` : ''} aria-label="${escape(label)}"></${kind}>`;
  }
  const head = title ? `<p class="cms-av-title">${escape(title)}</p>` : '';
  const cap = caption ? `<figcaption>${escape(caption)}</figcaption>` : '';
  const extra = links.length ? `<p class="cms-av-links">${links.join(' ')}</p>` : '';
  return `<figure class="cms-av cms-av-${kind}">${head}${player}${cap}${extra}</figure>`;
}
