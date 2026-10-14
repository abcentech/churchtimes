import path from 'node:path'

/**
 * Where uploaded media is stored. Default 'media' (relative to the working directory, unchanged). CMS_MEDIA_DIR must be an
 * ABSOLUTE path when set: the on-demand staging on the owner's PC points it at its private state folder so uploads never land
 * in the repository checkout.
 */
export function mediaStaticDir(env: Record<string, string | undefined> = process.env): string {
  const raw = env.CMS_MEDIA_DIR?.trim()
  if (!raw) return 'media'
  if (!path.isAbsolute(raw)) throw new Error('CMS_MEDIA_DIR must be an absolute path (or unset for the default "media").')
  return raw
}
