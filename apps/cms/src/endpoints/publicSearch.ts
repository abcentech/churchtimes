import type { Endpoint, PayloadRequest } from 'payload'

import { parseSearchParams, SEARCH_MAX_PAGE, searchArticles } from '../lib/articleSearch'
import { positiveInt } from '../lib/publicEndpoint'
import { createRateLimiter, getClientIp } from '../lib/rateLimit'
import { safeErrorFields } from '../lib/safeLog'
import { isOriginAllowed } from './publicSubmissions'

/**
 * `GET /api/public/search?q=&page=&limit=&category=&year=` (go-live contract C8). Anonymous, read-only, published
 * articles only (the `article_search` projection holds nothing else). See docs/api-contracts.md "Go-live C8".
 * Origin allowlist (403), per-IP rate limit (429 + Retry-After), `Cache-Control: public, max-age=60` when exactly one public origin is configured (every response then carries the same ACAO), else `private, max-age=60`. The raw `q` is never
 * logged; it reaches PostgreSQL only as a bound parameter of `websearch_to_tsquery`.
 */

/**
 * Shared-cache safety. Cloudflare's default cache ignores `Vary: Origin`, so a response that depends on the request's
 * Origin must never be stored publicly (one origin's grant would be replayed to another, or a request without CORS headers
 * would be served to a browser that needs them, which an attacker could use to warm the cache and break search).
 * - Exactly one public-site origin configured (PUBLIC_SUBMISSION_ORIGINS): EVERY 200 carries the same
 *   `Access-Control-Allow-Origin` (that origin), whatever Origin the request sent, so all responses for a URL are identical and
 *   `public, max-age=60` is safe. Other origins are refused with 403 `no-store` before anything is cached.
 * - Zero or several configured origins: the grant is echoed per request, so the response is `private, max-age=60`.
 */
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
  const fixed = singleOrigin()
  const cors = corsHeaders(fixed ?? origin)

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
  // Capped count: the real number of pages is unknown, so totalPages is null (never a misleading lower bound).
  const totalPages = result.totalCapped ? null : Math.max(1, Math.ceil(result.totalDocs / limit))
  const more = result.totalCapped ? result.docs.length === limit && page < SEARCH_MAX_PAGE : page < (totalPages ?? 1)
  const body = {
    docs: result.docs,
    totalDocs: result.totalDocs,
    totalCapped: result.totalCapped,
    limit,
    page,
    totalPages,
    hasNextPage: more,
    hasPrevPage: page > 1,
    nextPage: more ? page + 1 : null,
    prevPage: page > 1 ? page - 1 : null,
  }
  return new Response(withBody ? JSON.stringify(body) : null, {
    status: 200,
    headers: {
      ...cors,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': fixed ? 'public, max-age=60' : 'private, max-age=60',
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
