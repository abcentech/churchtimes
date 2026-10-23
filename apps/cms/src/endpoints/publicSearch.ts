import type { Endpoint, PayloadRequest } from 'payload'

import { parseSearchParams, SEARCH_MAX_PAGE, searchArticles } from '../lib/articleSearch'
import { positiveInt } from '../lib/publicEndpoint'
import { createRateLimiter, getClientIp } from '../lib/rateLimit'
import { safeErrorFields } from '../lib/safeLog'
import { isOriginAllowed } from './publicSubmissions'

/**
 * `GET /api/public/search?q=&page=&limit=&category=&year=` (go-live contract C8). Anonymous, read-only, published
 * articles only (the `article_search` projection holds nothing else). See docs/api-contracts.md "Go-live C8".
 * Origin allowlist (403), per-IP rate limit (429 + Retry-After), `Cache-Control: public, max-age=60` (`private, max-age=60` when the request has an Origin header). The raw `q` is never
 * logged; it reaches PostgreSQL only as a bound parameter of `websearch_to_tsquery`.
 */

/**
 * A request without an Origin header (a plain navigation or server-side fetch) may be cached by a shared cache. A request WITH
 * an Origin gets an origin-specific Access-Control-Allow-Origin echo, and Cloudflare's default cache ignores `Vary: Origin`, so
 * such a response is `private` (browser only) to keep one origin's CORS grant from being replayed to another.
 */
const cacheControl = (origin: string | null): string => (origin ? 'private, max-age=60' : 'public, max-age=60')

let limiter: ReturnType<typeof createRateLimiter> | undefined
const getLimiter = () =>
  (limiter ??= createRateLimiter({
    limit: positiveInt(process.env.SEARCH_RATE_LIMIT, 60),
    windowMs: positiveInt(process.env.SEARCH_RATE_WINDOW_SECONDS, 60) * 1000,
  }))

/** Test helper: drop all counters and re-read limits from the environment. */
export function resetSearchLimiter(): void {
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
  Response.json(
    { ok: false, errors: [{ message }] },
    { status, headers: { 'Cache-Control': 'no-store', Vary: 'Origin', ...extra } },
  )

async function respond(req: PayloadRequest, withBody: boolean): Promise<Response> {
  const origin = req.headers.get('origin')
  if (!isOriginAllowed(origin)) return fail(403, 'Origin not allowed.')
  const cors = corsHeaders(origin)

  const rl = getLimiter().check(getClientIp(req))
  if (!rl.allowed) return fail(429, 'Too many searches. Try again shortly.', { ...cors, 'Retry-After': String(rl.retryAfterSeconds) })

  const params = req.searchParams ?? new URL(req.url ?? 'http://localhost/').searchParams
  const parsed = parseSearchParams(params)
  if (!parsed.ok) return fail(400, parsed.message, cors)

  let result
  try {
    result = await searchArticles(req.payload, parsed.params)
  } catch (err) {
    req.payload.logger.error(safeErrorFields(err), '[search] query failed')
    return fail(500, 'Search is temporarily unavailable.', cors)
  }
  const { page, limit } = parsed.params
  const totalPages = Math.max(1, Math.ceil(result.totalDocs / limit))
  const body = {
    docs: result.docs,
    totalDocs: result.totalDocs,
    totalCapped: result.totalCapped,
    limit,
    page,
    totalPages,
    // Past the count cap the true number of pages is unknown: a full page means there may be more (up to the page limit).
    hasNextPage: page < totalPages || (result.totalCapped && result.docs.length === limit && page < SEARCH_MAX_PAGE),
    hasPrevPage: page > 1,
    nextPage: page < totalPages || (result.totalCapped && result.docs.length === limit && page < SEARCH_MAX_PAGE) ? page + 1 : null,
    prevPage: page > 1 ? page - 1 : null,
  }
  return new Response(withBody ? JSON.stringify(body) : null, {
    status: 200,
    headers: {
      ...cors,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': cacheControl(origin),
      Vary: 'Origin',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

export const publicSearchEndpoints: Endpoint[] = [
  { path: '/public/search', method: 'get', handler: (req: PayloadRequest) => respond(req, true) },
  { path: '/public/search', method: 'head', handler: (req: PayloadRequest) => respond(req, false) },
  {
    path: '/public/search',
    method: 'options',
    handler: async (req: PayloadRequest) => {
      const origin = req.headers.get('origin')
      if (origin && !isOriginAllowed(origin)) return new Response(null, { status: 403 })
      return new Response(null, { status: 204, headers: { ...corsHeaders(origin), Vary: 'Origin' } })
    },
  },
]
