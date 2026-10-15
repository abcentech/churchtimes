import { APIError, type PayloadRequest } from 'payload'

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
