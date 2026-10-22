/**
 * Embedded media in article bodies (go-live contract C1.1).
 *
 * The only embed the CMS accepts is the registered Lexical block `youtubeEmbed` (`videoId`, optional `title`).
 * The player URL is rebuilt by the public renderer from the id; a URL is never stored. Everything else that
 * looks like an embed (a raw `embed` node as emitted by the archive importer, an `iframe`-like node, an unknown
 * block or inline block) is refused on write, so arbitrary third-party URLs cannot enter the body through the
 * API or the admin editor. (Trusted seed/system calls skip the check, so the admin editor can still meet a
 * stored node it cannot load if such a call wrote one; the importer must not.)
 *
 * Pure and defensive: never throws on malformed input. The walk is depth-bounded and a body nested deeper than
 * the bound is REFUSED, never silently accepted (a node past the bound could otherwise hide an embed).
 */

export const YOUTUBE_BLOCK_SLUG = 'youtubeEmbed'
export const YOUTUBE_TITLE_MAX = 120

/** Exactly 11 characters from [A-Za-z0-9_-]. */
export const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/

export const EMBED_REFUSED_MESSAGE = 'Embeds other than YouTube are not accepted.'

/**
 * Maximum nesting of the body (counted over every object and array level, the same count `collectUploadNodes`
 * uses, so no upload node can sit past a level that this check has not refused). Ordinary articles use well under
 * half of it: a table cell paragraph text is about 11 levels, each extra list level adds 4.
 */
export const BODY_MAX_DEPTH = 64

export const BODY_TOO_DEEP_MESSAGE = `The article body is nested too deeply (more than ${BODY_MAX_DEPTH} levels).`

// Node types that are embed-like (case-insensitive substring: html, rawhtml, iframe, embed, script, object,
// video, audio, ...). `block` / `inlineBlock` are judged by their `blockType` instead.
const EMBED_LIKE_TYPE_RE = /(html|iframe|embed|video|audio|youtube|vimeo|oembed|frame|widget|script|object)/i

/** Keys a `youtubeEmbed` block's `fields` may carry (Payload adds `id` and `blockName`). */
const YOUTUBE_FIELD_KEYS = new Set(['id', 'blockName', 'blockType', 'videoId', 'title'])
const URL_LIKE_KEY_RE = /^(url|href|src|link|embedurl)$/i

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/

export const isYoutubeVideoId = (value: unknown): value is string =>
  typeof value === 'string' && YOUTUBE_ID_RE.test(value)

/** A message when the title is not acceptable, else `null`. The title is optional plain text, at most 120 characters. */
export function youtubeTitleProblem(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') return 'The YouTube block title must be plain text.'
  if (value.length > YOUTUBE_TITLE_MAX) return `The YouTube block title must be at most ${YOUTUBE_TITLE_MAX} characters.`
  if (/[<>]/.test(value) || CONTROL_RE.test(value)) {
    return 'The YouTube block title must be plain text (no markup or control characters).'
  }
  return null
}

/** Field-level validators for the block definition (return `true` or a message), shared with the schema. */
export const validateVideoId = (value: unknown): true | string =>
  isYoutubeVideoId(value) ? true : 'The YouTube video id must be exactly 11 characters: letters, numbers, "-" or "_".'

export const validateYoutubeTitle = (value: unknown): true | string => youtubeTitleProblem(value) ?? true

export const UNSAFE_LINK_MESSAGE = 'Links must use http, https or mailto addresses (or a relative path or #fragment).'

const SAFE_LINK_SCHEMES = new Set(['http', 'https', 'mailto'])

/**
 * True when a link target is acceptable: an http(s) or mailto address, a relative path, a query or a #fragment.
 * Browsers strip tabs, newlines and leading control characters / spaces before reading the scheme, so they are
 * stripped here too ("java<TAB>script:" is javascript:). Anything with another scheme (javascript:, data:, vbscript:,
 * file:, tel:, ...) is refused.
 */
export function isSafeLinkUrl(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true
  if (typeof value !== 'string') return false
  // eslint-disable-next-line no-control-regex
  const v = value.replace(/[\u0000-\u0020\u007F-\u009F]+/g, '')
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(v)
  if (!scheme) return true
  return SAFE_LINK_SCHEMES.has(scheme[1].toLowerCase())
}

/**
 * Returns the first problem found in the body (a message suitable for a 400), or `null` when every embed-like
 * node is a well-formed `youtubeEmbed` block. Absent content returns `null` (nothing to check).
 */
export function findEmbedProblem(content: unknown): string | null {
  let problem: string | null = null

  const walk = (node: unknown, depth: number) => {
    if (problem !== null || node === null || typeof node !== 'object') return
    if (depth > BODY_MAX_DEPTH) {
      problem = BODY_TOO_DEEP_MESSAGE
      return
    }
    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth + 1)
      return
    }
    const rec = node as Record<string, unknown>
    const type = rec.type
    if (typeof type === 'string') {
      if (type === 'block' || type === 'inlineBlock') {
        const fields =
          rec.fields !== null && typeof rec.fields === 'object' && !Array.isArray(rec.fields)
            ? (rec.fields as Record<string, unknown>)
            : {}
        if (type === 'inlineBlock' || fields.blockType !== YOUTUBE_BLOCK_SLUG) {
          problem = EMBED_REFUSED_MESSAGE
          return
        }
        // A YouTube block is a leaf holding an id and a title: no children, no URL-like members anywhere.
        if (
          (Array.isArray(rec.children) && rec.children.length > 0) ||
          (rec.children !== undefined && !Array.isArray(rec.children)) ||
          Object.keys(rec).some((k) => URL_LIKE_KEY_RE.test(k))
        ) {
          problem = 'A YouTube block must not carry children or URL fields.'
          return
        }
        const extra = Object.keys(fields).filter((k) => !YOUTUBE_FIELD_KEYS.has(k))
        if (extra.length > 0) {
          problem = `A YouTube block has unexpected fields (${extra.slice(0, 3).join(', ')}).`
          return
        }
        if (!isYoutubeVideoId(fields.videoId)) {
          problem =
            'A YouTube block has an invalid video id (expected exactly 11 characters from A-Z, a-z, 0-9, "-" and "_").'
          return
        }
        problem = youtubeTitleProblem(fields.title)
        return // a valid block has no children to inspect
      }
      if (type === 'link' || type === 'autolink') {
        const f = rec.fields !== null && typeof rec.fields === 'object' ? (rec.fields as Record<string, unknown>) : {}
        if (!isSafeLinkUrl(f.url) || !isSafeLinkUrl(rec.url)) {
          problem = UNSAFE_LINK_MESSAGE
          return
        }
      }
      if (EMBED_LIKE_TYPE_RE.test(type)) {
        problem = EMBED_REFUSED_MESSAGE
        return
      }
    }
    for (const key of Object.keys(rec)) {
      const child = rec[key]
      if (child !== null && typeof child === 'object') walk(child, depth + 1)
    }
  }

  walk(content, 0)
  return problem
}

/** The distinct `videoId`s of the valid `youtubeEmbed` blocks in the body, in document order. */
export function collectYoutubeIds(content: unknown): string[] {
  const ids: string[] = []
  const walk = (node: unknown, depth: number) => {
    if (depth > BODY_MAX_DEPTH || node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth + 1)
      return
    }
    const rec = node as Record<string, unknown>
    if (rec.type === 'block' && rec.fields !== null && typeof rec.fields === 'object') {
      const f = rec.fields as Record<string, unknown>
      if (f.blockType === YOUTUBE_BLOCK_SLUG && isYoutubeVideoId(f.videoId) && !ids.includes(f.videoId)) {
        ids.push(f.videoId)
      }
    }
    for (const key of Object.keys(rec)) {
      const child = rec[key]
      if (child !== null && typeof child === 'object') walk(child, depth + 1)
    }
  }
  walk(content, 0)
  return ids
}
