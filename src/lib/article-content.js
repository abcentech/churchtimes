import { normalizePublicMedia } from './published-articles.js';
// Render supported Payload Lexical nodes. Raw HTML, unknown blocks and
// unpopulated uploads are omitted; only safe published-document media is shown.
const escape = text => String(text).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);

function safeLink(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

export function renderArticleContent(content, { baseUrl } = {}) {
  if (typeof content === 'string') {
    return content.trim().split(/\n\s*\n/).filter(Boolean).map(text => `<p>${escape(text)}</p>`).join('');
  }
  let remaining = 5000;
  function render(node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 30 || --remaining < 0) return '';
    if (node.type === 'text' && typeof node.text === 'string') {
      let text = escape(node.text);
      if (node.format & 1) text = `<strong>${text}</strong>`;
      if (node.format & 2) text = `<em>${text}</em>`;
      return text;
    }
    if (node.type === 'linebreak') return '<br>';
    if (node.type === 'upload' && node.relationTo === 'media') {
      const image = normalizePublicMedia(node.value, baseUrl);
      if (!image) return '';
      const dimensions = image.width && image.height ? `width="${image.width}" height="${image.height}"` : '';
      return `<figure><img src="${escape(image.url)}" alt="${escape(image.alt)}" ${dimensions} loading="lazy" decoding="async">${image.caption || image.credit ? `<figcaption>${escape(image.caption)}${image.credit ? ` · Photo: ${escape(image.credit)}` : ''}</figcaption>` : ''}</figure>`;
    }
    const supported = ['root', 'paragraph', 'heading', 'quote', 'list', 'listitem', 'link', 'autolink'];
    if (!supported.includes(node.type)) return '';
    const children = Array.isArray(node.children) ? node.children.map(child => render(child, depth + 1)).join('') : '';
    if (!children) return '';
    switch (node.type) {
      case 'paragraph': return `<p>${children}</p>`;
      case 'heading': {
        const tag = ['h2', 'h3', 'h4'].includes(node.tag) ? node.tag : 'h2';
        return `<${tag}>${children}</${tag}>`;
      }
      case 'quote': return `<blockquote>${children}</blockquote>`;
      case 'list': {
        const tag = node.listType === 'number' ? 'ol' : 'ul';
        return `<${tag}>${children}</${tag}>`;
      }
      case 'listitem': return `<li>${children}</li>`;
      case 'link':
      case 'autolink': {
        const url = safeLink(node.fields?.url ?? node.url);
        return url ? `<a href="${escape(url)}" rel="noopener noreferrer">${children}</a>` : children;
      }
      default: return children;
    }
  }
  return render(content?.root);
}
