import type { Endpoint } from 'payload'

import { verifyPreviewToken } from '../lib/previewToken'

const headers = { 'Cache-Control': 'no-store' }

const fail = (status: number, message: string) =>
  Response.json({ ok: false, errors: [{ message }] }, { status, headers })

const MEDIA_PATH = '/api/media/file/'
/** Fields that exist on a media document for staff / access decisions and must never reach a preview holder. */
const MEDIA_PRIVATE_KEYS = ['uploadedBy', 'publishedAsFeatured', 'publishedInBody', 'liveUpdateImages']

const isMediaUrl = (value: string): boolean => {
  try {
    return new URL(value, 'http://cms.invalid').pathname.startsWith(MEDIA_PATH)
  } catch {
    return false
  }
}

/**
 * Prepares the preview payload (in place) for a token holder without a staff session:
 * - every media URL (`url` and `sizes.*.url`, featured image and body upload nodes alike) gets `?preview=<token>`, which
 *   `Media.readAccess` accepts for the media of this article only (drafts' images are otherwise private);
 * - staff-only data is removed from populated media (`uploadedBy`, the access-only join fields).
 * The caller already removed the article's own staff-only fields.
 */
function preparePreview(node: unknown, token: string, depth = 0): void {
  if (depth > 64 || node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) preparePreview(child, token, depth + 1)
    return
  }
  const rec = node as Record<string, unknown>
  if (typeof rec.filename === 'string' && typeof rec.mimeType === 'string') {
    for (const key of MEDIA_PRIVATE_KEYS) delete rec[key]
  }
  for (const key of Object.keys(rec)) {
    const value = rec[key]
    if (key === 'url' && typeof value === 'string' && isMediaUrl(value)) {
      rec[key] = `${value}${value.includes('?') ? '&' : '?'}preview=${encodeURIComponent(token)}`
    } else if (value !== null && typeof value === 'object') {
      preparePreview(value, token, depth + 1)
    }
  }
}

/** GET /api/preview/articles?token=... — single article in any status for a valid preview token. */
export const previewArticleEndpoint: Endpoint = {
  path: '/preview/articles',
  method: 'get',
  handler: async (req) => {
    const token = req.searchParams?.get('token') ?? new URL(req.url ?? 'http://x').searchParams.get('token')
    const verified = verifyPreviewToken(token)
    if (!verified || !token) return fail(401, 'Invalid or expired preview token.')

    try {
      const doc = (await req.payload.findByID({
        collection: 'articles',
        id: verified.articleId,
        depth: 1,
        overrideAccess: true,
        disableErrors: true,
      })) as Record<string, unknown> | null
      if (!doc) return fail(404, 'Article not found.')

      const {
        reviewNotes: _reviewNotes,
        author: _author,
        scheduledFor: _scheduledFor,
        bodyMedia: _bodyMedia,
        ...safe
      } = doc
      void _reviewNotes
      void _author
      void _scheduledFor
      void _bodyMedia
      preparePreview(safe, token)
      return Response.json({ doc: safe }, { headers })
    } catch {
      return fail(404, 'Article not found.')
    }
  },
}
