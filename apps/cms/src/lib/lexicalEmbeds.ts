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

import { AV_BLOCK_SLUG, AV_CAPTION_MAX, AV_KINDS, AV_TITLE_MAX, avTextProblem, isSafeAvUrl } from './avMedia'

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

/** Keys an `audioVideo` block's `fields` may carry (Payload adds `id` and `blockName`). */
const AV_FIELD_KEYS = new Set([
  'id', 'blockName', 'blockType', 'kind', 'media', 'sourceUrl', 'poster', 'title', 'caption', 'transcriptUrl', 'duration',
])

/** Id of a relationship value: a number, or a populated object carrying one. */
const relId = (v: unknown): unknown => (v !== null && typeof v === 'object' && 'id' in (v as object) ? (v as { id: unknown }).id : v)
const isRelId = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 2147483647

/**
 * Shape check of one `audioVideo` block (structure only; that the media exists and has an allowed type is checked
 * against the database by the Articles validator). A leaf: no children, no URL members outside `fields`.
 */
function avBlockProblem(rec: Record<string, unknown>, fields: Record<string, unknown>): string | null {
  if (
    (Array.isArray(rec.children) && rec.children.length > 0) ||
    (rec.children !== undefined && !Array.isArray(rec.children)) ||
    Object.keys(rec).some((k) => URL_LIKE_KEY_RE.test(k))
  ) {
    return 'An audio/video block must not carry children or URL fields.'
  }
  const extra = Object.keys(fields).filter((k) => !AV_FIELD_KEYS.has(k))
  if (extra.length > 0) return `An audio/video block has unexpected fields (${extra.slice(0, 3).join(', ')}).`
  if (!(AV_KINDS as readonly unknown[]).includes(fields.kind)) return 'An audio/video block needs a kind of "video" or "audio".'
  const hasMedia = fields.media !== undefined && fields.media !== null
  const hasSource = fields.sourceUrl !== undefined && fields.sourceUrl !== null && fields.sourceUrl !== ''
  if (!hasMedia && !hasSource) return 'An audio/video block needs a media file or a source address.'
  if (hasMedia && !isRelId(relId(fields.media))) return 'An audio/video block has an invalid media id (expected an integer from 1 to 2147483647).'
  if (fields.poster !== undefined && fields.poster !== null && !isRelId(relId(fields.poster))) {
    return 'An audio/video block has an invalid poster id (expected an integer from 1 to 2147483647).'
  }
  if (hasSource && !isSafeAvUrl(fields.sourceUrl)) return 'An audio/video block source must be an http(s) address or a root-relative path.'
  if (fields.transcriptUrl !== undefined && fields.transcriptUrl !== null && fields.transcriptUrl !== '' && !isSafeAvUrl(fields.transcriptUrl)) {
    return 'An audio/video block transcript link must be an http(s) address or a root-relative path.'
  }
  if (typeof fields.title !== 'string' || fields.title.trim() === '') return 'An audio/video block needs a title (its accessible name).'
  if (
    fields.duration !== undefined &&
    fields.duration !== null &&
    !(typeof fields.duration === 'number' && Number.isFinite(fields.duration) && fields.duration >= 0 && fields.duration <= 86_400)
  ) {
    return 'An audio/video block duration must be a number of seconds from 0 to 86400.'
  }
  return avTextProblem(fields.title, 'title', AV_TITLE_MAX) ?? avTextProblem(fields.caption, 'caption', AV_CAPTION_MAX)
}

export type AvBlockRef = { kind: unknown; media?: number; poster?: number }

/** One entry per `audioVideo` block in the body (document order): its kind and the media ids it names, when valid ids. */
export function collectAvBlocks(content: unknown): AvBlockRef[] {
  const out: AvBlockRef[] = []
  const walk = (node: unknown, depth: number) => {
    if (depth > BODY_MAX_DEPTH || node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth + 1)
      return
    }
    const rec = node as Record<string, unknown>
    if (rec.type === 'block' && rec.fields !== null && typeof rec.fields === 'object') {
      const f = rec.fields as Record<string, unknown>
      if (f.blockType === AV_BLOCK_SLUG) {
        const m = relId(f.media)
        const p = relId(f.poster)
        out.push({ kind: f.kind, ...(isRelId(m) ? { media: m as number } : {}), ...(isRelId(p) ? { poster: p as number } : {}) })
        return
      }
    }
    for (const key of Object.keys(rec)) {
      const child = rec[key]
      if (child !== null && typeof child === 'object') walk(child, depth + 1)
    }
  }
  walk(content, 0)
  return out
}

/** The distinct media ids (files and posters) of the `audioVideo` blocks in the body, in document order. */
export function collectAvMedia(content: unknown): { media: number[]; poster: number[] } {
  const out = { media: [] as number[], poster: [] as number[] }
  for (const b of collectAvBlocks(content)) {
    if (b.media !== undefined && !out.media.includes(b.media)) out.media.push(b.media)
    if (b.poster !== undefined && !out.poster.includes(b.poster)) out.poster.push(b.poster)
  }
  return out
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
        if (type === 'block' && fields.blockType === AV_BLOCK_SLUG) {
          problem = avBlockProblem(rec, fields)
          return
        }
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
