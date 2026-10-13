import type { Endpoint } from 'payload'

import { verifyPreviewToken } from '../lib/previewToken'

const headers = { 'Cache-Control': 'no-store' }

const fail = (status: number, message: string) =>
  Response.json({ ok: false, errors: [{ message }] }, { status, headers })

/** GET /api/preview/articles?token=... — single article in any status for a valid preview token. */
export const previewArticleEndpoint: Endpoint = {
  path: '/preview/articles',
  method: 'get',
  handler: async (req) => {
    const token = req.searchParams?.get('token') ?? new URL(req.url ?? 'http://x').searchParams.get('token')
    const verified = verifyPreviewToken(token)
    if (!verified) return fail(401, 'Invalid or expired preview token.')

    try {
      const doc = (await req.payload.findByID({
        collection: 'articles',
        id: verified.articleId,
        depth: 1,
        overrideAccess: true,
        disableErrors: true,
      })) as Record<string, unknown> | null
      if (!doc) return fail(404, 'Article not found.')

      const { reviewNotes: _reviewNotes, author: _author, scheduledFor: _scheduledFor, ...safe } = doc
      void _reviewNotes
      void _author
      void _scheduledFor
      return Response.json({ doc: safe }, { headers })
    } catch {
      return fail(404, 'Article not found.')
    }
  },
}
