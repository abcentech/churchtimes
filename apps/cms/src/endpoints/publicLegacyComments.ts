import type { Endpoint, PayloadRequest, Where } from 'payload'

import { toPublicComment } from '../lib/legacyComments'
import { isOriginAllowed } from './publicSubmissions'

/**
 * `GET /api/legacy-comments?article=<id|slug>` (go-live contract C6). Anonymous and credential-free. Registered as a
 * collection endpoint on `legacy-comments`, so it replaces Payload's generic list route on this path: the generic route
 * would let a caller pick fields, filters and sorts. Staff use the admin UI and `GET /api/legacy-comments/:id`.
 *
 * - Only `approved` comments of a PUBLISHED article are returned, whatever the query says. An unknown article and an
 *   unpublished one look the same (200, empty), so the endpoint does not reveal that an unpublished slug exists.
 * - Each comment is `{ id, legacyId, parentLegacyId, authorName, commentedAt, content }`: plain text, built from an
 *   allowlist. No email, website or IP exists in the collection, and none can appear here.
 * - Query: `article` (numeric id, otherwise a slug), or `articleLegacyId` (the WordPress post id); `limit` (1..100,
 *   default 50; anything else falls back to the default and a larger value is clamped); `page` (>= 1).
 * - Oldest first. `Cache-Control: public, max-age=60` (short, so a comment hidden by staff leaves the cache quickly).
 */

export const COMMENTS_MAX_LIMIT = 100
export const COMMENTS_DEFAULT_LIMIT = 50
const MAX_PAGE = 10_000
const CACHE_CONTROL = 'public, max-age=60'

const corsHeaders = (origin: string | null): Record<string, string> =>
  origin
    ? {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '600',
      }
    : {}

const fail = (status: number, message: string, extra: Record<string, string> = {}) =>
  Response.json(
    { ok: false, errors: [{ message }] },
    { status, headers: { 'Cache-Control': 'no-store', Vary: 'Origin', ...extra } },
  )

/** Strict positive integer from a query value; anything else is `undefined`. */
const intParam = (raw: string | null): number | undefined => {
  if (raw === null || !/^\d{1,9}$/.test(raw.trim())) return undefined
  const n = Number(raw)
  return n >= 1 ? n : undefined
}

export function parseCommentPaging(params: URLSearchParams): { limit: number; page: number } {
  const limit = Math.min(intParam(params.get('limit')) ?? COMMENTS_DEFAULT_LIMIT, COMMENTS_MAX_LIMIT)
  const page = Math.min(intParam(params.get('page')) ?? 1, MAX_PAGE)
  return { limit, page }
}

async function respond(req: PayloadRequest, withBody: boolean): Promise<Response> {
  const origin = req.headers.get('origin')
  if (!isOriginAllowed(origin)) return fail(403, 'Origin not allowed.')
  const cors = corsHeaders(origin)

  const params = req.searchParams ?? new URL(req.url ?? 'http://localhost/').searchParams
  const article = params.get('article')?.trim() ?? ''
  const legacyRaw = params.get('articleLegacyId')
  if (article === '' && legacyRaw === null) return fail(400, 'Query parameter "article" is required.', cors)
  if (article.length > 300) return fail(400, 'Query parameter "article" is too long.', cors)
  const legacyId = legacyRaw === null ? undefined : intParam(legacyRaw)
  if (legacyRaw !== null && legacyId === undefined) return fail(400, 'Query parameter "articleLegacyId" must be a number.', cors)

  const { limit, page } = parseCommentPaging(params)

  const key: Where =
    legacyId !== undefined
      ? { legacyId: { equals: legacyId } }
      : /^\d{1,9}$/.test(article)
        ? { or: [{ id: { equals: Number(article) } }, { slug: { equals: article } }] }
        : { slug: { equals: article } }

  const found = await req.payload.find({
    collection: 'articles',
    where: { and: [{ status: { equals: 'published' } }, key] },
    limit: 1,
    depth: 0,
    overrideAccess: true,

  })
  const articleId = (found.docs[0] as { id?: number } | undefined)?.id

  const result = articleId
    ? await req.payload.find({
        collection: 'legacy-comments',
        where: { and: [{ article: { equals: articleId } }, { status: { equals: 'approved' } }] },
        sort: ['commentedAt', 'legacyId'],
        limit,
        page,
        depth: 0,
        overrideAccess: true,
        select: { authorName: true, content: true, commentedAt: true, legacyId: true, parentLegacyId: true },
      })
    : { docs: [], totalDocs: 0, totalPages: 1, page, hasNextPage: false, hasPrevPage: false }

  const body = {
    docs: result.docs.map((d) => toPublicComment(d as unknown as Record<string, unknown>)),
    totalDocs: result.totalDocs,
    limit,
    page: result.page ?? page,
    totalPages: result.totalPages,
    hasNextPage: result.hasNextPage,
    hasPrevPage: result.hasPrevPage,
  }
  return new Response(withBody ? JSON.stringify(body) : null, {
    status: 200,
    headers: {
      ...cors,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': CACHE_CONTROL,
      Vary: 'Origin',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

export const publicLegacyCommentsEndpoints: Endpoint[] = [
  { path: '/', method: 'get', handler: (req: PayloadRequest) => respond(req, true) },
  { path: '/', method: 'head', handler: (req: PayloadRequest) => respond(req, false) },
  {
    path: '/',
    method: 'options',
    handler: async (req: PayloadRequest) => {
      const origin = req.headers.get('origin')
      if (origin && !isOriginAllowed(origin)) return new Response(null, { status: 403 })
      return new Response(null, { status: 204, headers: { ...corsHeaders(origin), Vary: 'Origin' } })
    },
  },
]
