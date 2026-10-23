import { createHash } from 'node:crypto'

import { type DefaultTreeAdapterMap, defaultTreeAdapter, parseFragment } from 'parse5'

import { AV_BLOCK_SLUG, AV_CAPTION_MAX, AV_TITLE_MAX, type AvKind, avKindFromPath, avTextProblem, isSafeAvUrl } from '../lib/avMedia'
import { stripShortcodes, sanitizeLegacyLinks } from '../lib/legacyContent'
import { articlePath, resolveArticlePathTemplate } from '../lib/redirectPaths'
import { findEmbedProblem, YOUTUBE_BLOCK_SLUG, YOUTUBE_ID_RE, YOUTUBE_TITLE_MAX, youtubeTitleProblem } from '../lib/lexicalEmbeds'

/**
 * Safe converter from WordPress post HTML (Gutenberg block markup and classic-editor HTML) to the serialized Lexical
 * JSON the CMS stores and the public renderer reads (go-live contract C1).
 *
 * Pure: no database, no network, no file access. The HTML is read with parse5 (a real, spec-compliant parser); nothing
 * here parses markup with a regular expression. Only these node shapes are ever written: paragraph, heading (h2 to h4),
 * quote, list/listitem, link, text, linebreak, upload (relationTo media), table/tablerow/tablecell and the registered
 * `youtubeEmbed` and `audioVideo` blocks. Raw HTML, styles, event handlers and unknown attributes are never carried over.
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

/**
 * Resolves the address of an audio/video file to a Media document (`kind` says what the file is). Return null when the file
 * cannot be found: the block is then kept with the legacy address and counted as `unresolved-media`. Without this option
 * every file counts as unresolved.
 */
export type ResolveMedia = (
  src: string,
  context: { kind: AvKind; title: string; caption: string; articleTitle?: string },
) => { mediaId: number } | null

export type HtmlToLexicalOptions = {
  /** Host names of the old site (see `sanitizeLegacyLinks`). */
  oldHosts: readonly string[]
  /** Old WordPress slug -> new slug. */
  slugMap: ReadonlyMap<string, string> | Readonly<Record<string, string>>
  resolveImage: ResolveImage
  /** Audio/video files (`<video>`, `<audio>`, `[video]`, `[audio]`, `[fvplayer]`); optional, see ResolveMedia. */
  resolveMedia?: ResolveMedia
  /** Extra shortcode names to remove (merged with the C1 defaults). */
  knownShortcodes?: readonly string[]
  articleTitle?: string
  /** New root-relative article path, default is the configured article path (`/{slug}/`, see PUBLIC_ARTICLE_PATH_TEMPLATE). */
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
 *
 * The limit is enforced by parse5 itself: a tree adapter whose `onItemPush` hook sees every element the parser opens
 * (the real open-element stack, so `<div/>`, raw-text rules inside svg/math and implied tags are exactly what the
 * parser does) and throws as soon as the stack is deeper than the limit.
 */
export const MAX_PARSE_DEPTH = 512

function parseLimited(html: string) {
  let open = 0
  // The fragment parser keeps one synthetic root element on the stack; real nesting is one less.
  const limit = MAX_PARSE_DEPTH + 1
  const adapter = {
    ...defaultTreeAdapter,
    onItemPush: () => {
      if (++open > limit) {
        throw new HtmlConversionError('too-deep', `The HTML nests elements more than ${MAX_PARSE_DEPTH} levels deep; it is refused.`)
      }
    },
    onItemPop: () => {
      open--
    },
  }
  return parseFragment(html, { treeAdapter: adapter })
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
  /** `audioVideo` blocks written: with a media file, with only the legacy address (unresolved-media), and files of a type the CMS does not host (linked or dropped instead). */
  audioVideo: { resolved: number; unresolvedMedia: number; unsupported: number }
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

const stripControls = (s: string): string => s.replace(CONTROL_RE, '')
const attr = (el: Elem, name: string): string | undefined => {
  const v = el.attrs.find((a) => a.name === name)?.value
  return v === undefined ? undefined : stripControls(v)
}

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
    if (isText(n)) out += stripControls(n.value)
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
const upload = (mediaId: number, index: number): LexicalNode => ({
  type: 'upload',
  // the id the editor writes on upload nodes (deterministic 24-hex)
  id: createHash('sha1').update(`up:${index}:${mediaId}`).digest('hex').slice(0, 24),
  relationTo: 'media',
  value: mediaId,
  version: 3,
  fields: null,
  format: '',
})
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
  /** wpautop-like handling of newlines (classic documents and classic/freeform blocks). */
  autop: boolean
}

/** Most distinct shortcode tags tracked as "still open" across text nodes (the replay cost is bounded by this). */
export const LINK_MAX_LENGTH = 2000
export const MAX_OPEN_SHORTCODES = 20
/** Most warnings kept in the report; further ones are counted in one final line. */
export const MAX_WARNINGS = 50
/** Most images handled inside one figure or gallery. */
export const MAX_IMAGES_PER_FIGURE = 5000

type Ctx = {
  opts: HtmlToLexicalOptions
  report: ConversionReport
  maxDepth: number
  ytIndex: number
  uploadIndex: number
  openShortcodes: Map<string, number>
  shortcodeOverflow: boolean
  hoist: LexicalNode[]
  /** Caption(s) of the figure being walked, taken by its single image. */
  pendingCaption: { captions: ChildNode[][]; used: boolean } | null
  /** Caption of the figure being walked, taken by its single video/audio element. */
  pendingAvCaption: { text: string; used: boolean } | null
  avIndex: number
  /** Links turned to text by the converter itself (the link pass reports its own). */
  extraConverted: { url: string; reason: string }[]
  suppressedWarnings: number
}

function warn(ctx: Ctx, message: string): void {
  if (ctx.report.warnings.length < MAX_WARNINGS) ctx.report.warnings.push(message)
  else ctx.suppressedWarnings++
}

type ShortcodePart = { text: string } | { shortcode: string; tag: string; id: string | null; attrs: string; inner: string }

/** `[youtube ...]`, `[yt ...]` and `[embed]...[/embed]` markers inside a text, found without regular expressions. */
function splitYoutubeShortcodes(text: string): ShortcodePart[] {
  const parts: ShortcodePart[] = []
  let last = 0
  let i = 0
  const noCloser = new Set<string>()
  while ((i = text.indexOf('[', i)) !== -1) {
    const head = /^\[(youtube|yt|embed|fvplayer|video|audio)(?=[\s=\]])/.exec(text.slice(i, i + 12))
    if (!head) {
      i++
      continue
    }
    const tag = head[1]
    const close = text.indexOf(']', i)
    if (close === -1) break
    const attrs = text.slice(i + 1 + tag.length, close)
    let end = close + 1
    let inner = ''
    const closer = `[/${tag}]`
    if (!noCloser.has(tag)) {
      const ci = text.indexOf(closer, end)
      if (ci === -1) noCloser.add(tag)
      else if (!text.slice(end, ci).includes('[')) {
        inner = text.slice(end, ci)
        end = ci + closer.length
      }
    }
    const id = youtubeFromShortcode(tag, attrs, inner)
    if (i > last) parts.push({ text: text.slice(last, i) })
    parts.push({ shortcode: text.slice(i, end), tag, id, attrs, inner })
    last = end
    i = end
  }
  if (parts.length === 0) return [{ text }]
  if (last < text.length) parts.push({ text: text.slice(last) })
  return parts
}

/** The video id from the inside of a `[youtube ...]` style shortcode, else null. A bare id only counts for youtube/yt. */
function youtubeFromShortcode(tag: string, attrs: string, inner: string): string | null {
  const candidates: string[] = []
  if (inner.trim()) candidates.push(inner.trim())
  const a = attrs.trim().replace(/^=\s*/, '')
  const named = /(?:^|\s)(?:url|src|link|id|v)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/i.exec(a)
  if (named) candidates.push((named[1] ?? named[2] ?? named[3] ?? '').trim())
  if (a) candidates.push(a.replace(/^["']|["']$/g, '').trim())
  for (const c of candidates) {
    const fromUrl = extractYoutubeId(c)
    if (fromUrl) return fromUrl
    if ((tag === 'youtube' || tag === 'yt') && YOUTUBE_ID_RE.test(c)) return c
  }
  return null
}

/** A report-safe form of an address: no user info, no query string, no fragment, bounded length. */
export function redactUrl(raw: string): string {
  const cut = (s: string) => s.slice(0, 200)
  try {
    const u = new URL(raw.trim())
    if (u.protocol === 'http:' || u.protocol === 'https:') return cut(`${u.protocol}//${u.host}${u.pathname}`)
    return cut(`${u.protocol}${u.pathname}`)
  } catch {
    return cut(raw.trim().split(/[?#]/)[0].replace(/\/\/[^/@\s]*@/, '//'))
  }
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
    audioVideo: { resolved: 0, unresolvedMedia: 0, unsupported: 0 },
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
  try {
    return convert(html, options)
  } catch (err) {
    if (err instanceof HtmlConversionError) throw err
    // anything unexpected (a stack overflow, a throwing caller option) is a conversion failure, never a raw error
    throw new HtmlConversionError('invalid-output', `The HTML could not be converted: ${err instanceof Error ? err.name : 'error'}.`)
  }
}

function convert(html: string, options: HtmlToLexicalOptions): HtmlToLexicalResult {
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
    maxDepth: Math.min(options.maxDepth ?? DEFAULT_MAX_DEPTH, DEFAULT_MAX_DEPTH),
    ytIndex: 0,
    uploadIndex: 0,
    openShortcodes: new Map(),
    shortcodeOverflow: false,
    hoist: [],
    pendingCaption: null,
    pendingAvCaption: null,
    avIndex: 0,
    extraConverted: [],
    suppressedWarnings: 0,
  }
  // Gutenberg documents carry block comments; their newlines are plain whitespace. Everything else is classic.
  const hasBlocks = input.includes('<!--') && /<!--\s*\/?wp:/i.test(input)

  // Count entity references before decoding (a statistic only; the parser does the decoding).
  report.entitiesDecoded = (input.match(/&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/g) ?? []).length

  const cleanInput = input.replace(CONTROL_RE, '')
  if (cleanInput.length !== input.length) report.warnings.push(`Removed ${input.length - cleanInput.length} control characters (including null bytes).`)

  const fragment = parseLimited(cleanInput)

  const frame: Frame = { fmt: 0, link: null, depth: 0, inCell: false, para: true, pre: false, listDepth: 0, autop: !hasBlocks }
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
    articlePath: options.articlePath ?? ((slug: string) => articlePath(resolveArticlePathTemplate(), slug)),
  })
  content = linkResult.root as { root: LexicalNode }
  root = content.root
  // Reports carry no user info, query strings or fragments (an address can hold a token).
  const redact = (e: { url: string; reason: string }) => ({ url: e.url === '' ? '' : redactUrl(e.url), reason: e.reason })
  report.links = {
    rewritten: linkResult.report.rewritten,
    unmapped: linkResult.report.unmapped.map(redact),
    converted: [...ctx.extraConverted, ...linkResult.report.converted].map(redact),
  }
  report.images.unresolved = report.images.unresolved.map((u) => ({ src: redactUrl(u.src), reason: u.reason }))
  report.embeds.linked = report.embeds.linked.map((u) => ({ url: redactUrl(u.url) }))
  if (ctx.suppressedWarnings > 0) report.warnings.push(`${ctx.suppressedWarnings} further warnings were not listed.`)
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
  const text = stripControls(value)
  if (text === '') return
  if (text.includes('[')) {
    // [youtube ...] / [yt ...] / [embed]...[/embed] anywhere in the text: a video block, or removed and reported
    for (const part of splitYoutubeShortcodes(text)) {
      if ('text' in part) handlePlainText(ctx, part.text, frame, col)
      else {
        bump(ctx.report.shortcodesRemoved, part.tag)
        if (part.id) {
          ctx.report.youtube++
          col.items.push({ kind: 'block', nodes: [youtubeBlock(part.id, ctx.ytIndex++)] })
        } else if (part.tag === 'fvplayer' || part.tag === 'video' || part.tag === 'audio') {
          avFromShortcode(ctx, part.tag, part.attrs, part.inner, col)
        }
      }
    }
    return
  }
  handlePlainText(ctx, text, frame, col)
}

function handlePlainText(ctx: Ctx, input: string, frame: Frame, col: Collector): void {
  let text = input
  if (text === '') return
  // Shortcodes: markers can be split across text nodes (`[caption ...]<img> text[/caption]`), so tags still open from
  // earlier text nodes are replayed as a synthetic prefix and removed again. The number of tracked tags is capped.
  if (text.includes('[')) {
    let prefix = ''
    let prefixCount = 0
    for (const [tag, n] of ctx.openShortcodes) {
      for (let i = 0; i < Math.min(n, 5); i++) {
        prefix += `[${tag} x=1]`
        prefixCount++
      }
    }
    const result = stripShortcodes(prefix + text, { knownTags: [...(ctx.opts.knownShortcodes ?? []), 'youtube', 'yt'] })
    if (result.count > 0) {
      for (const r of result.removals.slice(prefixCount)) {
        bump(ctx.report.shortcodesRemoved, r.tag)
        const cur = ctx.openShortcodes.get(r.tag) ?? 0
        if (r.reason === 'closing') {
          if (cur <= 1) ctx.openShortcodes.delete(r.tag)
          else ctx.openShortcodes.set(r.tag, cur - 1)
        } else if (cur > 0 || ctx.openShortcodes.size < MAX_OPEN_SHORTCODES) {
          if (cur < 50) ctx.openShortcodes.set(r.tag, cur + 1)
        } else if (!ctx.shortcodeOverflow) {
          ctx.shortcodeOverflow = true
          warn(ctx, `More than ${MAX_OPEN_SHORTCODES} different shortcode tags are open at once; pairing is not tracked for the rest.`)
        }
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
  if (!frame.autop) {
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

function handleBlock(ctx: Ctx, bc: BlockComment, innerSegs: Seg[], frame: Frame, col: Collector, out: LexicalNode[]): void {
  const name = bc.name
  const inner = flattenSegs(innerSegs)
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
  // Everything else: the inner HTML carries the structure (h2, ul, figure, ...); handle it generically. Raw HTML
  // blocks (html, shortcode) are sanitised by construction: only the shapes above are ever written. Classic/freeform
  // blocks are classic-editor text, so newline handling is switched back on inside them.
  flush(ctx, col, out)
  const inFrame = name === 'freeform' || name === 'classic' ? { ...frame, autop: true } : frame
  walkSegs(ctx, innerSegs, inFrame, col, out)
  flush(ctx, col, out)
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
  const capEls = findAll(inner, (e) => e.tagName === 'figcaption')
  const caption = squash(capEls.map((e) => textContent(kids(e))).join(' '))
  const captionParas = () => capEls.flatMap((e) => captionParagraphs(ctx, kids(e), frame))
  const id = extractYoutubeId(url)
  if (id) {
    ctx.report.youtube++
    // The caption becomes the block title when it is an acceptable plain-text title; otherwise it is kept as paragraphs.
    const asTitle = caption !== '' && youtubeTitleProblem(caption) === null
    out.push(youtubeBlock(id, ctx.ytIndex++, asTitle ? caption : undefined))
    if (caption !== '' && !asTitle) out.push(...captionParas())
    return
  }
  otherEmbed(ctx, url, 'embed block', out)
  out.push(...captionParas())
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
  const found = findAll(inner, (e) => e.tagName === 'img', MAX_IMAGES_PER_FIGURE + 1)
  if (found.length > MAX_IMAGES_PER_FIGURE) {
    warn(ctx, `A gallery holds more than ${MAX_IMAGES_PER_FIGURE} images; the ones after the first ${MAX_IMAGES_PER_FIGURE} were not converted.`)
  }
  const imgs = found.slice(0, MAX_IMAGES_PER_FIGURE)
  const galleryCaptions: ChildNode[][] = []
  for (const fig of findAll(inner, (e) => e.tagName === 'figure')) {
    const count = findAll(kids(fig), (e) => e.tagName === 'img', 2).length
    if (count > 1) {
      for (const c of kids(fig)) if (isElem(c) && c.tagName === 'figcaption') galleryCaptions.push(kids(c))
    }
  }
  for (const img of imgs) {
    let captions: ChildNode[][] = []
    let fig: ChildNode | undefined = (img as unknown as { parentNode?: ChildNode }).parentNode
    for (let i = 0; i < 3 && fig && !(isElem(fig) && fig.tagName === 'figure'); i++) fig = (fig as unknown as { parentNode?: ChildNode }).parentNode
    if (fig && isElem(fig) && fig.tagName === 'figure' && findAll(kids(fig), (e) => e.tagName === 'img', 2).length === 1) {
      captions = kids(fig).filter((c): c is Elem => isElem(c) && c.tagName === 'figcaption').map((c) => kids(c))
    }
    out.push(...imageBlocks(ctx, img, captions, frame))
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
  return blocks.map((b) => (b.type === 'heading' || b.type === 'quote' ? paragraph(b.children as LexicalNode[]) : b))
}

/** Shortcode markers removed from a short text (alt, caption) with the same rules as the body text. */
function withoutShortcodes(ctx: Ctx, text: string, report: boolean): string {
  if (!text.includes('[')) return text
  const result = stripShortcodes(text, { knownTags: [...(ctx.opts.knownShortcodes ?? []), 'youtube', 'yt'] })
  if (report) for (const r of result.removals) bump(ctx.report.shortcodesRemoved, r.tag)
  return squash(result.text)
}

function imageBlocks(ctx: Ctx, img: Elem, captionList: ChildNode[][], frame: Frame): LexicalNode[] {
  const src = imageSrc(img)
  const alt = withoutShortcodes(ctx, squash(attr(img, 'alt') ?? ''), true)
  // the caption text handed to resolveImage is cleaned quietly: the caption paragraphs below report their own removals
  const captionText = withoutShortcodes(ctx, squash(captionList.map((c) => textContent(c)).join(' ')), false)
  const captions = captionList.flatMap((c) => captionParagraphs(ctx, c, frame))
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
    return [upload(resolved.mediaId, ctx.uploadIndex++), ...captions]
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
  void tableEl
  // every row and every cell is kept (a table too large for the node limit fails the whole conversion instead)
  for (const row of rows) {
    const cells = row.map((c) => textContent(kids(c.el))).filter((t) => t !== '')
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
          ...{ format: '', indent: 0, direction: 'ltr' },
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
        nodes.push({ c, node: { type: 'tablecell',
          ...{ format: '', indent: 0, direction: 'ltr' }, version: 1, headerState: 0, colSpan: 1, rowSpan: 1, backgroundColor: null, children: [paragraph([])] } })
      }
    }
    rowNodes[r] = nodes.sort((a, b) => a.c - b.c).map((n) => n.node)
  }
  ctx.report.tables.kept++
  blocks.push({
    type: 'table',
    ...elementBase,
    children: rowNodes.map((cells) => ({ type: 'tablerow', version: 1, format: '', indent: 0, direction: 'ltr', children: cells })),
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

type BlockSeg = { block: BlockComment; children: Seg[] }
type Seg = ChildNode | BlockSeg
const isBlockSeg = (s: Seg): s is BlockSeg => 'block' in s

/**
 * Pair Gutenberg open/close markers among sibling nodes in ONE linear pass with an explicit stack (no recursion, no
 * rescans): a close marker closes the nearest open block of the same name (blocks opened inside it are closed with it),
 * a stray close is ignored, blocks still open at the end are closed there. Both irregularities are reported once.
 */
function buildSegments(ctx: Ctx, nodes: ChildNode[]): Seg[] {
  if (!nodes.some(isComment)) return nodes
  const rootSegs: Seg[] = []
  const stack: BlockSeg[] = []
  const counts = new Map<string, number>()
  let unclosed = 0
  let stray = 0
  const target = (): Seg[] => (stack.length > 0 ? stack[stack.length - 1].children : rootSegs)
  for (const node of nodes) {
    const bc = isComment(node) ? parseBlockComment(node.data) : null
    if (!bc) {
      target().push(node)
      continue
    }
    if (bc.kind === 'open') {
      const seg: BlockSeg = { block: bc, children: [] }
      target().push(seg)
      stack.push(seg)
      counts.set(bc.name, (counts.get(bc.name) ?? 0) + 1)
    } else if (bc.kind === 'self') {
      target().push({ block: bc, children: [] })
    } else if ((counts.get(bc.name) ?? 0) > 0) {
      for (;;) {
        const top = stack.pop() as BlockSeg
        counts.set(top.block.name, (counts.get(top.block.name) ?? 1) - 1)
        if (top.block.name === bc.name) break
        unclosed++
      }
    } else stray++
  }
  unclosed += stack.length
  if (unclosed > 0) warn(ctx, `${unclosed} Gutenberg block(s) were not closed; the rest of their container was used.`)
  if (stray > 0) warn(ctx, `${stray} Gutenberg close marker(s) had no opening marker and were ignored.`)
  return rootSegs
}

/** The plain DOM nodes of a segment tree in document order (block structure dropped), iterative. */
function flattenSegs(segs: Seg[]): ChildNode[] {
  const out: ChildNode[] = []
  const stack: Seg[] = []
  for (let i = segs.length - 1; i >= 0; i--) stack.push(segs[i])
  while (stack.length > 0) {
    const s = stack.pop() as Seg
    if (isBlockSeg(s)) for (let i = s.children.length - 1; i >= 0; i--) stack.push(s.children[i])
    else out.push(s)
  }
  return out
}

function walk(ctx: Ctx, nodes: ChildNode[], frame: Frame, col: Collector, out: LexicalNode[]): void {
  walkSegs(ctx, buildSegments(ctx, nodes), frame, col, out)
}

function walkSegs(ctx: Ctx, segs: Seg[], frame: Frame, col: Collector, out: LexicalNode[]): void {
  for (const seg of segs) {
    if (isBlockSeg(seg)) {
      if (frame.depth >= ctx.maxDepth) {
        // block nesting counts like element nesting: past the limit the content is flattened (block structure dropped)
        ctx.report.deepNestingFlattened++
        walk(ctx, flattenSegs(seg.children), frame, col, out)
      } else {
        handleBlock(ctx, seg.block, seg.children, { ...frame, depth: frame.depth + 1 }, col, out)
      }
      continue
    }
    const node = seg
    if (isText(node)) {
      handleText(ctx, node.value, frame, col)
      continue
    }
    if (isComment(node)) {
      const trimmed = node.data.trim()
      if (/^more(\s|$)/i.test(trimmed) || /^nextpage$/i.test(trimmed)) {
        ctx.report.moreMarkers++
        col.items.push({ kind: 'parabreak' })
      } else ctx.report.commentsDropped++
      continue
    }
    if (isElem(node)) walkElement(ctx, node, frame, col, out)
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

  if (tag === 'video' || tag === 'audio') {
    handleAvElement(ctx, el, col)
    return
  }
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
    const pc = ctx.pendingCaption
    let caps: ChildNode[][] = []
    if (pc && !pc.used) {
      pc.used = true
      caps = pc.captions
    }
    col.items.push({ kind: 'block', nodes: imageBlocks(ctx, el, caps, deeper) })
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
      flush(ctx, col, out)
      const hasImg = findAll(kids(el), (e) => e.tagName === 'img', 2)
      if (hasImg.length === 0) {
        const avEls = findAll(kids(el), (e) => e.tagName === 'video' || e.tagName === 'audio', 2)
        const avCaps = kids(el).filter((c): c is Elem => isElem(c) && c.tagName === 'figcaption')
        if (avEls.length === 1 && avCaps.length > 0) {
          // A figure around ONE video/audio: its figcaption is the block caption (kept as paragraphs when no block is written).
          const savedAv = ctx.pendingAvCaption
          const pendingAv = { text: squash(avCaps.map((c) => textContent(kids(c))).join(' ')), used: false }
          ctx.pendingAvCaption = pendingAv
          walk(ctx, kids(el).filter((c) => !(isElem(c) && c.tagName === 'figcaption')), deeper, col, out)
          flush(ctx, col, out)
          ctx.pendingAvCaption = savedAv
          if (!pendingAv.used) for (const c of avCaps) out.push(...captionParagraphs(ctx, kids(c), deeper))
          return
        }
        walk(ctx, kids(el), deeper, col, out)
        flush(ctx, col, out)
        return
      }
      // A figure with images: everything in it is walked in order (images, paragraphs, links, ...); the figcaption(s)
      // follow the image as separate paragraphs. A single image takes the captions itself.
      const capEls = kids(el).filter((c): c is Elem => isElem(c) && c.tagName === 'figcaption')
      const single = hasImg.length === 1 && capEls.length > 0
      const saved = ctx.pendingCaption
      const pending = single ? { captions: capEls.map((c) => kids(c)), used: false } : null
      ctx.pendingCaption = pending
      walk(ctx, kids(el).filter((c) => !(isElem(c) && c.tagName === 'figcaption')), deeper, col, out)
      flush(ctx, col, out)
      ctx.pendingCaption = saved
      if (!single || (pending && !pending.used)) {
        for (const c of capEls) out.push(...captionParagraphs(ctx, kids(c), deeper))
      }
      return
    }
    case 'a': {
      const href = (attr(el, 'href') ?? '').trim()
      let link = frame.link
      if (href.length > LINK_MAX_LENGTH) {
        ctx.extraConverted.push({ url: href.slice(0, 200), reason: `link address longer than ${LINK_MAX_LENGTH} characters` })
      } else if (href !== '') {
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

// ---------------------------------------------------------------------------------------------
// Audio and video (self-hosted files)
// ---------------------------------------------------------------------------------------------

type AvSpec = { tag: string; src: string; poster: string; caption: string; title: string }

/** Plain text for a block title/caption: markup characters and controls removed, bounded. */
function avPlain(text: string, max: number): string {
  return squash(stripControls(text).replace(/[<>]/g, '')).slice(0, max)
}

/** Attributes of a shortcode: `name="v"`, `name='v'`, `name=v`; a leading bare/quoted value counts as `src`. Names are lower case. */
function shortcodeAttrs(attrs: string, inner: string): Record<string, string> {
  const out: Record<string, string> = {}
  let rest = attrs.trim()
  const lead = /^=?\s*(?:"([^"]*)"|'([^']*)')/.exec(rest)
  if (lead) {
    out.src = (lead[1] ?? lead[2] ?? '').trim()
    rest = rest.slice(lead[0].length)
  }
  const re = /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+))/g
  let m: RegExpExecArray | null
  let guard = 0
  while ((m = re.exec(rest)) !== null && guard++ < 50) {
    const k = m[1].toLowerCase()
    if (!Object.prototype.hasOwnProperty.call(out, k)) out[k] = (m[2] ?? m[3] ?? m[4] ?? '').trim()
  }
  if (!out.src && inner.trim() && /^(https?:)?\/\/\S+$|^\/\S+$/.test(inner.trim())) out.src = inner.trim()
  return out
}

/** `[fvplayer src=".." splash=".." caption=".."]`, `[video mp4=".." poster=".."]`, `[audio src=".."]`. */
function avFromShortcode(ctx: Ctx, tag: string, attrs: string, inner: string, col: Collector): void {
  const a = shortcodeAttrs(attrs, inner)
  const candidates = [a.src, a.mp4, a.webm, a.m4a, a.mp3, a.ogg, a.oga, a.m4v, a.url].filter((v): v is string => typeof v === 'string' && v !== '')
  const src = candidates.find((c) => avKindFromPath(c) !== null) ?? candidates[0]
  if (!src) return
  emitAv(ctx, { tag, src, poster: a.poster ?? a.splash ?? '', caption: a.caption ?? '', title: a.title ?? '' }, col)
}

/** `<video>` / `<audio>` with `src` or `<source>` children, an optional `poster`, `title`, and the caption of its figure. */
function handleAvElement(ctx: Ctx, el: Elem, col: Collector): void {
  const sources = [el, ...findAll(kids(el), (e) => e.tagName === 'source', 10)]
    .map((e) => (attr(e, 'src') ?? attr(e, 'data-src') ?? '').trim())
    .filter((s) => s !== '')
  const src = sources.find((s) => avKindFromPath(s) !== null) ?? sources[0]
  if (!src) {
    bump(ctx.report.droppedElements, el.tagName)
    return
  }
  const pc = ctx.pendingAvCaption
  let caption = ''
  if (pc && !pc.used) {
    caption = pc.text
    pc.used = true
  }
  emitAv(ctx, { tag: el.tagName, src, poster: (attr(el, 'poster') ?? '').trim(), caption, title: squash(attr(el, 'title') ?? attr(el, 'aria-label') ?? '') }, col)
}

/** Address kept in a block that has no media file: absolute http(s) or root-relative, protocol-relative made https. */
function avSourceUrl(raw: string): string | null {
  const t = raw.trim()
  const full = t.startsWith('//') ? `https:${t}` : t
  return isSafeAvUrl(full) ? full : null
}

function emitAv(ctx: Ctx, spec: AvSpec, col: Collector): void {
  const src = spec.src.trim()
  const yt = extractYoutubeId(src)
  if (yt) {
    ctx.report.youtube++
    col.items.push({ kind: 'block', nodes: [youtubeBlock(yt, ctx.ytIndex++, undefined)] })
    return
  }
  const kind = avKindFromPath(src)
  if (kind === null) {
    // Not a type the CMS hosts (another site's player page, .mov, .wav, a stream): a link when safe, else dropped. Counted.
    ctx.report.audioVideo.unsupported++
    otherEmbed(ctx, src.startsWith('//') ? `https:${src}` : src, spec.tag, col)
    return
  }
  const caption = avPlain(withoutShortcodes(ctx, spec.caption, false), AV_CAPTION_MAX)
  const articleTitle = ctx.opts.articleTitle ? avPlain(ctx.opts.articleTitle, AV_TITLE_MAX) : ''
  const title = avPlain(spec.title, AV_TITLE_MAX) || avPlain(caption, AV_TITLE_MAX) || articleTitle || (kind === 'audio' ? 'Audio' : 'Video')
  const index = ctx.avIndex++
  const fields: Json = {
    id: createHash('sha1').update(`av:${index}:${kind}:${src}`).digest('hex').slice(0, 24),
    blockName: '',
    blockType: AV_BLOCK_SLUG,
    kind,
  }
  let resolved: { mediaId: number } | null = null
  if (ctx.opts.resolveMedia) {
    try {
      resolved = ctx.opts.resolveMedia(src, { kind, title, caption, articleTitle: ctx.opts.articleTitle })
    } catch {
      resolved = null
    }
  }
  if (resolved && Number.isInteger(resolved.mediaId) && resolved.mediaId >= 1 && resolved.mediaId <= 2147483647) {
    fields.media = resolved.mediaId
    ctx.report.audioVideo.resolved++
  } else {
    const url = avSourceUrl(src)
    if (url === null) {
      ctx.report.embeds.dropped.push({ reason: `${spec.tag} without a safe address` })
      return
    }
    fields.sourceUrl = url
    ctx.report.audioVideo.unresolvedMedia++
  }
  const posterSrc = spec.poster.trim()
  if (posterSrc && !/^(data|javascript|vbscript):/i.test(posterSrc)) {
    try {
      const p = ctx.opts.resolveImage(posterSrc, { alt: '', caption: '', articleTitle: ctx.opts.articleTitle })
      if (p && Number.isInteger(p.mediaId) && p.mediaId >= 1 && p.mediaId <= 2147483647) {
        fields.poster = p.mediaId
        ctx.report.images.resolved++
      } else {
        ctx.report.images.unresolved.push({ src: posterSrc.slice(0, 500), reason: 'poster: resolveImage returned no media' })
      }
    } catch {
      ctx.report.images.unresolved.push({ src: posterSrc.slice(0, 500), reason: 'poster: resolveImage failed' })
    }
  }
  fields.title = title
  if (caption !== '' && avTextProblem(caption, 'caption', AV_CAPTION_MAX) === null) fields.caption = caption
  col.items.push({ kind: 'block', nodes: [{ type: 'block', version: 2, format: '', fields }] })
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
