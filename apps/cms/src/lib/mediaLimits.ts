/**
 * Limits and types shared by the Media collection (`collections/Media.ts`), the legacy loader (`import/media.ts`) and
 * the untrusted-uploads check (`import/uploadSafety.ts`), so a file the check calls importable is one the loader
 * and the collection accept.
 */

/** Largest image file the loader reads (and the check accepts). */
export const MEDIA_MAX_BYTES = 25 * 1024 * 1024

// TODO(#95): audio/video files get their own, larger cap once the AV block is on this branch; until then only images
// are importable and every other type is `unsupported-type` in the uploads check.

export const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const
export type AllowedMime = (typeof ALLOWED_MIME)[number]

/** File name extensions (lower case, no dot) of the importable images, and the type each stands for. */
export const MEDIA_EXTENSION_MIME: Readonly<Record<string, AllowedMime>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}
