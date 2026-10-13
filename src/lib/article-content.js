// Render a deliberately small subset of Payload Lexical content. Unknown nodes,
// uploads and embedded HTML are omitted until the backend contract defines them.
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

export function renderArticleContent(content) {
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
