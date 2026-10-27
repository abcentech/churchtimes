import type { Endpoint, PayloadRequest } from 'payload'

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const NON_NEG_INT = /^\d{1,15}$/

const err = (status: number, message: string, field?: string) =>
  Response.json({ ok: false, errors: [{ ...(field ? { field } : {}), message }] }, { status })

type PublicImage = { url: string; alt: string; width: number | null; height: number | null; mimeType: string }

const IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp']
const dimension = (v: unknown): number | null => (Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : null)

/** Payload's media URL: root-relative, or absolute when CMS_PUBLIC_URL is set. Always a /api/media/file/ path. */
function isMediaFileUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false
  try {
    const u = new URL(value, 'http://cms.invalid')
    return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password && u.pathname.startsWith('/api/media/file/')
  } catch {
    return false
  }
}

/** Name of the Media imageSizes entry (~800 px wide) served to readers instead of the original upload. */
export const FEED_IMAGE_SIZE = 'card'

/**
 * Whitelist projection of a populated media doc: exactly these five fields, nothing else (no filename,
 * uploader, sizes, caption or credit). Anything that is not a usable image with alt text becomes null.
 * `url` is Payload's own media URL (root-relative `/api/media/file/<name>`, or absolute when CMS_PUBLIC_URL is set).
 *
 * Readers get the ~800 px `card` variant (url, width, height and mimeType of that variant) so a phone does not
 * download an original of up to 25 MB. When the variant does not exist (Payload does not enlarge images that are
 * already smaller than the size, and rows that predate the size) or is not a usable media URL / image type, the
 * original upload is used. `alt` always comes from the media document itself.
 */
export function publicImage(media: unknown): PublicImage | null {
  if (!media || typeof media !== 'object') return null
  const m = media as Record<string, unknown>
  if (!isMediaFileUrl(m.url)) return null
  if (typeof m.mimeType !== 'string' || !IMAGE_MIME.includes(m.mimeType)) return null
  if (typeof m.alt !== 'string' || m.alt.trim() === '') return null
  const sizes = m.sizes && typeof m.sizes === 'object' ? (m.sizes as Record<string, unknown>) : null
  const variant = sizes?.[FEED_IMAGE_SIZE]
  const v = variant && typeof variant === 'object' ? (variant as Record<string, unknown>) : null
  if (v && isMediaFileUrl(v.url) && typeof v.mimeType === 'string' && IMAGE_MIME.includes(v.mimeType)) {
    return { url: v.url, alt: m.alt, width: dimension(v.width), height: dimension(v.height), mimeType: v.mimeType }
  }
  return { url: m.url, alt: m.alt, width: dimension(m.width), height: dimension(m.height), mimeType: m.mimeType }
}

/** Public polling endpoint: approved updates of a non-draft live event. */
export const liveEventUpdatesEndpoint: Endpoint = {
  path: '/:slug/updates',
  method: 'get',
  handler: async (req: PayloadRequest) => {
    const slug = String(req.routeParams?.slug ?? '')
    if (!slug || slug.length > 160 || !SLUG_RE.test(slug)) return err(400, 'Invalid event slug.', 'slug')

    const url = new URL(req.url ?? 'http://localhost')
    const sinceRaw = url.searchParams.get('since')
    const limitRaw = url.searchParams.get('limit')
    if (sinceRaw !== null && !NON_NEG_INT.test(sinceRaw)) {
      return err(400, 'since must be a non-negative integer.', 'since')
    }
    if (limitRaw !== null && !NON_NEG_INT.test(limitRaw)) {
      return err(400, 'limit must be a non-negative integer.', 'limit')
    }
    const since = sinceRaw === null ? 0 : Number(sinceRaw)
    const limit = Math.min(limitRaw === null ? 50 : Number(limitRaw), 100)

    const events = await req.payload.find({
      collection: 'live-events',
      where: { slug: { equals: slug } },
      limit: 1,
      depth: 0,
      pagination: false,
      overrideAccess: true,
      select: { title: true, slug: true, status: true },
    })
    const event = events.docs[0] as { id: number | string; title: string; slug: string; status: string } | undefined
    if (!event || event.status === 'draft') return err(404, 'Live event not found.')

    const updates =
      limit === 0
        ? { docs: [] as Array<Record<string, unknown>> }
        : await req.payload.find({
            collection: 'live-updates',
            where: {
              and: [
                { event: { equals: event.id } },
                { status: { equals: 'approved' } },
                // Publication order, not creation order: an update approved late must still reach
                // pollers whose cursor already passed its creation sequence.
                { publishSequence: { greater_than: since } },
              ],
            },
            sort: 'publishSequence',
            limit,
            // depth 1 populates `image`; `populate` limits the media fields read (`filename` is needed by Payload to
            // compute `url`; publicImage() never emits it).
            depth: 1,
            pagination: false,
            overrideAccess: true,
            select: { publishSequence: true, body: true, occurredAt: true, approvedAt: true, image: true },
            populate: {
              media: {
                url: true,
                filename: true,
                alt: true,
                width: true,
                height: true,
                mimeType: true,
                sizes: { [FEED_IMAGE_SIZE]: true },
              },
            },
          })

    // The wire field stays named `sequence` (contract stability); its value is the publication sequence.
    const docs = (updates.docs as Array<Record<string, any>>).map((d) => ({
      id: d.id,
      sequence: d.publishSequence,
      body: d.body,
      occurredAt: d.occurredAt,
      approvedAt: d.approvedAt ?? null,
      image: publicImage(d.image),
    }))
    const nextSince = docs.length ? docs[docs.length - 1].sequence : since

    return Response.json(
      {
        event: { id: event.id, slug: event.slug, title: event.title, status: event.status },
        docs,
        nextSince,
      },
      { status: 200, headers: { 'Cache-Control': 'public, max-age=10' } },
    )
  },
}
