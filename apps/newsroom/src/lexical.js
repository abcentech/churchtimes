/**
 * Markdown-subset <-> Payload Lexical rich text mapping (pure functions, no DOM).
 *
 * Supported: paragraphs (single newline = line break), headings h2/h3 (`## `, `### `; `# ` is read as h2),
 * block quotes (`> `), bullet lists (`- `), numbered lists (`1. `), **bold**, *italic*, [links](https://...).
 * Anything else found in an existing Lexical document (images, embeds, nested lists, underline, ...) sets
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
    if ((m = RE_H.exec(line))) {
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

export function markdownToLexical(markdown) {
  const blocks = parseMarkdown(markdown);
  const children = blocks.map(b => {
    switch (b.type) {
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
    default:
      state.lossy = true;
      return '';
  }
}

/**
 * @param {unknown} content Lexical document ({ root }) as returned by the CMS
 * @returns {{ markdown: string, lossy: boolean }}
 */
export function lexicalToMarkdown(content) {
  const state = { lossy: false };
  if (typeof content === 'string') return { markdown: content, lossy: false };
  let children = content?.root?.children;
  if (!Array.isArray(children)) return { markdown: '', lossy: false };
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
  return { markdown: blocks.filter(b => b !== '').join('\n\n'), lossy: state.lossy };
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

export function markdownToHtml(markdown) {
  return parseMarkdown(markdown).map(b => {
    switch (b.type) {
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
  const plain = String(markdown || '').replace(/[*#>\[\]()\\]/g, ' ').trim();
  return plain ? plain.split(/\s+/).length : 0;
}
