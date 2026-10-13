import type { Endpoint, PayloadRequest } from 'payload'

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const NON_NEG_INT = /^\d{1,15}$/

const err = (status: number, message: string, field?: string) =>
  Response.json({ ok: false, errors: [{ ...(field ? { field } : {}), message }] }, { status })

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
                { sequence: { greater_than: since } },
              ],
            },
            sort: 'sequence',
            limit,
            depth: 0,
            pagination: false,
            overrideAccess: true,
            select: { sequence: true, body: true, occurredAt: true, approvedAt: true },
          })

    const docs = (updates.docs as Array<Record<string, any>>).map((d) => ({
      id: d.id,
      sequence: d.sequence,
      body: d.body,
      occurredAt: d.occurredAt,
      approvedAt: d.approvedAt ?? null,
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
