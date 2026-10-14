/**
 * Markdown-subset <-> Payload Lexical rich text mapping (pure functions, no DOM).
 *
 * Supported: paragraphs (single newline = line break), headings h2/h3 (`## `, `### `; `# ` is read as h2),
 * block quotes (`> `), bullet lists (`- `), numbered lists (`1. `), **bold**, *italic*, [links](https://...).
 * Images inside the body: a line of its own `![alt](media:<id>)` <-> Payload upload node
 * `{ type: 'upload', relationTo: 'media', value: <numeric id>, fields: null, format: '', id, version: 3 }`.
 * The alt in the token is only a label for the writer; the real alt text lives on the media record.
 * Anything else found in an existing Lexical document (embeds, nested lists, underline, uploads with extra data, ...) sets
 * `lossy: true` so the editor can refuse to rewrite a body it cannot represent faithfully.
 *
 * Output node shapes match what Payload's Lexical editor and the public site renderer (src/lib/article-content.js) read.
 */

const FORMAT_BOLD = 1;
const FORMAT_ITALIC = 2;
const SUPPORTED_FORMATS = FORMAT_BOLD | FORMAT_ITALIC;

const SAFE_URL = /^(https?:\/\/|mailto:)[^\s<>"']+$/i;

export function isSafeUrl(url) {
  return typeof url === 'string' && SAFE_URL.test(url);
}

// ---------------------------------------------------------------------------------------------------------
// Image token: `![alt](media:<id>)` alone on a line
// ---------------------------------------------------------------------------------------------------------

const IMAGE_LINE_RE = /^!\[((?:\\.|[^\]\\\n])*)\]\(media:(\d{1,15})\)$/;
const MEDIA_ID_RE = /^\d{1,15}$/;
export const UPLOAD_NODE_VERSION = 3;

/** One-line, bracket-safe label for the token (the CMS media record stays the source of truth for alt text). */
function tokenAlt(alt) {
  return String(alt ?? '').replace(/\s+/g, ' ').trim().slice(0, 300).replace(/([\\*\[\]])/g, '\\$1');
}

/** @returns {string} the markdown line for a media id, or '' when the id is not a positive integer. */
export function imageToken(id, alt = '') {
  const s = String(id ?? '');
  if (!MEDIA_ID_RE.test(s) || Number(s) < 1) return '';
  return `![${tokenAlt(alt)}](media:${Number(s)})`;
}

/** Every image token line in a markdown body, in order: [{ id: '5', alt: 'label' }]. */
export function listImages(markdown) {
  const out = [];
  for (const raw of String(markdown || '').replace(/\r\n?/g, '\n').split('\n')) {
    const m = IMAGE_LINE_RE.exec(raw.trim());
    if (m) out.push({ id: String(Number(m[2])), alt: m[1].replace(/\\(.)/g, '$1') });
  }
  return out;
}

/**
 * The body with every image label emptied (`![](media:5)`): the label is display-only, so two bodies that differ
 * only in labels are the same document. Used to decide whether the body was edited.
 */
export function stripImageLabels(markdown) {
  return String(markdown || '').split('\n').map(line => {
    const m = IMAGE_LINE_RE.exec(line.trim());
    return m ? `![](media:${Number(m[2])})` : line;
  }).join('\n');
}

/** Remove the n-th (0-based) image token line from a markdown body, and the blank line it leaves behind. */
export function removeImageLine(markdown, index) {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  let seen = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!IMAGE_LINE_RE.test(lines[i].trim())) continue;
    if (++seen !== index) continue;
    lines.splice(i, 1);
    if (lines[i] === '' && (i === 0 || lines[i - 1] === '')) lines.splice(i, 1);
    break;
  }
  return lines.join('\n');
}

/**
 * Text-model edit: put `line` on its own line at the cursor/selection of `value` (blank line before and after so
 * it can never merge into a paragraph). Returns the new value and the caret position after the inserted block.
 */
export function insertBlockLine(value, start, end, line) {
  const v = String(value ?? '');
  const a = Math.max(0, Math.min(Number.isFinite(start) ? start : v.length, v.length));
  const b = Math.max(a, Math.min(Number.isFinite(end) ? end : a, v.length));
  const before = v.slice(0, a);
  const after = v.slice(b);
  const lead = !before ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const trail = !after ? '\n\n' : after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
  const inserted = `${lead}${line}${trail}`;
  return { value: before + inserted + after, caret: before.length + inserted.length };
}

// ---------------------------------------------------------------------------------------------------------
// Markdown -> AST
// ---------------------------------------------------------------------------------------------------------

// Alternatives in priority order: 1 escape, 2+3 link text/url, 4 bold+italic, 5 bold, 6 italic.
// Every span body consumes backslash escapes as a unit (`\\.`), so an escaped `*`, `]` or `\` can never open or
// close a span, and `***x***` (format 3) is matched before `**`.
const INLINE_RE = /\\([\\`*_{}\[\]()#+\-.!>~|])|\[((?:\\.|[^\]\\\n])+)\]\(([^)\s]+)\)|\*\*\*((?:\\.|[^\\\n])+?)\*\*\*|\*\*((?:\\.|[^\\\n])+?)\*\*|\*((?:\\.|[^*\\\n])+?)\*/;

function pushText(out, text, fmt) {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.t === 'text' && last.fmt === fmt) last.text += text;
  else out.push({ t: 'text', text, fmt });
}

function parseInline(src, fmt = 0, out = []) {
  let rest = src;
  while (rest) {
    const m = INLINE_RE.exec(rest);
    if (!m) {
      pushText(out, rest, fmt);
      break;
    }
    pushText(out, rest.slice(0, m.index), fmt);
    if (m[1] !== undefined) {
      pushText(out, m[1], fmt);
    } else if (m[2] !== undefined) {
      if (isSafeUrl(m[3])) {
        const children = parseInline(m[2], fmt, []);
        out.push({ t: 'link', url: m[3], children });
      } else {
        pushText(out, m[0], fmt);
      }
    } else if (m[4] !== undefined) {
      parseInline(m[4], fmt | FORMAT_BOLD | FORMAT_ITALIC, out);
    } else if (m[5] !== undefined) {
      parseInline(m[5], fmt | FORMAT_BOLD, out);
    } else if (m[6] !== undefined) {
      parseInline(m[6], fmt | FORMAT_ITALIC, out);
    }
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

function parseLines(lines) {
  const out = [];
  lines.forEach((line, i) => {
    if (i > 0) out.push({ t: 'br' });
    parseInline(line, 0, out);
  });
  return out;
}

const RE_H = /^(#{1,3})\s+(.*)$/;
const RE_QUOTE = /^>\s?(.*)$/;
const RE_UL = /^[-*+]\s+(.*)$/;
const RE_OL = /^\d+[.)]\s+(.*)$/;

export function parseMarkdown(markdown) {
  const text = String(markdown || '').replace(/\r\n?/g, '\n');
  const blocks = [];
  let para = [];
  let list = null;
  let quote = null;

  const flushPara = () => {
    if (para.length) blocks.push({ type: 'p', inline: parseLines(para) });
    para = [];
  };
  const flushList = () => {
    if (list) blocks.push(list);
    list = null;
  };
  const flushQuote = () => {
    if (quote) blocks.push({ type: 'quote', inline: parseLines(quote) });
    quote = null;
  };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); };

  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { flushAll(); continue; }

    let m;
    if ((m = IMAGE_LINE_RE.exec(line.trim()))) {
      flushAll();
      blocks.push({ type: 'image', id: Number(m[2]), alt: m[1].replace(/\\(.)/g, '$1') });
    } else if ((m = RE_H.exec(line))) {
      flushAll();
      blocks.push({ type: m[1].length >= 3 ? 'h3' : 'h2', inline: parseInline(m[2]) });
    } else if ((m = RE_QUOTE.exec(line))) {
      flushPara(); flushList();
      (quote ||= []).push(m[1]);
    } else if ((m = RE_UL.exec(line))) {
      flushPara(); flushQuote();
      if (!list || list.type !== 'ul') { flushList(); list = { type: 'ul', items: [] }; }
      list.items.push(parseInline(m[1]));
    } else if ((m = RE_OL.exec(line))) {
      flushPara(); flushQuote();
      if (!list || list.type !== 'ol') { flushList(); list = { type: 'ol', items: [] }; }
      list.items.push(parseInline(m[1]));
    } else {
      flushList(); flushQuote();
      para.push(line);
    }
  }
  flushAll();
  return blocks;
}

// ---------------------------------------------------------------------------------------------------------
// AST -> Lexical
// ---------------------------------------------------------------------------------------------------------

const baseElement = (type, children, extra = {}) => ({
  children,
  direction: 'ltr',
  format: '',
  indent: 0,
  type,
  version: 1,
  ...extra
});

function textNode(text, fmt) {
  return { detail: 0, format: fmt, mode: 'normal', style: '', text, type: 'text', version: 1 };
}

function inlineToLexical(nodes) {
  return nodes.map(n => {
    if (n.t === 'br') return { type: 'linebreak', version: 1 };
    if (n.t === 'link') {
      return baseElement('link', inlineToLexical(n.children), {
        version: 3,
        fields: { linkType: 'custom', newTab: false, url: n.url }
      });
    }
    return textNode(n.text, n.fmt);
  });
}

/** 24-hex node id (Payload uses ObjectId-style strings): stable per (media, occurrence) so re-saving never churns ids. */
function uploadNodeId(mediaId, occurrence) {
  let out = '';
  for (let seed = 1; seed <= 3; seed++) {
    let h = 0x811c9dc5 ^ (seed * 0x9e3779b1);
    for (const ch of `${mediaId}:${occurrence}:${seed}`) {
      h ^= ch.charCodeAt(0);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, '0');
  }
  return out.slice(0, 24);
}

function uploadNode(mediaId, occurrence) {
  return {
    format: '',
    id: uploadNodeId(mediaId, occurrence),
    fields: null,
    relationTo: 'media',
    type: 'upload',
    value: mediaId,
    version: UPLOAD_NODE_VERSION
  };
}

export function markdownToLexical(markdown) {
  const blocks = parseMarkdown(markdown);
  const seen = new Map();
  const children = blocks.map(b => {
    switch (b.type) {
      case 'image': {
        const n = seen.get(b.id) || 0;
        seen.set(b.id, n + 1);
        return uploadNode(b.id, n);
      }
      case 'h2':
      case 'h3':
        return baseElement('heading', inlineToLexical(b.inline), { tag: b.type });
      case 'quote':
        return baseElement('quote', inlineToLexical(b.inline));
      case 'ul':
      case 'ol':
        return baseElement(
          'list',
          b.items.map((item, i) => baseElement('listitem', inlineToLexical(item), { value: i + 1 })),
          { listType: b.type === 'ol' ? 'number' : 'bullet', start: 1, tag: b.type }
        );
      default:
        return baseElement('paragraph', inlineToLexical(b.inline), { textFormat: 0, textStyle: '' });
    }
  });
  if (!children.length) children.push(baseElement('paragraph', [], { textFormat: 0, textStyle: '' }));
  return { root: baseElement('root', children) };
}

// ---------------------------------------------------------------------------------------------------------
// Lexical -> Markdown
// ---------------------------------------------------------------------------------------------------------

function escapeText(text) {
  return String(text).replace(/([\\*\[\]])/g, '\\$1');
}

/** Escape a line start that would otherwise be read back as a block marker. */
function escapeLineStart(line) {
  return line.replace(/^(\s*)(#{1,3}\s|>|[-*+]\s|\d+[.)]\s)/, (_, ws, marker) => `${ws}\\${marker}`);
}

const isDefaultAlign = v => v === undefined || v === null || v === '' || v === 0 || v === 'left';

/** Element-level formatting the markdown subset cannot express (alignment, indent). */
function checkElement(node, state) {
  if (!isDefaultAlign(node.format)) state.lossy = true;
  if (Number(node.indent) || 0) state.lossy = true;
}

/** Merge adjacent text nodes with identical formatting so `**a****b**` is never written. */
function coalesceText(nodes) {
  const out = [];
  for (const node of nodes || []) {
    const last = out[out.length - 1];
    if (node?.type === 'text' && last?.type === 'text'
      && (Number(node.format) || 0) === (Number(last.format) || 0) && (node.style || '') === (last.style || '')) {
      out[out.length - 1] = { ...last, text: (last.text || '') + (node.text || '') };
    } else {
      out.push(node);
    }
  }
  return out;
}

function inlineToMarkdown(nodes, state) {
  let out = '';
  for (const node of coalesceText(nodes)) {
    if (!node || typeof node !== 'object') continue;
    switch (node.type) {
      case 'text': {
        const fmt = Number(node.format) || 0;
        if (fmt & ~SUPPORTED_FORMATS) state.lossy = true;
        if (node.style) state.lossy = true;
        let t = escapeText(node.text || '');
        if (!t) break;
        if ((fmt & FORMAT_BOLD) && (fmt & FORMAT_ITALIC)) t = `***${t}***`;
        else if (fmt & FORMAT_BOLD) t = `**${t}**`;
        else if (fmt & FORMAT_ITALIC) t = `*${t}*`;
        out += t;
        break;
      }
      case 'linebreak':
        out += '\n';
        break;
      case 'link':
      case 'autolink': {
        const url = node.fields?.url ?? node.url;
        const inner = inlineToMarkdown(node.children, state);
        const f = node.fields || {};
        if (f.newTab || f.rel || (f.linkType && f.linkType !== 'custom')) state.lossy = true;
        if (inner && isSafeUrl(url) && !/[()]/.test(url)) out += `[${inner}](${url})`;
        else { state.lossy = true; out += inner; }
        break;
      }
      default:
        state.lossy = true;
    }
  }
  return out;
}

/** Headings and list items are single-line in markdown: a line break would be flattened to a space. */
function singleLine(text, state) {
  if (text.includes('\n') || !text.trim()) state.lossy = true; // (an empty heading/item would not re-parse as one)
  return text.replace(/\n/g, ' ');
}

function blockToMarkdown(node, state, { onlyBlock = false } = {}) {
  checkElement(node, state);
  switch (node.type) {
    case 'paragraph': {
      const text = inlineToMarkdown(node.children, state);
      if (!text.trim() && !onlyBlock) state.lossy = true; // an empty paragraph is not representable (it would vanish)
      return text.split('\n').map(escapeLineStart).join('\n');
    }
    case 'heading': {
      if (node.tag !== 'h2' && node.tag !== 'h3') state.lossy = true;
      const prefix = node.tag === 'h3' ? '### ' : '## ';
      return prefix + singleLine(inlineToMarkdown(node.children, state), state);
    }
    case 'quote':
      return inlineToMarkdown(node.children, state).split('\n').map(l => `> ${l}`).join('\n');
    case 'list': {
      const ordered = node.listType === 'number';
      if (node.listType !== 'bullet' && !ordered) state.lossy = true;
      if (ordered && node.start !== undefined && node.start !== null && Number(node.start) !== 1) state.lossy = true;
      return (node.children || []).map((item, i) => {
        if (item.type !== 'listitem') { state.lossy = true; return ''; }
        checkElement(item, state);
        if (item.checked !== undefined && item.checked !== null) state.lossy = true; // checklist item
        const inlineKids = [];
        for (const k of item.children || []) {
          if (k.type === 'list') state.lossy = true; // nested list
          else inlineKids.push(k);
        }
        const marker = ordered ? `${i + 1}. ` : '- ';
        return marker + singleLine(inlineToMarkdown(inlineKids, state), state);
      }).filter(Boolean).join('\n');
    }
    case 'upload': {
      const info = uploadInfo(node);
      if (!info) {
        state.lossy = true;
        return '';
      }
      state.images.push({ id: info.id, alt: info.alt, media: info.media });
      return imageToken(info.id, info.alt);
    }
    default:
      state.lossy = true;
      return '';
  }
}

/**
 * Reads a Payload upload node. `value` may be the media id (number or numeric string) or the populated media document.
 * Anything the token cannot carry (another collection, node-level fields, pending uploads) returns null => lossy.
 */
function uploadInfo(node) {
  if (node.relationTo !== 'media' || node.pending) return null;
  if (node.fields !== undefined && node.fields !== null
    && !(typeof node.fields === 'object' && !Array.isArray(node.fields) && Object.keys(node.fields).length === 0)) return null;
  const v = node.value;
  const populated = v && typeof v === 'object' ? v : null;
  const rawId = populated ? populated.id : v;
  if (typeof rawId !== 'number' && typeof rawId !== 'string') return null;
  const id = String(rawId);
  if (!MEDIA_ID_RE.test(id) || Number(id) < 1) return null;
  return { id: String(Number(id)), alt: populated && typeof populated.alt === 'string' ? populated.alt : '', media: populated };
}

/**
 * @param {unknown} content Lexical document ({ root }) as returned by the CMS
 * @returns {{ markdown: string, lossy: boolean, images: { id: string, alt: string, media: object|null }[] }}
 *   `images`: the body's upload nodes in order (`media` is the populated document when the CMS sent one)
 */
export function lexicalToMarkdown(content) {
  const state = { lossy: false, images: [] };
  if (typeof content === 'string') return { markdown: content, lossy: false, images: [] };
  let children = content?.root?.children;
  if (!Array.isArray(children)) return { markdown: '', lossy: false, images: [] };
  // Payload's own editor usually leaves a blank paragraph at the end; trailing blank paragraphs carry no content, so drop them
  // instead of making the whole body read-only. Blank paragraphs between content still count as lossy.
  const isBlankParagraph = n => n?.type === 'paragraph' && !(n.children || []).some(c => c?.type !== 'text' || String(c.text || '').trim());
  let end = children.length;
  while (end > 1 && isBlankParagraph(children[end - 1])) end--;
  children = children.slice(0, end);
  const blocks = [];
  for (const child of children) {
    const md = blockToMarkdown(child, state, { onlyBlock: children.length === 1 });
    if (md !== '' || child.type !== 'paragraph') blocks.push(md);
  }
  return { markdown: blocks.filter(b => b !== '').join('\n\n'), lossy: state.lossy, images: state.images };
}

// ---------------------------------------------------------------------------------------------------------
// AST -> safe HTML (editor preview). Every text segment goes through escapeHtmlLocal.
// ---------------------------------------------------------------------------------------------------------

const escapeHtmlLocal = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');

function inlineToHtml(nodes) {
  return nodes.map(n => {
    if (n.t === 'br') return '<br>';
    if (n.t === 'link') return `<a href="${escapeHtmlLocal(n.url)}" rel="noopener noreferrer" target="_blank">${inlineToHtml(n.children)}</a>`;
    let t = escapeHtmlLocal(n.text);
    if (n.fmt & FORMAT_BOLD) t = `<strong>${t}</strong>`;
    if (n.fmt & FORMAT_ITALIC) t = `<em>${t}</em>`;
    return t;
  }).join('');
}

/**
 * @param {string} markdown
 * @param {{ media?: (id: string) => ({ url?: string, thumbUrl?: string, alt?: string } | null | undefined) }} [options]
 *   `media` resolves an image token to an already URL-checked media view-model; unknown ids render as a text label.
 */
export function markdownToHtml(markdown, { media } = {}) {
  return parseMarkdown(markdown).map(b => {
    switch (b.type) {
      case 'image': {
        const m = media ? media(String(b.id)) : null;
        const src = m && (m.url || m.thumbUrl);
        const label = (m && m.alt) || b.alt || '';
        return src
          ? `<figure class="preview-inline-figure" data-testid="preview-inline-image" data-media-id="${b.id}"><img src="${escapeHtmlLocal(src)}" alt="${escapeHtmlLocal(label)}" class="preview-inline-img"><figcaption>${escapeHtmlLocal(label)}</figcaption></figure>`
          : `<figure class="preview-inline-figure preview-inline-missing" data-testid="preview-inline-image" data-media-id="${b.id}"><figcaption>Image #${b.id}${label ? `: ${escapeHtmlLocal(label)}` : ''}</figcaption></figure>`;
      }
      case 'h2': return `<h2>${inlineToHtml(b.inline)}</h2>`;
      case 'h3': return `<h3>${inlineToHtml(b.inline)}</h3>`;
      case 'quote': return `<blockquote>${inlineToHtml(b.inline)}</blockquote>`;
      case 'ul':
      case 'ol': return `<${b.type}>${b.items.map(i => `<li>${inlineToHtml(i)}</li>`).join('')}</${b.type}>`;
      default: return `<p>${inlineToHtml(b.inline)}</p>`;
    }
  }).join('');
}

export function countWords(markdown) {
  const plain = String(markdown || '')
    .replace(/^[ \t]*!\[(?:\\.|[^\]\\\n])*\]\(media:\d{1,15}\)[ \t]*$/gm, ' ')
    .replace(/[*#>\[\]()\\]/g, ' ').trim();
  return plain ? plain.split(/\s+/).length : 0;
}
