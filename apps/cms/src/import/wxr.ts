import fs from 'node:fs'

import sax from 'sax'

/**
 * Streaming, safe reader for a WordPress WXR 1.2 export (go-live contract C1.3, C2, C6).
 *
 * - STREAMING: the file is read in chunks and records are yielded one by one; the file is never held in memory.
 * - SAFE: any DOCTYPE or ENTITY declaration is refused outright (XXE, billion laughs); limits on file size, single item
 *   size, item count and element depth; no network access and no file writes anywhere in this module.
 * - PRIVACY: commenter email, URL and IP address, and author email, are never read. The output types have no field
 *   for them, so no later stage can leak them.
 * - Errors are `WxrError` with a SHORT code as the whole message. Nothing from the file ever appears in an error.
 */

export type WxrErrorCode =
  | 'WXR_UNREADABLE'
  | 'WXR_FILE_TOO_LARGE'
  | 'WXR_DOCTYPE'
  | 'WXR_ITEM_TOO_LARGE'
  | 'WXR_TOO_MANY_ITEMS'
  | 'WXR_TOO_DEEP'
  | 'WXR_MALFORMED'
  | 'WXR_TRUNCATED'
  | 'WXR_NOT_WXR'
  | 'WXR_ENCODING'

export class WxrError extends Error {
  readonly code: WxrErrorCode
  constructor(code: WxrErrorCode) {
    super(code)
    this.name = 'WxrError'
    this.code = code
  }
}

export type WxrLimits = {
  maxFileBytes: number
  maxItemBytes: number
  maxItems: number
  maxDepth: number
}

export const DEFAULT_WXR_LIMITS: Readonly<WxrLimits> = {
  maxFileBytes: 2 * 1024 * 1024 * 1024,
  maxItemBytes: 20 * 1024 * 1024,
  maxItems: 500_000,
  maxDepth: 32,
}

export type WxrKind = 'post' | 'page' | 'attachment' | 'nav_menu_item' | 'other'

/** 'localTime': GMT date was zero, `post_date` (site local time) was used as if UTC. 'missing': no usable date. */
export type WxrDateIssue = 'localTime' | 'missing'
export type WxrItemIssue = 'badId' | 'dateLocalTime' | 'dateMissing'

export type WxrTerm = { name: string; nicename: string }

/** Deliberately has NO email, url or IP field. */
export type WxrComment = {
  id: number | null
  parentId: number | null
  authorName: string
  content: string
  /** ISO 8601 UTC, or null. */
  dateGmt: string | null
  dateIssue: WxrDateIssue | null
  /** Raw `wp:comment_approved`: '1', '0', 'spam', 'trash', ... */
  approved: string
  /** `wp:comment_type`; an empty value is normalised to 'comment'. */
  type: string
}

export type WxrAttachment = {
  url: string | null
  altText: string | null
  /** `_wp_attached_file`, for example `2023/10/photo.jpg`. */
  attachedFile: string | null
}

export type WxrSeo = {
  rankMathTitle: string | null
  rankMathDescription: string | null
  yoastTitle: string | null
  yoastDescription: string | null
}

export type WxrItem = {
  kind: WxrKind
  wpId: number | null
  title: string
  /** `wp:post_name` */
  slug: string
  /** `wp:status`: publish, draft, private, pending, future, trash, auto-draft, inherit, ... */
  status: string
  postType: string
  link: string
  guid: string
  /** ISO 8601 UTC (`...T..:..:...000Z`), or null. */
  dateGmt: string | null
  dateIssue: WxrDateIssue | null
  modifiedGmt: string | null
  /** `dc:creator` (login name). */
  author: string
  contentHtml: string
  excerptHtml: string
  categories: WxrTerm[]
  tags: WxrTerm[]
  thumbnailId: number | null
  seo: WxrSeo
  /** True when the post has a password. The password itself is never read. */
  hasPassword: boolean
  parentId: number | null
  attachment: WxrAttachment | null
  comments: WxrComment[]
  issues: WxrItemIssue[]
}

export type WxrChannelCategory = { termId: number | null; nicename: string; parentNicename: string; name: string }
/** No email, first or last name: only what is needed to map `dc:creator`. */
export type WxrChannelAuthor = { authorId: number | null; login: string; displayName: string }
export type WxrSite = { wxrVersion: string; baseSiteUrl: string; baseBlogUrl: string }

export type WxrRecord =
  | { record: 'site'; site: WxrSite }
  | { record: 'category'; category: WxrChannelCategory }
  | { record: 'author'; author: WxrChannelAuthor }
  | { record: 'item'; item: WxrItem }

// ---------------------------------------------------------------------------------------------
// dates
// ---------------------------------------------------------------------------------------------

const WP_DATE_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/

/** Parse `YYYY-MM-DD HH:MM:SS` as UTC. The WordPress zero date and impossible dates give null. */
export function parseWpDate(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const m = WP_DATE_RE.exec(value.trim())
  if (!m) return null
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number)
  if (y === 0) return null
  const ms = Date.UTC(y, mo - 1, d, h, mi, s)
  const dt = new Date(ms)
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== mo - 1 ||
    dt.getUTCDate() !== d ||
    dt.getUTCHours() !== h ||
    dt.getUTCMinutes() !== mi ||
    dt.getUTCSeconds() !== s
  ) {
    return null
  }
  return dt.toISOString()
}

function resolveDate(gmt: string, local: string): { iso: string | null; issue: WxrDateIssue | null } {
  const g = parseWpDate(gmt)
  if (g) return { iso: g, issue: null }
  const l = parseWpDate(local)
  if (l) return { iso: l, issue: 'localTime' }
  return { iso: null, issue: 'missing' }
}

// ---------------------------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------------------------

const META_KEYS = new Set([
  '_thumbnail_id',
  'rank_math_title',
  'rank_math_description',
  '_yoast_wpseo_title',
  '_yoast_wpseo_metadesc',
  '_wp_attachment_image_alt',
  '_wp_attached_file',
])
const META_VALUE_CAP = 16 * 1024
const CHANNEL_RECORD_CAP = 64 * 1024
const PREFIX_CAP = 1024 * 1024
const MAX_ATTRS_PER_TAG = 64
const MAX_ATTR_BYTES_PER_TAG = 64 * 1024
const MAX_COMMENTS_PER_ITEM = 50_000
/** Fixed cost charged per element so that tag spam is bounded by the item size limit. */
const ELEMENT_OVERHEAD = 16

const ITEM_FIELDS: Record<string, string> = {
  title: 'title',
  link: 'link',
  guid: 'guid',
  'dc:creator': 'author',
  'content:encoded': 'content',
  'excerpt:encoded': 'excerpt',
  'wp:post_id': 'postId',
  'wp:post_date': 'date',
  'wp:post_date_gmt': 'dateGmt',
  'wp:post_modified_gmt': 'modifiedGmt',
  'wp:post_name': 'slug',
  'wp:status': 'status',
  'wp:post_type': 'postType',
  'wp:post_parent': 'parent',
  'wp:attachment_url': 'attachmentUrl',
}
const COMMENT_FIELDS: Record<string, string> = {
  'wp:comment_id': 'id',
  'wp:comment_parent': 'parent',
  'wp:comment_author': 'author',
  'wp:comment_content': 'content',
  'wp:comment_date_gmt': 'dateGmt',
  'wp:comment_date': 'date',
  'wp:comment_approved': 'approved',
  'wp:comment_type': 'type',
}
const CHAN_CAT_FIELDS: Record<string, string> = {
  'wp:term_id': 'termId',
  'wp:category_nicename': 'nicename',
  'wp:category_parent': 'parent',
  'wp:cat_name': 'name',
}
const CHAN_AUTHOR_FIELDS: Record<string, string> = {
  'wp:author_id': 'id',
  'wp:author_login': 'login',
  'wp:author_display_name': 'displayName',
}
const SITE_FIELDS: Record<string, string> = {
  'wp:wxr_version': 'wxrVersion',
  'wp:base_site_url': 'baseSiteUrl',
  'wp:base_blog_url': 'baseBlogUrl',
}

type Fields = Record<string, string>

const toInt = (v: string | undefined): number | null => {
  if (v === undefined) return null
  const t = v.trim()
  return /^\d{1,15}$/.test(t) ? Number(t) : null
}
const orNull = (v: string | undefined): string | null => {
  const t = (v ?? '').trim()
  return t === '' ? null : t
}

function kindOf(postType: string): WxrKind {
  return postType === 'post' || postType === 'page' || postType === 'attachment' || postType === 'nav_menu_item'
    ? postType
    : 'other'
}

type ItemDraft = {
  f: Fields
  categories: WxrTerm[]
  tags: WxrTerm[]
  meta: Map<string, string>
  comments: WxrComment[]
}

function finalizeItem(d: ItemDraft): WxrItem {
  const f = d.f
  const postType = (f.postType ?? '').trim()
  const kind = kindOf(postType)
  const wpId = toInt(f.postId)
  const date = resolveDate(f.dateGmt ?? '', f.date ?? '')
  const issues: WxrItemIssue[] = []
  if (wpId === null) issues.push('badId')
  if (date.issue === 'localTime') issues.push('dateLocalTime')
  if (date.issue === 'missing') issues.push('dateMissing')
  const m = d.meta
  return {
    kind,
    wpId,
    title: (f.title ?? '').trim(),
    slug: (f.slug ?? '').trim(),
    status: (f.status ?? '').trim(),
    postType,
    link: (f.link ?? '').trim(),
    guid: (f.guid ?? '').trim(),
    dateGmt: date.iso,
    dateIssue: date.issue,
    modifiedGmt: parseWpDate(f.modifiedGmt),
    author: (f.author ?? '').trim(),
    contentHtml: f.content ?? '',
    excerptHtml: f.excerpt ?? '',
    categories: d.categories,
    tags: d.tags,
    thumbnailId: toInt(m.get('_thumbnail_id')),
    seo: {
      rankMathTitle: orNull(m.get('rank_math_title')),
      rankMathDescription: orNull(m.get('rank_math_description')),
      yoastTitle: orNull(m.get('_yoast_wpseo_title')),
      yoastDescription: orNull(m.get('_yoast_wpseo_metadesc')),
    },
    hasPassword: (f.password ?? '') !== '',
    parentId: toInt(f.parent),
    attachment:
      kind === 'attachment'
        ? {
            url: orNull(f.attachmentUrl),
            altText: orNull(m.get('_wp_attachment_image_alt')),
            attachedFile: orNull(m.get('_wp_attached_file')),
          }
        : null,
    comments: d.comments,
    issues,
  }
}

/** Remove complete `<!-- ... -->` comments in linear time; an unterminated comment drops the rest of the text. */
function stripComments(s: string): string {
  let out = ''
  let i = 0
  for (;;) {
    const open = s.indexOf('<!--', i)
    if (open < 0) return out + s.slice(i)
    out += s.slice(i, open)
    const close = s.indexOf('-->', open + 4)
    if (close < 0) return out
    i = close + 3
  }
}

/**
 * Parse a WXR byte or string stream. Yields site header, channel categories and authors, and items in file order.
 * Throws `WxrError` (code only) on any violation; records already yielded stay valid.
 */
export async function* parseWxrStream(
  source: AsyncIterable<Uint8Array | string>,
  options: Partial<WxrLimits> = {},
): AsyncGenerator<WxrRecord> {
  const limits: WxrLimits = { ...DEFAULT_WXR_LIMITS, ...options }
  const queue: WxrRecord[] = []
  const decoder = new TextDecoder('utf-8') // strips a leading BOM; invalid bytes become U+FFFD
  const parser = sax.parser(true, {})

  const stack: string[] = []
  let rootSeen = false
  let rootClosed = false
  let itemCount = 0
  let recordBytes = 0
  let recordCap = 0
  let buf: string[] | null = null
  let bufBytes = 0
  let bufCap = Infinity

  let item: ItemDraft | null = null
  let comment: Fields | null = null
  let meta: { key: string; value: string } | null = null
  let term: { domain: string; nicename: string } | null = null
  let chanCat: Fields | null = null
  let chanAuthor: Fields | null = null
  const site: Fields = {}

  const fail = (code: WxrErrorCode): never => {
    throw new WxrError(code)
  }
  const addSize = (n: number) => {
    if (item === null && chanCat === null && chanAuthor === null) return
    recordBytes += n
    if (recordBytes > recordCap) fail('WXR_ITEM_TOO_LARGE')
  }
  const capture = (cap = Infinity) => {
    buf = []
    bufBytes = 0
    bufCap = cap
    bufDropped = false
  }
  let bufDropped = false
  let pwActive = false
  let pwSet = false
  let attrCount = 0
  let attrBytes = 0
  const onText = (t: string) => {
    if (item || chanCat || chanAuthor) addSize(t.length)
    if (pwActive && t.length > 0) pwSet = true // the password text itself is never buffered
    if (buf !== null) {
      if (bufBytes < bufCap) {
        bufBytes += t.length
        buf.push(t)
      } else if (t.length > 0) {
        bufDropped = true
      }
    }
  }

  parser.onerror = (err) => {
    const msg = String(err?.message ?? '')
    if (/doctype/i.test(msg)) fail('WXR_DOCTYPE')
    fail(rootSeen ? 'WXR_MALFORMED' : 'WXR_NOT_WXR')
  }
  parser.ondoctype = () => fail('WXR_DOCTYPE')
  // Any other `<!NAME ...>` declaration (for example a stray `<!ENTITY ...>`) is refused too.
  parser.onsgmldeclaration = () => fail('WXR_DOCTYPE')
  parser.ontext = onText
  parser.oncdata = onText
  // Attributes are counted against a per-tag cap everywhere, and against the record size inside items and channel records.
  parser.onattribute = (a) => {
    const n = a.name.length + a.value.length + ELEMENT_OVERHEAD
    attrCount += 1
    attrBytes += n
    if (attrCount > MAX_ATTRS_PER_TAG || attrBytes > MAX_ATTR_BYTES_PER_TAG) fail('WXR_ITEM_TOO_LARGE')
    addSize(n)
  }

  parser.onopentag = (tag) => {
    const name = tag.name
    attrCount = 0
    attrBytes = 0
    stack.push(name)
    const depth = stack.length
    if (depth > limits.maxDepth) fail('WXR_TOO_DEEP')
    rootSeen = true
    buf = null
    if (depth === 1) {
      if (name !== 'rss') fail('WXR_NOT_WXR')
      return
    }
    if (depth === 2 && name !== 'channel') return
    if (item || chanCat || chanAuthor) addSize(name.length + ELEMENT_OVERHEAD)
    const parent = stack[depth - 2]

    if (depth === 3 && stack[1] === 'channel') {
      if (name === 'item') {
        itemCount += 1
        if (itemCount > limits.maxItems) fail('WXR_TOO_MANY_ITEMS')
        item = { f: {}, categories: [], tags: [], meta: new Map(), comments: [] }
        recordBytes = 0
        recordCap = limits.maxItemBytes
      } else if (name === 'wp:category') {
        chanCat = {}
        recordBytes = 0
        recordCap = CHANNEL_RECORD_CAP
      } else if (name === 'wp:author') {
        chanAuthor = {}
        recordBytes = 0
        recordCap = CHANNEL_RECORD_CAP
      } else if (SITE_FIELDS[name]) {
        capture(4096)
      }
      return
    }
    if (depth === 4 && item && parent === 'item') {
      if (name === 'wp:comment') {
        if (item.comments.length >= MAX_COMMENTS_PER_ITEM) fail('WXR_ITEM_TOO_LARGE')
        comment = {}
      } else if (name === 'wp:post_password') {
        pwActive = true
        pwSet = false
      } else if (name === 'wp:postmeta') meta = { key: '', value: '' }
      else if (name === 'category') {
        term = { domain: tag.attributes.domain ?? '', nicename: tag.attributes.nicename ?? '' }
        capture(1024)
      } else if (ITEM_FIELDS[name]) capture()
      return
    }
    if (depth === 4 && chanCat && parent === 'wp:category' && CHAN_CAT_FIELDS[name]) return capture(1024)
    if (depth === 4 && chanAuthor && parent === 'wp:author' && CHAN_AUTHOR_FIELDS[name]) return capture(1024)
    if (depth === 5 && comment && parent === 'wp:comment' && COMMENT_FIELDS[name]) return capture()
    if (depth === 5 && meta && parent === 'wp:postmeta') {
      if (name === 'wp:meta_key') capture(256)
      else if (name === 'wp:meta_value') capture(META_VALUE_CAP)
    }
  }

  parser.onclosetag = (name) => {
    const depth = stack.length
    const parent = depth >= 2 ? stack[depth - 2] : ''
    let value = buf === null ? null : (buf as string[]).join('')
    if (value !== null && Number.isFinite(bufCap)) {
      const over = bufDropped || value.length > bufCap
      // A meta value over its cap is dropped (a truncated SEO text would be wrong); other capped fields are cut.
      if (over) value = name === 'wp:meta_value' ? '' : value.slice(0, bufCap)
    }
    buf = null
    if (name === 'wp:post_password' && depth === 4 && item) {
      item.f.password = pwSet ? '1' : ''
      pwActive = false
    }

    if (depth === 5 && comment && parent === 'wp:comment' && value !== null && COMMENT_FIELDS[name]) {
      comment[COMMENT_FIELDS[name]] = value
    } else if (depth === 5 && meta && parent === 'wp:postmeta' && value !== null) {
      if (name === 'wp:meta_key') meta.key = value.trim()
      else if (name === 'wp:meta_value') meta.value = value
    } else if (depth === 4 && item && parent === 'item') {
      if (name === 'wp:comment' && comment) {
        const c = comment
        const date = resolveDate(c.dateGmt ?? '', c.date ?? '')
        item.comments.push({
          id: toInt(c.id),
          parentId: toInt(c.parent),
          authorName: (c.author ?? '').trim(),
          content: c.content ?? '',
          dateGmt: date.iso,
          dateIssue: date.issue,
          approved: (c.approved ?? '').trim(),
          type: (c.type ?? '').trim() || 'comment',
        })
        comment = null
      } else if (name === 'wp:postmeta' && meta) {
        if (META_KEYS.has(meta.key)) item.meta.set(meta.key, meta.value)
        meta = null
      } else if (name === 'category' && term) {
        const t: WxrTerm = { name: (value ?? '').trim(), nicename: term.nicename.trim() }
        if (term.domain === 'category') item.categories.push(t)
        else if (term.domain === 'post_tag') item.tags.push(t)
        term = null
      } else if (value !== null && ITEM_FIELDS[name]) {
        item.f[ITEM_FIELDS[name]] = value
      }
    } else if (depth === 4 && chanCat && value !== null && CHAN_CAT_FIELDS[name]) {
      chanCat[CHAN_CAT_FIELDS[name]] = value
    } else if (depth === 4 && chanAuthor && value !== null && CHAN_AUTHOR_FIELDS[name]) {
      chanAuthor[CHAN_AUTHOR_FIELDS[name]] = value
    } else if (depth === 3 && stack[1] === 'channel') {
      if (name === 'item' && item) {
        queue.push({ record: 'item', item: finalizeItem(item) })
        item = null
        comment = meta = term = null
      } else if (name === 'wp:category' && chanCat) {
        queue.push({
          record: 'category',
          category: {
            termId: toInt(chanCat.termId),
            nicename: (chanCat.nicename ?? '').trim(),
            parentNicename: (chanCat.parent ?? '').trim(),
            name: (chanCat.name ?? '').trim(),
          },
        })
        chanCat = null
      } else if (name === 'wp:author' && chanAuthor) {
        queue.push({
          record: 'author',
          author: {
            authorId: toInt(chanAuthor.id),
            login: (chanAuthor.login ?? '').trim(),
            displayName: (chanAuthor.displayName ?? '').trim(),
          },
        })
        chanAuthor = null
      } else if (value !== null && SITE_FIELDS[name]) {
        site[SITE_FIELDS[name]] = value.trim()
      }
    } else if (depth === 2 && name === 'channel') {
      queue.push({
        record: 'site',
        site: { wxrVersion: site.wxrVersion ?? '', baseSiteUrl: site.baseSiteUrl ?? '', baseBlogUrl: site.baseBlogUrl ?? '' },
      })
    } else if (depth === 1) {
      rootClosed = true
    }
    stack.pop()
  }

  // Raw pre-root scan: a DOCTYPE or ENTITY can only legally appear before the root element, so refuse it before the
  // XML parser accumulates it. (After the root, `sax` itself refuses a DOCTYPE and any `<!ENTITY`.)
  let carry = ''
  let prefixLen = 0
  let bytes = 0
  let first = true
  let headBytes: Buffer = Buffer.alloc(0)
  let head = ''
  let declChecked = false
  const feed = (text: string) => {
    if (!declChecked) {
      // Only UTF-8 is accepted: refuse a declared encoding other than UTF-8 (the stream is decoded as UTF-8).
      head += text
      const end = head.indexOf('?>')
      if (end >= 0 || head.length >= 512) {
        declChecked = true
        const m = /^\s*<\?xml[^>]*?\sencoding\s*=\s*["']([^"']*)["']/i.exec(head.slice(0, end >= 0 ? end + 2 : 512))
        if (m && !/^utf-?8$/i.test(m[1].trim())) fail('WXR_ENCODING')
        head = ''
      }
    }
    if (!rootSeen) {
      if (text.includes('\u0000')) fail('WXR_ENCODING')
      // Complete comments are removed first, so `<!-- <a --><!DOCTYPE r>` cannot hide a DOCTYPE behind a fake tag.
      const combined = stripComments(carry + text)
      prefixLen += text.length
      const idx = combined.search(/<[A-Za-z_]/)
      const region = idx < 0 ? combined : combined.slice(0, idx)
      if (/<!(?:DOCTYPE|ENTITY)/i.test(region)) fail('WXR_DOCTYPE')
      if (idx < 0) {
        if (prefixLen > PREFIX_CAP) fail('WXR_NOT_WXR')
        carry = combined.slice(-10)
      } else {
        carry = ''
      }
    }
    parser.write(text)
  }

  for await (const chunk of source) {
    let text: string
    if (typeof chunk === 'string') {
      bytes += Buffer.byteLength(chunk)
      text = chunk
    } else {
      bytes += chunk.byteLength
      text = decoder.decode(chunk, { stream: true })
    }
    if (bytes > limits.maxFileBytes) fail('WXR_FILE_TOO_LARGE')
    if (typeof chunk !== 'string' && headBytes.length < 4) {
      headBytes = Buffer.concat([headBytes, Buffer.from(chunk.subarray(0, 4 - headBytes.length))])
      // UTF-16 / UTF-32 byte order marks (FF FE, FE FF): refuse rather than decode garbage.
      if (headBytes.length >= 2 && ((headBytes[0] === 0xff && headBytes[1] === 0xfe) || (headBytes[0] === 0xfe && headBytes[1] === 0xff))) {
        fail('WXR_ENCODING')
      }
    }
    if (first && typeof chunk === 'string' && text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    first = false
    if (text.length > 0) feed(text)
    while (queue.length > 0) yield queue.shift() as WxrRecord
  }
  const tail = decoder.decode()
  if (tail.length > 0) feed(tail)
  if (!rootSeen) fail('WXR_NOT_WXR')
  try {
    parser.close()
  } catch (err) {
    if (err instanceof WxrError) {
      if (err.code === 'WXR_MALFORMED') throw new WxrError('WXR_TRUNCATED')
      throw err
    }
    throw new WxrError('WXR_MALFORMED')
  }
  if (!rootClosed) fail('WXR_TRUNCATED')
  while (queue.length > 0) yield queue.shift() as WxrRecord
}

/** Stream a WXR file from disk. Read-only; the path must be a regular file within `maxFileBytes`. */
export async function* readWxrFile(filePath: string, options: Partial<WxrLimits> = {}): AsyncGenerator<WxrRecord> {
  const limits: WxrLimits = { ...DEFAULT_WXR_LIMITS, ...options }
  let size: number
  try {
    const st = fs.statSync(filePath)
    if (!st.isFile()) throw new WxrError('WXR_UNREADABLE')
    size = st.size
  } catch (err) {
    if (err instanceof WxrError) throw err
    throw new WxrError('WXR_UNREADABLE')
  }
  if (size > limits.maxFileBytes) throw new WxrError('WXR_FILE_TOO_LARGE')
  const stream = fs.createReadStream(filePath, { highWaterMark: 256 * 1024 })
  try {
    yield* parseWxrStream(stream, options)
  } catch (err) {
    if (err instanceof WxrError) throw err
    throw new WxrError('WXR_UNREADABLE')
  } finally {
    stream.destroy()
  }
}
