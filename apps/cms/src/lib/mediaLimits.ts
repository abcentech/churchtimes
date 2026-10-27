import { AV_EXTENSIONS, avKindFromPath, avMaxBytes } from './avMedia'

/**
 * Limits and types shared by the Media collection (`collections/Media.ts`), the legacy loader (`import/media.ts`) and
 * the untrusted-uploads check (`import/uploadSafety.ts`), so a file the check calls importable is one the loader
 * and the collection accept.
 */

export const IMAGE_DEFAULT_MAX_MB = 25
export const IMAGE_MAX_MB_LIMIT = 50

/** Image size cap in bytes: `MEDIA_IMAGE_MAX_MB` (whole MB, default 25, 1 to 50; below 1 or unparsable gives the default, above 50 the bound). */
export function imageMaxBytes(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.MEDIA_IMAGE_MAX_MB)
  const mb = Number.isFinite(raw) && raw >= 1 ? Math.min(Math.floor(raw), IMAGE_MAX_MB_LIMIT) : IMAGE_DEFAULT_MAX_MB
  return mb * 1024 * 1024
}

/** Largest image file the Media collection accepts (read once at start-up: rebuild/restart after changing the env). The loader and the uploads check use the same number. */
export const MAX_IMAGE_BYTES = imageMaxBytes()
export const MEDIA_MAX_BYTES = MAX_IMAGE_BYTES

export const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const
export type AllowedMime = (typeof ALLOWED_MIME)[number]

/** File name extensions (lower case, no dot) of the importable images, and the type each stands for. */
export const MEDIA_EXTENSION_MIME: Readonly<Record<string, AllowedMime>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

/** Audio/video extensions the importer takes (`avMedia.ts`), and the types each may carry (first match with the file's bytes wins). */
export const AV_EXTENSION_MIMES: Readonly<Record<string, readonly string[]>> = {
  mp4: ['video/mp4', 'audio/mp4'],
  m4v: ['video/mp4'],
  webm: ['video/webm'],
  mp3: ['audio/mpeg'],
  m4a: ['audio/mp4'],
  ogg: ['audio/ogg'],
  oga: ['audio/ogg'],
}

/** True when `ext` (lower case, no dot) is an importable image or audio/video extension. */
export const isImportableExtension = (ext: string): boolean =>
  Object.prototype.hasOwnProperty.call(MEDIA_EXTENSION_MIME, ext) || AV_EXTENSIONS.includes(ext)

/** Size cap in bytes for a file by its path: audio/video use the AV cap (`MEDIA_AV_MAX_MB`), images the image cap. */
export const maxBytesForPath = (rel: string): number => (avKindFromPath(rel) !== null ? avMaxBytes() : MAX_IMAGE_BYTES)
