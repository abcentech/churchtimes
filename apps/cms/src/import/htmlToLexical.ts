import { createHash } from 'node:crypto'

import { type DefaultTreeAdapterMap, parseFragment, Tokenizer, TokenizerMode } from 'parse5'

import { stripShortcodes, sanitizeLegacyLinks } from '../lib/legacyContent'
import { findEmbedProblem, YOUTUBE_BLOCK_SLUG, YOUTUBE_ID_RE, YOUTUBE_TITLE_MAX, youtubeTitleProblem } from '../lib/lexicalEmbeds'

/**
 * Safe converter from WordPress post HTML (Gutenberg block markup and classic-editor HTML) to the serialized Lexical
 * JSON the CMS stores and the public renderer reads (go-live contract C1).
 *
 * Pure: no database, no network, no file access. The HTML is read with parse5 (a real, spec-compliant parser); nothing
 * here parses markup with a regular expression. Only these node shapes are ever written: paragraph, heading (h2 to h4),
 * quote, list/listitem, link, text, linebreak, upload (relationTo media), table/tablerow/tablecell and the registered
 * `youtubeEmbed` block. Raw HTML, styles, event handlers and unknown attributes are never carried over.
 *
 * Everything lossy is listed in `report`. Hard limits: input size, element depth (a deeper subtree is flattened to
 * plain text and reported), output node count and table size. Exceeding the input or node limit throws
 * `HtmlConversionError` (nothing is silently truncated).
 */

type Elem = DefaultTreeAdapterMap['element']
type ChildNode = DefaultTreeAdapterMap['childNode']
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>
export type LexicalNode = Json

export type ResolveImage = (src: string, context: { alt: string; caption: string; articleTitle?: string }) => { mediaId: number } | null

export type HtmlToLexicalOptions = {
  /** Host names of the old site (see `sanitizeLegacyLinks`). */
  oldHosts: readonly string[]
  /** Old WordPress slug -> new slug. */
  slugMap: ReadonlyMap<string, string> | Readonly<Record<string, string>>
  resolveImage: ResolveImage
  /** Extra shortcode names to remove (merged with the C1 defaults). */
  knownShortcodes?: readonly string[]
  articleTitle?: string
  /** New root-relative article path, default `/article/<slug>`. */
  articlePath?: (slug: string) => string
  /** Default 5 MB. */
  maxInputBytes?: number
  /** Element nesting past this is flattened to text. Default and maximum 64. */
  maxDepth?: number
  /** Default 20 000 output nodes (the public renderer reads at most 5 000 per article). */
  maxNodes?: number
}

export const DEFAULT_MAX_INPUT_BYTES = 5 * 1024 * 1024
export const DEFAULT_MAX_DEPTH = 64
export const DEFAULT_MAX_NODES = 20_000
export const TABLE_MAX_ROWS = 100
export const TABLE_MAX_COLS = 20
export const SPAN_MAX = 20
/** Nested list levels kept (the renderer reads 30 levels; the body depth rule is 64 levels in all). */
export const LIST_MAX_DEPTH = 6

export class HtmlConversionError extends Error {
  constructor(
    public readonly code: 'input-too-large' | 'too-deep' | 'too-many-nodes' | 'invalid-output',
    message: string,
  ) {
    super(message)
    this.name = 'HtmlConversionError'
  }
}

/**
 * parse5 builds the tree with a cost that grows roughly with the square of the nesting (about 4 s for 10 000 nested
 * `div`s, 15 s for nested lists), so a hostile input is refused BEFORE parsing when its element nesting is deeper than
 * this. Nesting between `maxDepth` (64) and this limit is parsed and flattened to text, and reported.
 */
export const MAX_PARSE_DEPTH = 512

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr', 'basefont', 'bgsound', 'frame', 'keygen'])
/** Tags whose end tag is optional (the parser closes them itself) and which cannot nest without a counted ancestor. */
const OPTIONAL_END_TAGS = new Set(['p', 'li', 'dt', 'dd', 'tr', 'td', 'th', 'tbody', 'thead', 'tfoot', 'option', 'optgroup', 'colgroup', 'caption', 'html', 'head', 'body'])

/** Linear scan with parse5's tokenizer (no tree): throws when element nesting could exceed `MAX_PARSE_DEPTH`. */
function assertParseDepth(html: string): void {
  const stack: string[] = []
  const counts = new Map<string, number>()
  let tooDeep = false
  const tokenizer: Tokenizer = new Tokenizer(
    {},
    {
      onComment() {},
      onDoctype() {},
      onEof() {},
      onCharacter() {},
      onNullCharacter() {},
      onWhitespaceCharacter() {},
      onStartTag(token) {
        const name = token.tagName
        // raw-text elements: their content is text, not tags (the parser switches the tokenizer the same way)
        if (name === 'script') tokenizer.state = TokenizerMode.SCRIPT_DATA
        else if (name === 'style' || name === 'xmp' || name === 'iframe' || name === 'noembed' || name === 'noframes' || name === 'noscript') tokenizer.state = TokenizerMode.RAWTEXT
        else if (name === 'title' || name === 'textarea') tokenizer.state = TokenizerMode.RCDATA
        else if (name === 'plaintext') tokenizer.state = TokenizerMode.PLAINTEXT
        if (token.selfClosing || VOID_TAGS.has(name) || OPTIONAL_END_TAGS.has(name)) return
        stack.push(name)
        counts.set(name, (counts.get(name) ?? 0) + 1)
        if (stack.length > MAX_PARSE_DEPTH) {
          tooDeep = true
          tokenizer.pause()
        }
      },
      onEndTag(token) {
        const name = token.tagName
        if ((counts.get(name) ?? 0) === 0) return
        for (;;) {
          const top = stack.pop() as string
          counts.set(top, (counts.get(top) ?? 1) - 1)
          if (top === name) break
        }
      },
    },
  )
  tokenizer.write(html, true)
  if (tooDeep) {
    throw new HtmlConversionError('too-deep', `The HTML nests elements more than ${MAX_PARSE_DEPTH} levels deep; it is refused.`)
  }
}

export type ConversionReport = {
  inputBytes: number
  nodeCount: number
  entitiesDecoded: number
  /** Removed shortcode markers by tag name. */
  shortcodesRemoved: Record<string, number>
  links: {
    rewritten: number
    unmapped: { url: string; reason: string }[]
    converted: { url: string; reason: string }[]
  }
  images: { resolved: number; unresolved: { src: string; reason: string }[] }
  /** YouTube blocks written (from iframes, embeds, shortcodes, bare URLs and wp:embed blocks). */
  youtube: number
  /** Iframes/embeds that were not YouTube: turned into a link paragraph or dropped. */
  embeds: { linked: { url: string }[]; dropped: { reason: string }[] }
  /** Unknown elements that were flattened to their content, by tag name. */
  unknownElements: Record<string, number>
  /** Gutenberg blocks with an unknown name that fell back to their inner HTML. */
  unknownBlocks: Record<string, number>
  /** Elements dropped together with their contents (script, style, video, ...), by tag name. */
  droppedElements: Record<string, number>
  tables: { kept: number; flattened: { reason: string }[] }
  headingsNormalised: number
  emptyBlocksDropped: number
  horizontalRulesDropped: number
  moreMarkers: number
  commentsDropped: number
  deepNestingFlattened: number
  listsFlattened: number
  warnings: string[]
}

export type HtmlToLexicalResult = {
  /** The serialized editor state, `{ root }`: what `articles.content` stores. */
  content: { root: LexicalNode }
  /** The root node itself (`content.root`). */
  root: LexicalNode
  report: ConversionReport
}

// ---------------------------------------------------------------------------------------------
// YouTube
// ---------------------------------------------------------------------------------------------

const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com', 'youtu.be'])

/** The 11-character video id of a YouTube address (embed, nocookie, youtu.be, watch?v=, shorts, live, v), else null. */
export function extractYoutubeId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  let text = raw.trim()
  if (text.length === 0 || text.length > 2000) return null
  if (text.startsWith('//')) text = `https:${text}`
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (!YT_HOSTS.has(url.hostname.toLowerCase())) return null
  const segments = url.pathname.split('/').filter((s) => s !== '')
  let candidate: string | undefined
  if (url.hostname.toLowerCase() === 'youtu.be') {
    candidate = segments[0]
  } else if (segments[0] === 'watch') {
    candidate = url.searchParams.get('v') ?? undefined
  } else if (['embed', 'v', 'shorts', 'live'].includes(segments[0] ?? '')) {
    candidate = segments[1]
  }
  return candidate !== undefined && candidate !== 'videoseries' && YOUTUBE_ID_RE.test(candidate) ? candidate : null
}

const youtubeBlock = (videoId: string, index: number, title?: string): LexicalNode => {
  const fields: Json = {
    // deterministic 24-hex id (the shape Payload's editor writes), so a re-run gives the same output
    id: createHash('sha1').update(`yt:${index}:${videoId}`).digest('hex').slice(0, 24),
    blockName: '',
    blockType: YOUTUBE_BLOCK_SLUG,
    videoId,
  }
  if (title && youtubeTitleProblem(title) === null) fields.title = title
  return { type: 'block', version: 2, format: '', fields }
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

const FORMAT = { bold: 1, italic: 2, strike: 4, underline: 8, code: 16, sub: 32, sup: 64 } as const
const INLINE_FORMAT: Record<string, number> = {
  strong: FORMAT.bold,
  b: FORMAT.bold,
  em: FORMAT.italic,
  i: FORMAT.italic,
  s: FORMAT.strike,
  del: FORMAT.strike,
  strike: FORMAT.strike,
  u: FORMAT.underline,
  ins: FORMAT.underline,
  code: FORMAT.code,
  tt: FORMAT.code,
  kbd: FORMAT.code,
  samp: FORMAT.code,
  sub: FORMAT.sub,
  sup: FORMAT.sup,
}
/** Inline or container tags that are expected and carry no meaning of their own here (not reported when flattened). */
const TRANSPARENT = new Set([
  'span', 'font', 'small', 'big', 'mark', 'abbr', 'acronym', 'cite', 'time', 'dfn', 'var', 'q', 'bdi', 'bdo', 'wbr',
  'label', 'data', 'ruby', 'rt', 'rp', 'html', 'body', 'main', 'center', 'section', 'article', 'aside', 'header',
  'footer', 'nav', 'address', 'hgroup', 'details', 'summary', 'fieldset', 'legend', 'div', 'dl', 'colgroup', 'col',
  'optgroup', 'option', 'figure', 'figcaption', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'li', 'dt', 'dd',
  'ul', 'ol', 'table', 'blockquote', 'pre', 'p', 'a', 'img', 'br', 'hr',
])
const DROP_WITH_CONTENT = new Set([
  'script', 'style', 'noscript', 'template', 'form', 'input', 'button', 'select', 'textarea', 'link', 'meta', 'base',
  'svg', 'math', 'canvas', 'video', 'audio', 'source', 'track', 'applet', 'frame', 'frameset', 'head', 'title',
  'datalist', 'output', 'dialog', 'map', 'area', 'picture-source',
])
const HEADING_RE = /^h([1-6])$/
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029\uFEFF\uFFFE\uFFFF]/g

const bump = (rec: Record<string, number>, key: string, by = 1) => {
  const k = key.slice(0, 80)
  if (Object.prototype.hasOwnProperty.call(rec, k)) rec[k] += by
  else Object.defineProperty(rec, k, { value: by, enumerable: true, writable: true, configurable: true })
}

const isElem = (n: ChildNode | undefined): n is Elem => n !== undefined && 'tagName' in n
const isText = (n: ChildNode): n is DefaultTreeAdapterMap['textNode'] => n.nodeName === '#text'
const isComment = (n: ChildNode): n is DefaultTreeAdapterMap['commentNode'] => n.nodeName === '#comment'

const attr = (el: Elem, name: string): string | undefined => el.attrs.find((a) => a.name === name)?.value

const squash = (s: string): string => s.replace(/[ \t\r\n\f\u00A0]+/g, ' ').trim()

/** Children of an element (a `template` keeps them in `content`). */
const kids = (el: { childNodes?: ChildNode[] }): ChildNode[] => el.childNodes ?? []

/** All descendants matching `test`, document order, iterative (a deep tree cannot overflow the stack). */
function findAll(nodes: ChildNode[], test: (e: Elem) => boolean, limit = 100_000): Elem[] {
  const found: Elem[] = []
  const stack: ChildNode[] = []
  for (let i = nodes.length - 1; i >= 0; i--) stack.push(nodes[i])
  while (stack.length > 0 && found.length < limit) {
    const n = stack.pop() as ChildNode
    if (isElem(n)) {
      if (test(n)) found.push(n)
      const c = kids(n)
      for (let i = c.length - 1; i >= 0; i--) stack.push(c[i])
    }
  }
  return found
}

/** Visible text of nodes, iterative; element boundaries become spaces. Comments, scripts and styles are skipped. */
function textContent(nodes: ChildNode[]): string {
  let out = ''
  const stack: ChildNode[] = []
  for (let i = nodes.length - 1; i >= 0; i--) stack.push(nodes[i])
  while (stack.length > 0) {
    const n = stack.pop() as ChildNode
    if (isText(n)) out += n.value
    else if (isElem(n)) {
      if (DROP_WITH_CONTENT.has(n.tagName)) continue
      out += ' '
      const c = kids(n)
      for (let i = c.length - 1; i >= 0; i--) stack.push(c[i])
    }
  }
  return squash(out)
}

const SAFE_HTTPS_RE = /^https:\/\/[^\s<>"'\\]+$/i
function safeHttpsUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const t = raw.trim()
  if (t.length > 2000 || !SAFE_HTTPS_RE.test(t)) return null
  try {
    const u = new URL(t)
    return u.protocol === 'https:' && !u.username && !u.password ? t : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------------------------
// Lexical node builders
// ---------------------------------------------------------------------------------------------

const textNode = (text: string, format: number): LexicalNode => ({ type: 'text', text, format, detail: 0, mode: 'normal', style: '', version: 1 })
const lineBreak = (): LexicalNode => ({ type: 'linebreak', version: 1 })
const elementBase = { format: '', indent: 0, version: 1, direction: 'ltr' }
const paragraph = (children: LexicalNode[]): LexicalNode => ({ type: 'paragraph', ...elementBase, textFormat: 0, children })
const heading = (tag: string, children: LexicalNode[]): LexicalNode => ({ type: 'heading', tag, ...elementBase, children })
const quote = (children: LexicalNode[]): LexicalNode => ({ type: 'quote', ...elementBase, children })
const upload = (mediaId: number): LexicalNode => ({ type: 'upload', relationTo: 'media', value: mediaId, version: 3, fields: null, format: '' })
const linkNode = (url: string, newTab: boolean, children: LexicalNode[]): LexicalNode => ({
  type: 'link',
  version: 3,
  format: '',
  indent: 0,
  direction: 'ltr',
  fields: { url, newTab, linkType: 'custom' },
  children,
})

// ---------------------------------------------------------------------------------------------
// Conversion state
// ---------------------------------------------------------------------------------------------

type LinkRef = { url: string; newTab: boolean }
type Item =
  | { kind: 'text'; text: string; fmt: number; link: LinkRef | null }
  | { kind: 'br' }
  | { kind: 'parabreak' }
  | { kind: 'block'; nodes: LexicalNode[] }
type Collector = { items: Item[] }

type Frame = {
  fmt: number
  link: LinkRef | null
  depth: number
  /** Inside a table cell: lists, quotes and tables become paragraphs. */
  inCell: boolean
  /** Directly in a block container (a blank line in text may split paragraphs). */
  para: boolean
  pre: boolean
  listDepth: number
}

type Ctx = {
  opts: HtmlToLexicalOptions
  report: ConversionReport
  autop: boolean
  maxDepth: number
  ytIndex: number
  openShortcodes: Map<string, number>
  hoist: LexicalNode[]
}

const YT_SHORTCODE_FULL_RE = /^\[(youtube|embed|yt)(?:\s*=\s*|\s+)?([^\]]*)\](?:([^[\]]*)\[\/\1\])?$/

/** Url or id from the inside of a `[youtube ...]` style shortcode, else null. */
function youtubeFromShortcode(trimmed: string): string | null {
  const m = YT_SHORTCODE_FULL_RE.exec(trimmed)
  if (!m) return null
  const [, , attrs, inner] = m
  const candidates: string[] = []
  if (inner) candidates.push(inner.trim())
  const a = attrs.trim()
  const named = /(?:^|\s)(?:url|src|link|id|v)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/i.exec(a)
  if (named) candidates.push((named[1] ?? named[2] ?? named[3] ?? '').trim())
  if (a) candidates.push(a.replace(/^["']|["']$/g, '').trim())
  for (const c of candidates) {
    const fromUrl = extractYoutubeId(c)
    if (fromUrl) return fromUrl
    if (YOUTUBE_ID_RE.test(c)) return c
  }
  return null
}

function emptyReport(inputBytes: number): ConversionReport {
  return {
    inputBytes,
    nodeCount: 0,
    entitiesDecoded: 0,
    shortcodesRemoved: {},
    links: { rewritten: 0, unmapped: [], converted: [] },
    images: { resolved: 0, unresolved: [] },
    youtube: 0,
    embeds: { linked: [], dropped: [] },
    unknownElements: {},
    unknownBlocks: {},
    droppedElements: {},
    tables: { kept: 0, flattened: [] },
    headingsNormalised: 0,
    emptyBlocksDropped: 0,
    horizontalRulesDropped: 0,
    moreMarkers: 0,
    commentsDropped: 0,
    deepNestingFlattened: 0,
    listsFlattened: 0,
    warnings: [],
  }
}

// ---------------------------------------------------------------------------------------------
// Inline finishing: items -> Lexical inline nodes
// ---------------------------------------------------------------------------------------------

function inlineFromItems(items: Item[]): LexicalNode[] {
  // 1. whitespace: no leading space, no doubled spaces across nodes, no space before or after a line break
  const cleaned: Item[] = []
  let prevSpace = true
  for (const it of items) {
    if (it.kind === 'br') {
      const last = cleaned[cleaned.length - 1]
      if (last && last.kind === 'text') last.text = last.text.replace(/ +$/, '')
      if (last && last.kind === 'br' && cleaned[cleaned.length - 2]?.kind === 'br') continue // at most two in a row
      cleaned.push(it)
      prevSpace = true
    } else if (it.kind === 'text') {
      const trimmed: string = prevSpace ? it.text.replace(/^ +/, '') : it.text
      if (trimmed === '') continue
      cleaned.push({ ...it, text: trimmed })
      prevSpace = trimmed.endsWith(' ')
    }
  }
  while (cleaned.length > 0 && cleaned[cleaned.length - 1].kind === 'br') cleaned.pop()
  while (cleaned.length > 0 && cleaned[0].kind === 'br') cleaned.shift()
  const last = cleaned[cleaned.length - 1]
  if (last && last.kind === 'text') {
    last.text = last.text.replace(/ +$/, '')
    if (last.text === '') cleaned.pop()
  }
  // 2. merge neighbours with the same format and link, group by link
  const out: LexicalNode[] = []
  const st: { group: { link: LinkRef; nodes: LexicalNode[] } | null } = { group: null }
  const closeGroup = () => {
    if (st.group && st.group.nodes.length > 0) out.push(linkNode(st.group.link.url, st.group.link.newTab, st.group.nodes))
    st.group = null
  }
  for (const it of cleaned) {
    if (it.kind === 'text') {
      if (!st.group || st.group.link !== it.link) {
        closeGroup()
        if (it.link) st.group = { link: it.link, nodes: [] }
      }
      const nodes: LexicalNode[] = st.group ? st.group.nodes : out
      const prev = nodes[nodes.length - 1]
      if (prev && prev.type === 'text' && prev.format === it.fmt) prev.text = String(prev.text) + it.text
      else nodes.push(textNode(it.text, it.fmt))
    } else {
      closeGroup()
      out.push(lineBreak())
    }
  }
  closeGroup()
  return out
}

// ---------------------------------------------------------------------------------------------
// The converter
// ---------------------------------------------------------------------------------------------

export function htmlToLexical(html: string, options: HtmlToLexicalOptions): HtmlToLexicalResult {
  const maxInput = options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES
  const input = typeof html === 'string' ? html : ''
  const inputBytes = Buffer.byteLength(input, 'utf8')
  if (inputBytes > maxInput) {
    throw new HtmlConversionError('input-too-large', `The HTML is ${inputBytes} bytes; the limit is ${maxInput}.`)
  }
  const report = emptyReport(inputBytes)
  const ctx: Ctx = {
    opts: options,
    report,
    autop: !/<!--\s*wp:/i.test(input),
    maxDepth: Math.min(options.maxDepth ?? DEFAULT_MAX_DEPTH, DEFAULT_MAX_DEPTH),
    ytIndex: 0,
    openShortcodes: new Map(),
    hoist: [],
  }

  // Count entity references before decoding (a statistic only; the parser does the decoding).
  report.entitiesDecoded = (input.match(/&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/g) ?? []).length

  const cleanInput = input.replace(CONTROL_RE, '')
  if (cleanInput.length !== input.length) report.warnings.push(`Removed ${input.length - cleanInput.length} control characters (including null bytes).`)
  assertParseDepth(cleanInput)
  const fragment = parseFragment(cleanInput)

  const frame: Frame = { fmt: 0, link: null, depth: 0, inCell: false, para: true, pre: false, listDepth: 0 }
  const out: LexicalNode[] = []
  const col: Collector = { items: [] }
  walk(ctx, kids(fragment as unknown as { childNodes: ChildNode[] }), frame, col, out)
  flush(ctx, col, out)

  // Heading levels: strictly non-skipping from h2 (the renderer does the same).
  let last = 1
  for (const node of out) {
    if (node.type !== 'heading') continue
    const want = Number(String(node.tag).slice(1))
    const level = Math.min(want, last + 1)
    if (level !== want) report.headingsNormalised++
    node.tag = `h${level}`
    last = level
  }

  if (out.length === 0) {
    out.push(paragraph([]))
    report.warnings.push('The body is empty after conversion.')
  }
  let root: LexicalNode = { type: 'root', format: '', indent: 0, version: 1, direction: 'ltr', children: out }
  let content: { root: LexicalNode } = { root }

  const linkResult = sanitizeLegacyLinks(content, {
    oldHosts: options.oldHosts,
    slugMap: options.slugMap,
    articlePath: options.articlePath ?? ((slug: string) => `/article/${slug}`),
  })
  content = linkResult.root as { root: LexicalNode }
  root = content.root
  report.links = {
    rewritten: linkResult.report.rewritten,
    unmapped: linkResult.report.unmapped,
    converted: linkResult.report.converted,
  }
  mergeAdjacentText(root)

  report.nodeCount = countNodes(root)
  if (report.nodeCount > maxNodes) {
    throw new HtmlConversionError('too-many-nodes', `The article converts to ${report.nodeCount} nodes; the limit is ${maxNodes}.`)
  }
  const problem = findEmbedProblem(content)
  if (problem) throw new HtmlConversionError('invalid-output', `The converted body failed the CMS embed check: ${problem}`)
  return { content, root, report }
}

function countNodes(root: LexicalNode): number {
  let n = 0
  const stack: unknown[] = [root]
  while (stack.length > 0) {
    const node = stack.pop() as Json
    n++
    if (Array.isArray(node.children)) for (const c of node.children) stack.push(c)
  }
  return n
}

/** After the link pass converted links to text, neighbouring text nodes with equal format are joined again. */
function mergeAdjacentText(root: LexicalNode): void {
  const stack: LexicalNode[] = [root]
  while (stack.length > 0) {
    const node = stack.pop() as LexicalNode
    if (!Array.isArray(node.children)) continue
    const merged: LexicalNode[] = []
    for (const c of node.children as LexicalNode[]) {
      const prev = merged[merged.length - 1]
      if (c.type === 'text' && prev && prev.type === 'text' && prev.format === c.format) prev.text = String(prev.text) + String(c.text)
      else merged.push(c)
    }
    node.children = merged
    for (const c of merged) stack.push(c)
  }
}

// ---------------------------------------------------------------------------------------------
// Flushing the inline collector into blocks
// ---------------------------------------------------------------------------------------------

/** Paragraph or heading text that is exactly one YouTube address (a bare URL on its own line). */
function bareYoutubeId(inline: LexicalNode[]): string | null {
  let text: string | null = null
  if (inline.length === 1 && inline[0].type === 'text') text = String(inline[0].text)
  else if (inline.length === 1 && inline[0].type === 'link') {
    const c = inline[0].children as LexicalNode[]
    if (c.length === 1 && c[0].type === 'text') {
      const t = String(c[0].text).trim()
      const href = String(((inline[0].fields as Json) ?? {}).url ?? '')
      if (extractYoutubeId(t) !== null && extractYoutubeId(t) === extractYoutubeId(href)) text = t
    }
  }
  if (text === null) return null
  const t = text.trim()
  return /^https?:\/\/\S+$/.test(t) ? extractYoutubeId(t) : null
}

/** Emit the collected inline items as paragraphs/headings and blocks into `out`; returns how many nodes were emitted. */
function flush(ctx: Ctx, col: Collector, out: LexicalNode[], headingTag?: string): number {
  const items = col.items
  col.items = []
  if (items.length === 0) return 0
  let emitted = 0
  let cur: Item[] = []
  const finishSegment = () => {
    const seg = cur
    cur = []
    if (seg.length === 0) return
    const inline = inlineFromItems(seg)
    if (inline.length === 0) return
    if (!headingTag) {
      const id = bareYoutubeId(inline)
      if (id) {
        ctx.report.youtube++
        out.push(youtubeBlock(id, ctx.ytIndex++))
        emitted++
        return
      }
    }
    out.push(headingTag ? heading(headingTag, inline) : paragraph(inline))
    emitted++
  }
  for (const it of items) {
    if (it.kind === 'parabreak') finishSegment()
    else if (it.kind === 'block') {
      finishSegment()
      out.push(...it.nodes)
      emitted += it.nodes.length
    } else cur.push(it)
  }
  finishSegment()
  return emitted
}

/** Walk `nodes` in a fresh scope and return the blocks they produce. */
function scope(ctx: Ctx, nodes: ChildNode[], frame: Frame): LexicalNode[] {
  const out: LexicalNode[] = []
  const col: Collector = { items: [] }
  walk(ctx, nodes, frame, col, out)
  flush(ctx, col, out)
  return out
}

// ---------------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------------

function handleText(ctx: Ctx, value: string, frame: Frame, col: Collector): void {
  let text = value
  if (text === '') return
  const trimmed = text.trim()
  // [youtube ...] / [embed]url[/embed] on its own
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const id = youtubeFromShortcode(trimmed)
    if (id) {
      ctx.report.youtube++
      col.items.push({ kind: 'block', nodes: [youtubeBlock(id, ctx.ytIndex++)] })
      bump(ctx.report.shortcodesRemoved, YT_SHORTCODE_FULL_RE.exec(trimmed)?.[1] ?? 'youtube')
      return
    }
  }
  // Shortcodes: markers can be split across text nodes (`[caption ...]<img> text[/caption]`), so tags still open from
  // earlier text nodes are replayed as a synthetic prefix and removed again.
  if (text.includes('[')) {
    let prefix = ''
    for (const [tag, n] of ctx.openShortcodes) for (let i = 0; i < Math.min(n, 5); i++) prefix += `[${tag} x=1]`
    const result = stripShortcodes(prefix + text, { knownTags: [...(ctx.opts.knownShortcodes ?? []), 'youtube', 'yt'] })
    if (result.count > 0) {
      const skip = prefix === '' ? 0 : result.removals.slice(0, [...ctx.openShortcodes.values()].reduce((a, b) => a + Math.min(b, 5), 0)).length
      for (const r of result.removals.slice(skip)) {
        bump(ctx.report.shortcodesRemoved, r.tag)
        const cur = ctx.openShortcodes.get(r.tag) ?? 0
        if (r.reason === 'closing') {
          if (cur <= 1) ctx.openShortcodes.delete(r.tag)
          else ctx.openShortcodes.set(r.tag, cur - 1)
        } else if (cur < 50) ctx.openShortcodes.set(r.tag, cur + 1)
      }
      text = result.text
    }
  }

  const push = (s: string) => {
    if (s !== '') col.items.push({ kind: 'text', text: s, fmt: frame.fmt, link: frame.link })
  }
  if (frame.pre) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n')
    lines.forEach((line, i) => {
      if (i > 0) col.items.push({ kind: 'br' })
      push(line.replace(/\u00A0/g, ' '))
    })
    return
  }
  if (!ctx.autop) {
    push(text.replace(/[ \t\r\n\f\u00A0]+/g, ' '))
    return
  }
  // Classic editor (wpautop-like): a blank line ends a paragraph, a single newline is a line break.
  const parts = text.replace(/\r\n?/g, '\n').split('\n')
  let pendingBreaks = 0
  let seenText = false
  parts.forEach((part, i) => {
    const segment = part.replace(/[ \t\f\u00A0]+/g, ' ')
    if (i > 0) pendingBreaks++
    if (segment.trim() === '') {
      if (segment !== '' && i === 0 && parts.length === 1) push(' ')
      return
    }
    if (pendingBreaks > 0 && (seenText || col.items.length > 0)) {
      const lastIt = col.items[col.items.length - 1]
      if (pendingBreaks >= 2 && frame.para) col.items.push({ kind: 'parabreak' })
      else if (lastIt && lastIt.kind !== 'br' && lastIt.kind !== 'parabreak') col.items.push({ kind: 'br' })
      else if (!lastIt) push('')
    }
    pendingBreaks = 0
    seenText = true
    push(segment)
  })
  if (pendingBreaks > 0 && !seenText) push(' ')
}

// ---------------------------------------------------------------------------------------------
// Gutenberg block comments
// ---------------------------------------------------------------------------------------------

type BlockComment = { kind: 'open' | 'close' | 'self'; name: string; attrs: Json }

// A block comment is `wp:name {json}` / `/wp:name` / `wp:name {json} /`; this reads comment text, not markup.
const BLOCK_COMMENT_RE = /^\s*(\/)?wp:([a-z][a-z0-9_-]*(?:\/[a-z][a-z0-9_-]*)?)\s*(\{[\s\S]*\})?\s*(\/)?\s*$/

function parseBlockComment(data: string): BlockComment | null {
  if (data.length > 20_000) return null
  const m = BLOCK_COMMENT_RE.exec(data)
  if (!m) return null
  const name = m[2].replace(/^core\//, '')
  if (m[1]) return { kind: 'close', name, attrs: {} }
  let attrs: Json = {}
  if (m[3]) {
    try {
      const parsed = JSON.parse(m[3]) as unknown
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) attrs = parsed as Json
    } catch {
      attrs = {}
    }
  }
  return { kind: m[4] ? 'self' : 'open', name, attrs }
}

const CONTAINER_BLOCKS = new Set([
  'group', 'columns', 'column', 'cover', 'media-text', 'buttons', 'button', 'spacer', 'details', 'row', 'stack', 'text-columns',
  'list-item', 'file', 'freeform', 'classic', 'paragraph', 'heading', 'list', 'quote', 'pullquote', 'image', 'table', 'preformatted',
  'code', 'verse', 'video', 'audio', 'separator', 'nextpage', 'html', 'shortcode', 'embed', 'gallery', 'more', 'block', 'social-links',
  'social-link', 'site-title', 'query', 'post-title', 'post-content', 'separator',
])

function handleBlock(ctx: Ctx, bc: BlockComment, inner: ChildNode[], frame: Frame, col: Collector, out: LexicalNode[]): void {
  const name = bc.name
  const embedName = name === 'embed' || name.startsWith('embed/') || name.startsWith('core-embed/')
  if (!CONTAINER_BLOCKS.has(name) && !embedName) bump(ctx.report.unknownBlocks, name)
  if (name === 'more' || name === 'nextpage') {
    ctx.report.moreMarkers++
    col.items.push({ kind: 'parabreak' })
    return
  }
  if (embedName) {
    flush(ctx, col, out)
    handleEmbedBlock(ctx, bc, inner, frame, out)
    return
  }
  if (name === 'gallery') {
    flush(ctx, col, out)
    handleGallery(ctx, inner, frame, out)
    return
  }
  // Everything else: the inner HTML carries the structure (h2, ul, figure, ...); handle it generically.
  flush(ctx, col, out)
  walk(ctx, inner, frame, col, out)
  flush(ctx, col, out)
  if (name === 'html' || name === 'shortcode') {
    // raw HTML blocks are sanitised by construction: only the shapes above are ever written.
  }
}

function handleEmbedBlock(ctx: Ctx, bc: BlockComment, inner: ChildNode[], frame: Frame, out: LexicalNode[]): void {
  let url = typeof bc.attrs.url === 'string' ? bc.attrs.url : ''
  if (!url) {
    const a = findAll(inner, (e) => e.tagName === 'a' && attr(e, 'href') !== undefined, 5)[0]
    if (a) url = attr(a, 'href') ?? ''
  }
  if (!url) {
    const wrapper = findAll(inner, (e) => /embed__wrapper/.test(attr(e, 'class') ?? ''), 1)[0]
    url = textContent(wrapper ? kids(wrapper) : inner)
    if (/\s/.test(url)) url = url.split(/\s+/)[0]
  }
  const caption = textContent(findAll(inner, (e) => e.tagName === 'figcaption', 1).flatMap((e) => kids(e)))
  const id = extractYoutubeId(url)
  if (id) {
    ctx.report.youtube++
    out.push(youtubeBlock(id, ctx.ytIndex++, caption ? caption.slice(0, YOUTUBE_TITLE_MAX) : undefined))
    return
  }
  otherEmbed(ctx, url, 'embed block', out)
  void frame
}

/** A non-YouTube embed: a link paragraph when it is a safe https address, otherwise dropped. Always reported. */
function otherEmbed(ctx: Ctx, rawUrl: string, what: string, out: LexicalNode[] | Collector): void {
  const safe = safeHttpsUrl(rawUrl)
  if (safe) {
    ctx.report.embeds.linked.push({ url: safe })
    const nodes = [paragraph([linkNode(safe, false, [textNode(safe, 0)])])]
    if (Array.isArray(out)) out.push(...nodes)
    else out.items.push({ kind: 'block', nodes })
  } else {
    ctx.report.embeds.dropped.push({ reason: `${what} without a safe https address` })
  }
}

function handleGallery(ctx: Ctx, inner: ChildNode[], frame: Frame, out: LexicalNode[]): void {
  const imgs = findAll(inner, (e) => e.tagName === 'img')
  const galleryCaptions: ChildNode[][] = []
  for (const fig of findAll(inner, (e) => e.tagName === 'figure')) {
    const count = findAll(kids(fig), (e) => e.tagName === 'img', 2).length
    if (count > 1) {
      const cap = kids(fig).find((c): c is Elem => isElem(c) && c.tagName === 'figcaption')
      if (cap) galleryCaptions.push(kids(cap))
    }
  }
  for (const img of imgs) {
    let caption: ChildNode[] = []
    const parent = (img as unknown as { parentNode?: ChildNode }).parentNode
    let fig: ChildNode | undefined = parent
    for (let i = 0; i < 3 && fig && !(isElem(fig) && fig.tagName === 'figure'); i++) fig = (fig as unknown as { parentNode?: ChildNode }).parentNode
    if (fig && isElem(fig) && fig.tagName === 'figure' && findAll(kids(fig), (e) => e.tagName === 'img', 2).length === 1) {
      const cap = kids(fig).find((c): c is Elem => isElem(c) && c.tagName === 'figcaption')
      if (cap) caption = kids(cap)
    }
    out.push(...imageBlocks(ctx, img, caption, frame))
  }
  for (const cap of galleryCaptions) out.push(...captionParagraphs(ctx, cap, frame))
}

// ---------------------------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------------------------

function imageSrc(img: Elem): string {
  const direct = (attr(img, 'src') ?? '').trim()
  if (direct && !direct.startsWith('data:')) return direct
  const lazy = (attr(img, 'data-src') ?? attr(img, 'data-lazy-src') ?? attr(img, 'data-orig-file') ?? '').trim()
  if (lazy) return lazy
  const srcset = (attr(img, 'srcset') ?? attr(img, 'data-srcset') ?? '').trim()
  if (srcset) return srcset.split(',')[0].trim().split(/\s+/)[0] ?? ''
  return direct
}

function captionParagraphs(ctx: Ctx, nodes: ChildNode[], frame: Frame): LexicalNode[] {
  const blocks = scope(ctx, nodes, { ...frame, para: false, listDepth: LIST_MAX_DEPTH + 1 })
  return blocks.filter((b) => b.type === 'paragraph').map((b) => paragraph(b.children as LexicalNode[]))
}

function imageBlocks(ctx: Ctx, img: Elem, captionNodes: ChildNode[], frame: Frame): LexicalNode[] {
  const src = imageSrc(img)
  const alt = squash(attr(img, 'alt') ?? '')
  const captionText = captionNodes.length > 0 ? textContent(captionNodes) : ''
  const captions = captionNodes.length > 0 ? captionParagraphs(ctx, captionNodes, frame) : []
  let resolved: { mediaId: number } | null = null
  if (src && !/^(data|javascript|vbscript):/i.test(src)) {
    try {
      resolved = ctx.opts.resolveImage(src, { alt, caption: captionText, articleTitle: ctx.opts.articleTitle })
    } catch {
      resolved = null
    }
  }
  if (resolved && Number.isInteger(resolved.mediaId) && resolved.mediaId >= 1 && resolved.mediaId <= 2147483647) {
    ctx.report.images.resolved++
    return [upload(resolved.mediaId), ...captions]
  }
  ctx.report.images.unresolved.push({
    src: src.slice(0, 500),
    reason: src ? 'resolveImage returned no media' : 'image without a usable src',
  })
  const nodes: LexicalNode[] = []
  if (alt && alt !== captionText) nodes.push(paragraph([textNode(alt, 0)]))
  nodes.push(...captions)
  return nodes
}

// ---------------------------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------------------------

type CellSpec = { el: Elem; inHead: boolean }

function clampSpan(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '1', 10)
  return Number.isFinite(n) ? Math.max(1, Math.min(SPAN_MAX, n)) : 1
}

function flattenTable(ctx: Ctx, rows: CellSpec[][], reason: string, tableEl: Elem): LexicalNode[] {
  ctx.report.tables.flattened.push({ reason })
  const out: LexicalNode[] = []
  const cap = findAll(kids(tableEl), (e) => e.tagName === 'caption', 1)[0]
  void cap
  for (const row of rows.slice(0, 5000)) {
    const cells = row.slice(0, 200).map((c) => textContent(kids(c.el))).filter((t) => t !== '')
    if (cells.length > 0) out.push(paragraph([textNode(cells.join(' | '), 0)]))
  }
  return out
}

function handleTable(ctx: Ctx, tableEl: Elem, frame: Frame): LexicalNode[] {
  // rows in order: thead, tbody (or direct tr), tfoot last
  const head: CellSpec[][] = []
  const body: CellSpec[][] = []
  const foot: CellSpec[][] = []
  let captionEl: Elem | undefined
  const readRow = (tr: Elem, inHead: boolean): CellSpec[] =>
    kids(tr).filter((c): c is Elem => isElem(c) && (c.tagName === 'td' || c.tagName === 'th')).map((el) => ({ el, inHead }))
  for (const child of kids(tableEl)) {
    if (!isElem(child)) continue
    if (child.tagName === 'caption') captionEl = child
    else if (child.tagName === 'tr') body.push(readRow(child, false))
    else if (child.tagName === 'thead' || child.tagName === 'tbody' || child.tagName === 'tfoot') {
      const target = child.tagName === 'thead' ? head : child.tagName === 'tfoot' ? foot : body
      for (const tr of kids(child)) if (isElem(tr) && tr.tagName === 'tr') target.push(readRow(tr, child.tagName === 'thead'))
    }
  }
  const rows = [...head, ...body, ...foot].filter((r) => r.length > 0)
  const blocks: LexicalNode[] = []
  if (captionEl) blocks.push(...captionParagraphs(ctx, kids(captionEl), frame))
  if (rows.length === 0) {
    ctx.report.emptyBlocksDropped++
    return blocks
  }
  if (frame.inCell) return [...blocks, ...flattenTable(ctx, rows, 'nested table inside a table cell', tableEl)]
  if (rows.length > TABLE_MAX_ROWS) return [...blocks, ...flattenTable(ctx, rows, `more than ${TABLE_MAX_ROWS} rows`, tableEl)]

  // layout on a grid, honouring spans
  const occupied = new Set<string>()
  const placed: { r: number; c: number; spec: CellSpec; colSpan: number; rowSpan: number }[] = []
  let width = 0
  for (let r = 0; r < rows.length; r++) {
    let c = 0
    for (const spec of rows[r]) {
      while (occupied.has(`${r},${c}`)) c++
      const colSpan = clampSpan(attr(spec.el, 'colspan'))
      const rowSpan = Math.min(clampSpan(attr(spec.el, 'rowspan')), rows.length - r)
      placed.push({ r, c, spec, colSpan, rowSpan })
      for (let dr = 0; dr < rowSpan; dr++) for (let dc = 0; dc < colSpan; dc++) occupied.add(`${r + dr},${c + dc}`)
      c += colSpan
      width = Math.max(width, c)
      if (width > TABLE_MAX_COLS) return [...blocks, ...flattenTable(ctx, rows, `more than ${TABLE_MAX_COLS} columns`, tableEl)]
    }
  }

  const rowIsHeader = rows.map((row, i) => row[0]?.inHead === true || (i === 0 && head.length === 0 && row.every((c) => c.el.tagName === 'th')))
  const bodyRowIdx = rows.map((_, i) => i).filter((i) => !rowIsHeader[i])
  const firstColHeaders = bodyRowIdx.length > 0 && bodyRowIdx.every((i) => rows[i][0].el.tagName === 'th')

  const cellContent = (el: Elem): LexicalNode[] => {
    const blocks2 = scope(ctx, kids(el), { ...frame, inCell: true, para: true, fmt: 0, link: null, depth: frame.depth + 1 })
    const outCells: LexicalNode[] = []
    for (const b of blocks2) {
      if (b.type === 'heading' || b.type === 'quote') outCells.push(paragraph(b.children as LexicalNode[]))
      else outCells.push(b)
    }
    return outCells.length > 0 ? outCells : [paragraph([])]
  }

  const rowNodes: LexicalNode[][] = rows.map(() => [])
  const byRow = new Map<number, typeof placed>()
  for (const p of placed) byRow.set(p.r, [...(byRow.get(p.r) ?? []), p])
  for (let r = 0; r < rows.length; r++) {
    const cells = (byRow.get(r) ?? []).sort((a, b) => a.c - b.c)
    const filled = new Set<number>()
    const nodes: { c: number; node: LexicalNode }[] = []
    for (const p of cells) {
      const isTh = p.spec.el.tagName === 'th'
      let headerState = 0
      if (isTh && rowIsHeader[r]) headerState = 1
      if (isTh && p.c === 0 && (firstColHeaders || !rowIsHeader[r])) headerState |= 2
      nodes.push({
        c: p.c,
        node: {
          type: 'tablecell',
          version: 1,
          headerState,
          colSpan: p.colSpan,
          rowSpan: p.rowSpan,
          backgroundColor: null,
          children: cellContent(p.spec.el),
        },
      })
      for (let dc = 0; dc < p.colSpan; dc++) filled.add(p.c + dc)
    }
    for (let c = 0; c < width; c++) {
      if (!filled.has(c) && !occupied.has(`${r},${c}`)) {
        nodes.push({ c, node: { type: 'tablecell', version: 1, headerState: 0, colSpan: 1, rowSpan: 1, backgroundColor: null, children: [paragraph([])] } })
      }
    }
    rowNodes[r] = nodes.sort((a, b) => a.c - b.c).map((n) => n.node)
  }
  ctx.report.tables.kept++
  blocks.push({
    type: 'table',
    ...elementBase,
    children: rowNodes.map((cells) => ({ type: 'tablerow', version: 1, children: cells })),
  })
  return blocks
}

// ---------------------------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------------------------

function liBlocksToItems(ctx: Ctx, blocks: LexicalNode[], state: { n: number }, hoist: LexicalNode[]): LexicalNode[] {
  const items: LexicalNode[] = []
  let inline: LexicalNode[] = []
  const flushInline = () => {
    if (inline.length === 0) return
    items.push({ type: 'listitem', version: 1, format: '', indent: 0, direction: 'ltr', value: state.n++, children: inline })
    inline = []
  }
  for (const b of blocks) {
    if (b.type === 'paragraph' || b.type === 'heading' || b.type === 'quote') {
      if (inline.length > 0) inline.push(lineBreak())
      inline.push(...(b.children as LexicalNode[]))
    } else if (b.type === 'list') {
      flushInline()
      items.push({ type: 'listitem', version: 1, format: '', indent: 0, direction: 'ltr', value: state.n++, children: [b] })
    } else hoist.push(b)
  }
  flushInline()
  void ctx
  return items
}

function handleList(ctx: Ctx, el: Elem, frame: Frame): LexicalNode[] {
  if (frame.depth >= ctx.maxDepth) {
    ctx.report.deepNestingFlattened++
    const text = textContent([el])
    return text ? [paragraph([textNode(text, 0)])] : []
  }
  const ordered = el.tagName === 'ol'
  const flat = frame.inCell || frame.listDepth >= LIST_MAX_DEPTH
  const inner: Frame = { ...frame, para: false, listDepth: frame.listDepth + 1, fmt: frame.fmt }
  const hoist: LexicalNode[] = []
  if (flat) {
    if (!frame.inCell) {
      ctx.report.listsFlattened++
    }
    const out: LexicalNode[] = []
    for (const child of kids(el)) {
      if (!isElem(child)) continue
      if (child.tagName === 'li') out.push(...scope(ctx, kids(child), inner))
      else if (child.tagName === 'ul' || child.tagName === 'ol') out.push(...handleList(ctx, child, { ...frame, depth: frame.depth + 1 }))
    }
    return out
  }
  const state = { n: 1 }
  const children: LexicalNode[] = []
  for (const child of kids(el)) {
    if (!isElem(child)) continue
    if (child.tagName === 'li') {
      const blocks = scope(ctx, kids(child), inner)
      const items = liBlocksToItems(ctx, blocks, state, hoist)
      if (items.length === 0) ctx.report.emptyBlocksDropped++
      children.push(...items)
    } else if (child.tagName === 'ul' || child.tagName === 'ol') {
      // a list directly inside a list (invalid HTML): treat it as nested
      const nested = handleList(ctx, child, { ...frame, depth: frame.depth + 1, listDepth: frame.listDepth + 1 })
      for (const b of nested) {
        if (b.type === 'list') children.push({ type: 'listitem', version: 1, format: '', indent: 0, direction: 'ltr', value: state.n++, children: [b] })
        else hoist.push(b)
      }
    }
  }
  if (children.length === 0) return hoist
  const list: LexicalNode = {
    type: 'list',
    ...elementBase,
    listType: ordered ? 'number' : 'bullet',
    start: ordered ? Math.max(1, Math.min(Number.parseInt(attr(el, 'start') ?? '1', 10) || 1, 1_000_000)) : 1,
    tag: ordered ? 'ol' : 'ul',
    children,
  }
  return [list, ...hoist]
}

// ---------------------------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------------------------

function walk(ctx: Ctx, nodes: ChildNode[], frame: Frame, col: Collector, out: LexicalNode[]): void {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    if (isText(node)) {
      handleText(ctx, node.value, frame, col)
      continue
    }
    if (isComment(node)) {
      const data = node.data
      const trimmed = data.trim()
      if (/^more(\s|$)/i.test(trimmed) || /^nextpage$/i.test(trimmed)) {
        ctx.report.moreMarkers++
        col.items.push({ kind: 'parabreak' })
        continue
      }
      const bc = parseBlockComment(data)
      if (!bc) {
        ctx.report.commentsDropped++
        continue
      }
      if (bc.kind === 'close') continue // a stray close marker
      if (bc.kind === 'self') {
        handleBlock(ctx, bc, [], frame, col, out)
        continue
      }
      // find the matching close among the following siblings, honouring nesting of the same name
      let depth = 1
      let end = nodes.length
      for (let j = i + 1; j < nodes.length; j++) {
        const nj = nodes[j]
        if (!isComment(nj)) continue
        const other = parseBlockComment(nj.data)
        if (!other || other.name !== bc.name) continue
        if (other.kind === 'open') depth++
        else if (other.kind === 'close' && --depth === 0) {
          end = j
          break
        }
      }
      if (end === nodes.length) ctx.report.warnings.push(`Gutenberg block "${bc.name}" is not closed; the rest of its container was used.`)
      handleBlock(ctx, bc, nodes.slice(i + 1, end), frame, col, out)
      i = end
      continue
    }
    if (!isElem(node)) continue
    walkElement(ctx, node, frame, col, out)
  }
}

function walkElement(ctx: Ctx, el: Elem, frame: Frame, col: Collector, out: LexicalNode[]): void {
  const tag = el.tagName
  if (frame.depth >= ctx.maxDepth) {
    ctx.report.deepNestingFlattened++
    const text = textContent([el])
    if (text) handleText(ctx, text, { ...frame, pre: false }, col)
    return
  }
  const deeper: Frame = { ...frame, depth: frame.depth + 1 }

  if (DROP_WITH_CONTENT.has(tag)) {
    bump(ctx.report.droppedElements, tag)
    return
  }
  if (tag === 'iframe') {
    handleIframe(ctx, el, col)
    return
  }
  if (tag === 'embed' || tag === 'object') {
    handleObject(ctx, el, col)
    return
  }
  if (tag === 'img') {
    col.items.push({ kind: 'block', nodes: imageBlocks(ctx, el, [], deeper) })
    return
  }
  if (tag === 'br') {
    col.items.push({ kind: 'br' })
    return
  }
  if (tag === 'hr') {
    flush(ctx, col, out)
    ctx.report.horizontalRulesDropped++
    return
  }

  const h = HEADING_RE.exec(tag)
  if (h) {
    flush(ctx, col, out)
    const n = Number(h[1])
    const normal = n === 1 ? 2 : n >= 5 ? 4 : n
    if (normal !== n) ctx.report.headingsNormalised++
    walk(ctx, kids(el), { ...deeper, para: false }, col, out)
    if (flush(ctx, col, out, `h${normal}`) === 0) ctx.report.emptyBlocksDropped++
    return
  }

  switch (tag) {
    case 'p':
    case 'dt':
    case 'dd':
    case 'figcaption':
    case 'caption': {
      flush(ctx, col, out)
      walk(ctx, kids(el), { ...deeper, para: false }, col, out)
      if (flush(ctx, col, out) === 0) ctx.report.emptyBlocksDropped++
      return
    }
    case 'pre': {
      flush(ctx, col, out)
      bump(ctx.report.unknownElements, 'pre (kept as plain text lines)')
      walk(ctx, kids(el), { ...deeper, para: false, pre: true, fmt: frame.fmt | FORMAT.code }, col, out)
      flush(ctx, col, out)
      return
    }
    case 'blockquote': {
      flush(ctx, col, out)
      const blocks = scope(ctx, kids(el), { ...deeper, para: false, listDepth: LIST_MAX_DEPTH })
      const inline: LexicalNode[] = []
      const rest: LexicalNode[] = []
      for (const b of blocks) {
        if (b.type === 'paragraph' || b.type === 'heading' || b.type === 'quote' || b.type === 'list') {
          const children = b.type === 'list' ? ((b.children as LexicalNode[]).flatMap((li) => li.children as LexicalNode[])) : (b.children as LexicalNode[])
          if (inline.length > 0) inline.push(lineBreak())
          inline.push(...children)
        } else rest.push(b)
      }
      if (inline.length > 0) {
        out.push(frame.inCell ? paragraph(inline) : quote(inline))
      } else if (rest.length === 0) ctx.report.emptyBlocksDropped++
      out.push(...rest)
      return
    }
    case 'ul':
    case 'ol': {
      flush(ctx, col, out)
      out.push(...handleList(ctx, el, deeper))
      return
    }
    case 'table': {
      flush(ctx, col, out)
      out.push(...handleTable(ctx, el, deeper))
      return
    }
    case 'figure': {
      const imgs = findAll(kids(el), (e) => e.tagName === 'img', 50)
      if (imgs.length > 0) {
        flush(ctx, col, out)
        const caps = kids(el).filter((c): c is Elem => isElem(c) && c.tagName === 'figcaption')
        const captionNodes = caps.flatMap((c) => kids(c))
        if (imgs.length === 1) out.push(...imageBlocks(ctx, imgs[0], captionNodes, deeper))
        else {
          for (const img of imgs) out.push(...imageBlocks(ctx, img, [], deeper))
          if (captionNodes.length > 0) out.push(...captionParagraphs(ctx, captionNodes, deeper))
        }
        return
      }
      flush(ctx, col, out)
      walk(ctx, kids(el), deeper, col, out)
      flush(ctx, col, out)
      return
    }
    case 'a': {
      const href = (attr(el, 'href') ?? '').trim()
      let link = frame.link
      if (href !== '') {
        if (frame.link) {
          bump(ctx.report.unknownElements, 'a (nested link flattened)')
        } else {
          link = { url: href, newTab: (attr(el, 'target') ?? '').toLowerCase() === '_blank' }
        }
      }
      walk(ctx, kids(el), { ...deeper, link }, col, out)
      return
    }
    default:
  }

  if (tag in INLINE_FORMAT) {
    walk(ctx, kids(el), { ...deeper, fmt: frame.fmt | INLINE_FORMAT[tag] }, col, out)
    return
  }

  const blockish = new Set([
    'div', 'section', 'article', 'aside', 'header', 'footer', 'nav', 'main', 'address', 'hgroup', 'details', 'summary',
    'fieldset', 'legend', 'center', 'dl', 'li', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'colgroup', 'col',
  ])
  if (blockish.has(tag)) {
    flush(ctx, col, out)
    walk(ctx, kids(el), deeper, col, out)
    flush(ctx, col, out)
    return
  }
  if (!TRANSPARENT.has(tag)) bump(ctx.report.unknownElements, tag)
  walk(ctx, kids(el), deeper, col, out)
}

function handleIframe(ctx: Ctx, el: Elem, col: Collector): void {
  const src = (attr(el, 'src') ?? attr(el, 'data-src') ?? attr(el, 'data-lazy-src') ?? '').trim()
  const id = extractYoutubeId(src)
  if (id) {
    ctx.report.youtube++
    const title = squash(attr(el, 'title') ?? '')
    col.items.push({ kind: 'block', nodes: [youtubeBlock(id, ctx.ytIndex++, title && youtubeTitleProblem(title) === null ? title : undefined)] })
    return
  }
  otherEmbed(ctx, src.startsWith('//') ? `https:${src}` : src, 'iframe', col)
}

function handleObject(ctx: Ctx, el: Elem, col: Collector): void {
  const urls: string[] = []
  const take = (e: Elem) => {
    for (const k of ['src', 'data', 'value']) {
      const v = attr(e, k)
      if (v) urls.push(v)
    }
  }
  take(el)
  for (const d of findAll(kids(el), () => true, 200)) take(d)
  for (const u of urls) {
    const id = extractYoutubeId(u)
    if (id) {
      ctx.report.youtube++
      col.items.push({ kind: 'block', nodes: [youtubeBlock(id, ctx.ytIndex++)] })
      return
    }
  }
  const safe = urls.map((u) => safeHttpsUrl(u.startsWith('//') ? `https:${u}` : u)).find((u) => u !== null)
  if (safe) otherEmbed(ctx, safe, el.tagName, col)
  else {
    ctx.report.embeds.dropped.push({ reason: `${el.tagName} without a safe https address` })
    bump(ctx.report.droppedElements, el.tagName)
  }
}
