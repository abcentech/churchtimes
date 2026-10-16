/**
 * Embedded media in article bodies (go-live contract C1.1).
 *
 * The only embed the CMS accepts is the registered Lexical block `youtubeEmbed` (`videoId`, optional `title`).
 * The player URL is rebuilt by the public renderer from the id; a URL is never stored. Everything else that
 * looks like an embed (a raw `embed` node as emitted by the archive importer, an `iframe`-like node, an unknown
 * block or inline block) is refused, so arbitrary third-party URLs cannot enter the body and the admin editor
 * never meets a node it cannot load.
 *
 * Pure and defensive: never throws on malformed input and bounds the walk depth.
 */

export const YOUTUBE_BLOCK_SLUG = 'youtubeEmbed'
export const YOUTUBE_TITLE_MAX = 120

/** Exactly 11 characters from [A-Za-z0-9_-]. */
export const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/

export const EMBED_REFUSED_MESSAGE = 'Embeds other than YouTube are not accepted.'

const MAX_DEPTH = 64

// Node types that are embed-like. `block` / `inlineBlock` are judged by their `blockType` instead.
const EMBED_LIKE_TYPE_RE = /(iframe|embed|video|youtube|vimeo|oembed|frame|widget|script|object)/i

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

/**
 * Returns the first problem found in the body (a message suitable for a 400), or `null` when every embed-like
 * node is a well-formed `youtubeEmbed` block. Absent content returns `null` (nothing to check).
 */
export function findEmbedProblem(content: unknown): string | null {
  let problem: string | null = null

  const walk = (node: unknown, depth: number) => {
    if (problem !== null || depth > MAX_DEPTH || node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth + 1)
      return
    }
    const rec = node as Record<string, unknown>
    const type = rec.type
    if (typeof type === 'string') {
      if (type === 'block' || type === 'inlineBlock') {
        const fields =
          rec.fields !== null && typeof rec.fields === 'object' ? (rec.fields as Record<string, unknown>) : {}
        if (type === 'inlineBlock' || fields.blockType !== YOUTUBE_BLOCK_SLUG) {
          problem = EMBED_REFUSED_MESSAGE
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
    if (depth > MAX_DEPTH || node === null || typeof node !== 'object') return
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
