import { sql } from '@payloadcms/db-postgres'
import type { Endpoint, Payload, PayloadRequest, Where } from 'payload'

import { positiveInt } from '../lib/publicEndpoint'
import { createRateLimiter, getClientIp } from '../lib/rateLimit'
import { safeErrorFields } from '../lib/safeLog'
import { SLUG_MAX, SLUG_RE } from '../lib/newsroomFields'
import { isOriginAllowed } from './publicSubmissions'

/**
 * Waves 1-2 public reads (docs/w12/schema-contract.md):
 *
 *   GET /api/public/authors                 public author profiles (A-Z)
 *   GET /api/public/authors/:slug?page=     one public profile + its latest published articles (20 per page)
 *   GET /api/public/topics?kind=            public topics (A-Z)
 *   GET /api/public/topics/:slug?page=      one public topic + its latest published articles (20 per page)
 *   GET /api/public/site-trust              the trust pages text, once `published` is ticked (else 404)
 *   GET /api/public/corrections?page=       published articles with corrections, latest correction first (20 per page)
 *
 * Anonymous and read-only. Every read runs through the Local API as an ANONYMOUS caller (`overrideAccess: false`, no user),
 * so collection and field access decide what is visible exactly as for `GET /api/articles`: a logged-in staff cookie never
 * widens the result (drafts, non-public profiles and staff-only fields never appear). Same origin allowlist, CORS and cache
 * rules as `GET /api/public/search`; one per-IP rate limit shared by these routes (`PUBLIC_READ_RATE_LIMIT` per
 * `PUBLIC_READ_RATE_WINDOW_SECONDS`, default 120 per 60 s).
 */

export const PUBLIC_PAGE_SIZE = 20
export const PUBLIC_MAX_PAGE = 50
export const PUBLIC_LIST_MAX = 200

/** The article fields of a card (the same keys and shapes as a `GET /api/articles?depth=1` doc, without the body). */
export const ARTICLE_CARD_SELECT = {
  title: true,
  slug: true,
  excerpt: true,
  status: true,
  publishedAt: true,
  updatedAt: true,
  category: true,
  categories: true,
  featuredImage: true,
  bylineName: true,
  bylineAuthor: true,
  kicker: true,
  contentType: true,
  topics: true,
  lastSubstantiveUpdate: true,
  legacyUrl: true,
} as const

function singleOrigin(): string | null {
  const list = (process.env.PUBLIC_SUBMISSION_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean)
  return list.length === 1 ? list[0]! : null
}

let limiter: ReturnType<typeof createRateLimiter> | undefined
const getLimiter = () =>
  (limiter ??= createRateLimiter({
    limit: positiveInt(process.env.PUBLIC_READ_RATE_LIMIT, 120),
    windowMs: positiveInt(process.env.PUBLIC_READ_RATE_WINDOW_SECONDS, 60) * 1000,
  }))

/** Test helper: drop all counters and re-read limits from the environment. */
export function resetPublicReadLimiter(): void {
  limiter = undefined
}

const corsHeaders = (origin: string | null): Record<string, string> =>
  origin
    ? {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Expose-Headers': 'Retry-After',
        'Access-Control-Max-Age': '600',
      }
    : {}

const fail = (status: number, message: string, extra: Record<string, string> = {}) =>
  Response.json({ ok: false, errors: [{ message }] }, { status, headers: { 'Cache-Control': 'no-store', Vary: 'Origin', ...extra } })

type Ctx = { payload: Payload; params: URLSearchParams; routeParams: Record<string, unknown> }
class NotFound extends Error {}
class BadRequest extends Error {}

/** Wraps a read: origin check, rate limit, errors (never leaking internals), cache headers, HEAD. */
function publicRead(path: string, maxAge: number, read: (ctx: Ctx) => Promise<unknown>): Endpoint[] {
  const respond = async (req: PayloadRequest, withBody: boolean): Promise<Response> => {
    const origin = req.headers.get('origin')
    if (!isOriginAllowed(origin)) return fail(403, 'Origin not allowed.')
    const fixed = singleOrigin()
    const cors = corsHeaders(fixed ?? origin)
    const rl = getLimiter().check(getClientIp(req))
    if (!rl.allowed) return fail(429, 'Too many requests. Try again shortly.', { ...cors, 'Retry-After': String(rl.retryAfterSeconds) })
    let body: unknown
    try {
      body = await read({
        payload: req.payload,
        params: req.searchParams ?? new URL(req.url ?? 'http://localhost/').searchParams,
        routeParams: (req.routeParams ?? {}) as Record<string, unknown>,
      })
    } catch (err) {
      if (err instanceof NotFound) return fail(404, err.message || 'Not found.', cors)
      if (err instanceof BadRequest) return fail(400, err.message, cors)
      req.payload.logger.error(safeErrorFields(err), `[public] ${path} failed`)
      return fail(500, 'Temporarily unavailable.', cors)
    }
    return new Response(withBody ? JSON.stringify(body) : null, {
      status: 200,
      headers: {
        ...cors,
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': fixed ? `public, max-age=${maxAge}` : `private, max-age=${maxAge}`,
        Vary: 'Origin',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  }
  return [
    { path, method: 'get', handler: (req: PayloadRequest) => respond(req, true) },
    { path, method: 'head', handler: (req: PayloadRequest) => respond(req, false) },
    {
      path,
      method: 'options',
      handler: async (req: PayloadRequest) => {
        const origin = req.headers.get('origin')
        if (origin && !isOriginAllowed(origin)) return new Response(null, { status: 403 })
        return new Response(null, { status: 204, headers: { ...corsHeaders(origin), Vary: 'Origin' } })
      },
    },
  ]
}

const slugParam = (ctx: Ctx): string => {
  const slug = String(ctx.routeParams.slug ?? '')
  if (slug.length > SLUG_MAX || !SLUG_RE.test(slug)) throw new NotFound('Not found.')
  return slug
}

const pageParam = (ctx: Ctx): number => {
  const raw = ctx.params.get('page')
  if (raw === null || raw === '') return 1
  if (!/^[1-9]\d{0,2}$/.test(raw) || Number(raw) > PUBLIC_MAX_PAGE) throw new BadRequest(`Query parameter "page" must be from 1 to ${PUBLIC_MAX_PAGE}.`)
  return Number(raw)
}

/** Anonymous Local API read: access rules of a reader, never of whoever sent the request. */
const anon = { overrideAccess: false, user: null } as const

/**
 * Card list of published articles matching `where`, newest first. Relationship entries the reader may not see (non-public
 * topics, a non-public byline profile) come back from Payload as bare ids: they are removed here, so a card carries only
 * populated public objects (`topics: [{...}]`, `bylineAuthor: {...} | null`).
 */
export async function articleCards(payload: Payload, where: Where, page: number, limit = PUBLIC_PAGE_SIZE) {
  const res = await payload.find({
    collection: 'articles',
    where: { and: [{ status: { equals: 'published' } }, where] },
    sort: '-publishedAt',
    depth: 1,
    limit,
    page,
    select: ARTICLE_CARD_SELECT,
    ...anon,
  })
  return {
    docs: res.docs.map((d) => cleanCard(d as unknown as Record<string, unknown>)),
    page: res.page ?? page,
    totalDocs: res.totalDocs,
    hasNextPage: res.hasNextPage && page < PUBLIC_MAX_PAGE,
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

export function cleanCard(doc: Record<string, unknown>): Record<string, unknown> {
  const out = { ...doc }
  out.topics = Array.isArray(doc.topics) ? doc.topics.filter((t) => isObj(t) && t.isPublic === true) : []
  out.bylineAuthor = isObj(doc.bylineAuthor) && doc.bylineAuthor.isPublic === true ? doc.bylineAuthor : null
  out.contentType = typeof doc.contentType === 'string' ? doc.contentType : 'news'
  return out
}

const AUTHOR_PUBLIC_SELECT = { name: true, slug: true, role: true, bio: true, photo: true, avatar: true, socials: true, isPublic: true } as const
const TOPIC_PUBLIC_SELECT = { name: true, slug: true, kind: true, description: true, isPublic: true } as const

const stripRowIds = (rows: unknown): Array<Record<string, unknown>> =>
  Array.isArray(rows) ? rows.filter(isObj).map(({ id: _id, ...rest }) => rest) : []

async function findPublicBySlug(payload: Payload, collection: 'authors' | 'topics', slug: string, depth: number) {
  const res = await payload.find({
    collection,
    where: { and: [{ slug: { equals: slug } }, { isPublic: { equals: true } }] },
    limit: 1,
    depth,
    select: collection === 'authors' ? AUTHOR_PUBLIC_SELECT : TOPIC_PUBLIC_SELECT,
    ...anon,
  })
  const doc = res.docs[0] as Record<string, unknown> | undefined
  if (!doc) throw new NotFound(collection === 'authors' ? 'Author not found.' : 'Topic not found.')
  return doc
}

/** Full public photo object of a profile (populated media) or null when absent or not readable. */
const publicPhoto = (photo: unknown) => (isObj(photo) ? photo : null)

export const publicNewsroomEndpoints: Endpoint[] = [
  ...publicRead('/public/authors', 300, async ({ payload }) => {
    const res = await payload.find({
      collection: 'authors',
      where: { isPublic: { equals: true } },
      sort: 'name',
      limit: PUBLIC_LIST_MAX,
      depth: 0,
      select: { name: true, slug: true, role: true, avatar: true, photo: true },
      ...anon,
    })
    return { docs: res.docs.map((d) => { const { photo: _p, ...rest } = d as unknown as Record<string, unknown>; return rest }) }
  }),
  ...publicRead('/public/authors/:slug', 60, async (ctx) => {
    const slug = slugParam(ctx)
    const page = pageParam(ctx)
    const author = await findPublicBySlug(ctx.payload, 'authors', slug, 1)
    const articles = await articleCards(ctx.payload, { bylineAuthor: { equals: author.id as number } }, page)
    return {
      author: { ...author, photo: publicPhoto(author.photo), socials: stripRowIds(author.socials) },
      articles: articles.docs,
      page: articles.page,
      totalDocs: articles.totalDocs,
      hasNextPage: articles.hasNextPage,
    }
  }),
  ...publicRead('/public/topics', 300, async ({ payload, params }) => {
    const kind = params.get('kind')
    if (kind !== null && !['topic', 'denomination', 'series', 'ministry'].includes(kind)) {
      throw new BadRequest('Query parameter "kind" must be topic, denomination, series or ministry.')
    }
    const res = await payload.find({
      collection: 'topics',
      where: { and: [{ isPublic: { equals: true } }, ...(kind ? [{ kind: { equals: kind } }] : [])] },
      sort: 'name',
      limit: PUBLIC_LIST_MAX,
      depth: 0,
      select: { name: true, slug: true, kind: true, description: true },
      ...anon,
    })
    return { docs: res.docs }
  }),
  ...publicRead('/public/topics/:slug', 60, async (ctx) => {
    const slug = slugParam(ctx)
    const page = pageParam(ctx)
    const topic = await findPublicBySlug(ctx.payload, 'topics', slug, 0)
    const articles = await articleCards(ctx.payload, { topics: { equals: topic.id as number } }, page)
    return { topic, articles: articles.docs, page: articles.page, totalDocs: articles.totalDocs, hasNextPage: articles.hasNextPage }
  }),
  ...publicRead('/public/site-trust', 300, async ({ payload }) => {
    // Trusted read of the global, then only the public fields, and only once published.
    const g = (await payload.findGlobal({ slug: 'site-trust', depth: 0, overrideAccess: true })) as unknown as Record<string, unknown>
    if (g.published !== true) throw new NotFound('Not published.')
    return {
      editorialStandards: g.editorialStandards ?? null,
      ownershipFunding: g.ownershipFunding ?? null,
      ethicsCorrectionsPolicy: g.ethicsCorrectionsPolicy ?? null,
      contactEditors: typeof g.contactEditors === 'string' ? g.contactEditors : '',
      updatedAt: g.updatedAt ?? null,
    }
  }),
  ...publicRead('/public/corrections', 60, async (ctx) => {
    const page = pageParam(ctx)
    const offset = (page - 1) * PUBLIC_PAGE_SIZE
    // Published articles ordered by their latest correction (one indexed aggregate; the cards come from the Local API).
    const result = (await (ctx.payload.db as unknown as { drizzle: { execute: (q: unknown) => Promise<unknown> } }).drizzle.execute(sql`
      select c."_parent_id" as id, max(c."corrected_at") as latest
      from "articles_corrections" c
      join "articles" a on a."id" = c."_parent_id"
      where a."status" = 'published'
      group by c."_parent_id"
      order by latest desc, c."_parent_id" desc
      limit ${PUBLIC_PAGE_SIZE + 1} offset ${offset}`)) as { rows: Array<{ id: number }> }
    const ids = result.rows.slice(0, PUBLIC_PAGE_SIZE).map((r) => Number(r.id))
    if (ids.length === 0) return { docs: [], page, hasNextPage: false }
    const res = await ctx.payload.find({
      collection: 'articles',
      where: { and: [{ status: { equals: 'published' } }, { id: { in: ids } }] },
      depth: 1,
      limit: ids.length,
      pagination: false,
      select: { ...ARTICLE_CARD_SELECT, corrections: true },
      ...anon,
    })
    const byId = new Map(res.docs.map((d) => [Number((d as { id: unknown }).id), d as unknown as Record<string, unknown>]))
    const docs = ids
      .map((id) => byId.get(id))
      .filter((d): d is Record<string, unknown> => Boolean(d))
      .map((d) => {
        const { corrections, ...card } = d
        const rows = stripRowIds(corrections)
          .map((r) => ({ note: String(r.note ?? ''), correctedAt: r.correctedAt ?? null }))
          .sort((a, b) => String(b.correctedAt).localeCompare(String(a.correctedAt)))
        return { article: cleanCard(card), corrections: rows }
      })
    return { docs, page, hasNextPage: result.rows.length > PUBLIC_PAGE_SIZE && page < PUBLIC_MAX_PAGE }
  }),
]
