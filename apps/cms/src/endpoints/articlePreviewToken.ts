import type { Endpoint } from 'payload'

import { writeAuditLog } from '../lib/audit'
import { createPreviewToken } from '../lib/previewToken'

const fail = (status: number, message: string) =>
  Response.json({ ok: false, errors: [{ message }] }, { status, headers: { 'Cache-Control': 'no-store' } })

/** POST /api/articles/:id/preview-token — issue a short-lived preview token for a readable article. */
export const articlePreviewTokenEndpoint: Endpoint = {
  path: '/:id/preview-token',
  method: 'post',
  handler: async (req) => {
    if (!req.user) return fail(401, 'Authentication required.')

    const id = req.routeParams?.id as string | number | undefined
    if (id === undefined || id === '') return fail(404, 'Article not found.')

    let doc: unknown
    try {
      doc = await req.payload.findByID({
        collection: 'articles',
        id,
        depth: 0,
        user: req.user,
        overrideAccess: false,
        disableErrors: true,
      })
    } catch {
      doc = null
    }
    if (!doc) return fail(404, 'Article not found.')

    let ttlSeconds: number | undefined
    try {
      // Payload 3 endpoints receive a web Request; the body is read via req.json().
      const body = (await req.json?.()) as { ttlSeconds?: unknown } | undefined
      if (body && typeof body.ttlSeconds === 'number') ttlSeconds = body.ttlSeconds
    } catch {
      // empty or invalid body: use default TTL
    }

    let issued: { token: string; expiresAt: string }
    try {
      issued = createPreviewToken({ articleId: (doc as { id: number | string }).id, ttlSeconds })
    } catch (err) {
      req.payload.logger.error({ err }, 'preview token: PREVIEW_SECRET misconfigured')
      return fail(500, 'Preview is not configured.')
    }

    await writeAuditLog(req, {
      action: 'preview-token',
      collection: 'articles',
      docId: (doc as { id: number | string }).id,
      summary: `expires ${issued.expiresAt}`,
    })

    const base = (process.env.CMS_PUBLIC_URL || '').replace(/\/+$/, '')
    return Response.json(
      {
        token: issued.token,
        expiresAt: issued.expiresAt,
        url: `${base}/api/preview/articles?token=${encodeURIComponent(issued.token)}`,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  },
}
