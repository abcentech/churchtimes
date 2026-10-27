import { APIError, type PayloadRequest } from 'payload'

import { mimeAllowedForKind } from './avMedia'

export const ALLOWED_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp']

/** Postgres `integer` primary keys: anything outside this range is not a media id (and would 500 on populate). */
export const isMediaId = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 2147483647

/**
 * The media must exist, be readable by the caller (`overrideAccess: false` with the request user), be a
 * JPEG/PNG/WebP image and carry non-empty alt text. Used for live-update photos and for upload nodes
 * inside article bodies. `what` names the place in error messages.
 */
export async function assertAttachableImage(
  req: PayloadRequest,
  imageId: number | string,
  what = 'The attached image',
): Promise<void> {
  const media = (await req.payload
    .findByID({ collection: 'media', id: imageId, depth: 0, overrideAccess: !req.user, user: req.user, req })
    .catch(() => null)) as { mimeType?: string | null; alt?: string | null } | null
  if (!media) throw new APIError(`${what} does not exist or is not available to you.`, 400)
  if (!media.mimeType || !ALLOWED_IMAGE_MIME.includes(media.mimeType)) {
    throw new APIError(`${what} must be a JPEG, PNG or WebP image.`, 400)
  }
  if (typeof media.alt !== 'string' || media.alt.trim() === '') {
    throw new APIError(`${what} needs alt text. Add a description to the image first.`, 400)
  }
}

/**
 * The media must exist, be readable by the caller, carry a type allowed for the block kind (video: mp4/webm, audio:
 * mp3/m4a/ogg) and non-empty alt text (the accessible description). Used for `audioVideo` blocks of article bodies.
 */
export async function assertAttachableAv(
  req: PayloadRequest,
  mediaId: number | string,
  kind: unknown,
  what = 'The attached audio or video',
): Promise<void> {
  const media = (await req.payload
    .findByID({ collection: 'media', id: mediaId, depth: 0, overrideAccess: !req.user, user: req.user, req })
    .catch(() => null)) as { mimeType?: string | null; alt?: string | null } | null
  if (!media) throw new APIError(`${what} does not exist or is not available to you.`, 400)
  if (!mimeAllowedForKind(kind, media.mimeType)) {
    throw new APIError(
      kind === 'audio'
        ? `${what} must be an MP3, M4A or OGG audio file.`
        : `${what} must be an MP4 or WebM video file.`,
      400,
    )
  }
  if (typeof media.alt !== 'string' || media.alt.trim() === '') {
    throw new APIError(`${what} needs a description (alt text). Add one to the file first.`, 400)
  }
}
