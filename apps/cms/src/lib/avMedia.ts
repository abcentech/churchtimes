/**
 * Self-hosted audio and video (the `audioVideo` article block, API contract v1.19).
 *
 * Pure helpers shared by the Media collection (upload checks), the article validators and the importer. Only these
 * types are ever accepted: video/mp4, video/webm, audio/mpeg, audio/mp4, audio/ogg. SVG, HTML and every other type
 * stay refused. Content is verified against the file's magic bytes, never only against the declared type.
 */

export const AV_BLOCK_SLUG = 'audioVideo'

export const AV_VIDEO_MIME = ['video/mp4', 'video/webm'] as const
export const AV_AUDIO_MIME = ['audio/mpeg', 'audio/mp4', 'audio/ogg'] as const
export const AV_MIME: readonly string[] = [...AV_VIDEO_MIME, ...AV_AUDIO_MIME]

export type AvKind = 'video' | 'audio'
export const AV_KINDS: readonly AvKind[] = ['video', 'audio']

/** Other names for the same types (what Payload's sniffer or a browser may report), mapped to the canonical type. */
const AV_MIME_ALIASES: Record<string, string> = {
  'audio/x-m4a': 'audio/mp4',
  'video/x-m4v': 'video/mp4',
  'audio/mp3': 'audio/mpeg',
  'audio/x-mpeg': 'audio/mpeg',
  'application/ogg': 'audio/ogg',
}
export const AV_PAYLOAD_MIME_ALIASES: readonly string[] = ['audio/x-m4a', 'video/x-m4v']

/** The canonical audio/video type for a declared one (lower case, parameters such as `; codecs=opus` dropped), else null. */
export function normaliseAvMime(declared: unknown): string | null {
  if (typeof declared !== 'string') return null
  const base = declared.split(';')[0].trim().toLowerCase()
  const canonical = AV_MIME_ALIASES[base] ?? base
  return AV_MIME.includes(canonical) ? canonical : null
}

export const mimeAllowedForKind = (kind: unknown, mime: unknown): boolean =>
  typeof mime === 'string' &&
  (kind === 'video' ? (AV_VIDEO_MIME as readonly string[]).includes(mime) : kind === 'audio' && (AV_AUDIO_MIME as readonly string[]).includes(mime))

/** File extension (lower case, no dot) -> the kind the importer gives it. Only the supported containers. */
const EXT_KIND: Record<string, AvKind> = { mp4: 'video', m4v: 'video', webm: 'video', mp3: 'audio', m4a: 'audio', ogg: 'audio', oga: 'audio' }

/** The kind implied by a file name or address (query and fragment ignored), or null when it is not a supported type. */
export function avKindFromPath(path: unknown): AvKind | null {
  if (typeof path !== 'string') return null
  const clean = path.split('#')[0].split('?')[0]
  const dot = clean.lastIndexOf('.')
  if (dot < 0 || clean.lastIndexOf('/') > dot) return null
  return EXT_KIND[clean.slice(dot + 1).toLowerCase()] ?? null
}

export const AV_EXTENSIONS: readonly string[] = Object.keys(EXT_KIND)

export const AV_DEFAULT_MAX_MB = 100
export const AV_MAX_MB_LIMIT = 500

/** Size cap for one audio/video upload in bytes: `MEDIA_AV_MAX_MB` (default 100, at most 500). */
export function avMaxBytes(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.MEDIA_AV_MAX_MB)
  const mb = Number.isFinite(raw) && raw >= 1 ? Math.min(Math.floor(raw), AV_MAX_MB_LIMIT) : AV_DEFAULT_MAX_MB
  return mb * 1024 * 1024
}

const ascii = (buf: Uint8Array, from: number, to: number): string => String.fromCharCode(...buf.subarray(from, to))

/**
 * The audio/video types the first bytes of a file allow, in preference order; an empty list when it is none of them.
 * MP4 family: `ftyp` box (an M4A/M4B brand is audio only, anything else may be video or audio). WebM: EBML header
 * with the `webm` doctype. MP3: ID3 tag or an MPEG frame sync. Ogg: `OggS`.
 */
export function sniffAvMimes(buf: Uint8Array): string[] {
  if (buf.length >= 12 && ascii(buf, 4, 8) === 'ftyp') {
    const brand = ascii(buf, 8, 12)
    return brand === 'M4A ' || brand === 'M4B ' || brand === 'M4P ' ? ['audio/mp4'] : ['video/mp4', 'audio/mp4']
  }
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    return ascii(buf, 0, Math.min(buf.length, 64)).includes('webm') ? ['video/webm'] : []
  }
  if (buf.length >= 3 && ascii(buf, 0, 3) === 'ID3') return ['audio/mpeg']
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return ['audio/mpeg']
  if (buf.length >= 4 && ascii(buf, 0, 4) === 'OggS') return ['audio/ogg']
  return []
}

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/

export const AV_TITLE_MAX = 120
export const AV_CAPTION_MAX = 500
export const AV_URL_MAX = 2000

/** A message when a plain-text field (title, caption) is unacceptable, else null. Empty and absent are fine. */
export function avTextProblem(value: unknown, label: string, max: number): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') return `The audio/video ${label} must be plain text.`
  if (value.length > max) return `The audio/video ${label} must be at most ${max} characters.`
  if (/[<>]/.test(value) || CONTROL_RE.test(value)) return `The audio/video ${label} must be plain text (no markup or control characters).`
  return null
}

/**
 * True for an address a legacy source or transcript link may hold: absolute http(s) without credentials, or a root-relative
 * path. Never javascript:, data:, file:, blob: and so on, and no whitespace or control characters.
 */
export function isSafeAvUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value === '' || value.length > AV_URL_MAX) return false
  if (/[\s\u0000-\u001F\u007F-\u009F<>"'\\]/.test(value)) return false
  if (value.startsWith('//')) return false
  if (value.startsWith('/')) return true
  try {
    const u = new URL(value)
    return (u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password
  } catch {
    return false
  }
}
