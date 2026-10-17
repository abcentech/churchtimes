import type { Endpoint, Payload, PayloadRequest } from 'payload'

import { generateRedirectMap } from '../lib/redirectData'
import { type BuildResult, errorCode, hasDataWarnings } from '../lib/redirectMap'
import { isOriginAllowed } from './publicSubmissions'

/**
 * `GET /api/public/redirects` (go-live contract C7.3). Anonymous and credential-free: the body is the exact-match list
 * only (`from`, `to`, `status`, `source`), never staff data, and never anything derived from an unpublished article.
 *
 * Caching: the response carries `ETag` (the content `version`) and `Cache-Control: public, max-age=300`, and answers
 * `If-None-Match` with 304. The list is rebuilt from the database at most once per `CACHE_MS` per process (concurrent
 * requests share one build), so an anonymous caller cannot make the database scan the articles on every request.
 *
 * Data problems never make this endpoint fail: bad, looping or colliding rows are dropped and COUNTED in the log (counts
 * only, never addresses). It answers 500 only for a bad configuration or when a size cap (20,000 rules, 5 MB) is exceeded.
 * HEAD is registered explicitly (same headers, no body), because Next hands a HEAD request to the GET route handler.
 */

const CACHE_MS = 10_000
const CACHE_CONTROL = 'public, max-age=300'

type Outcome = { ok: true; result: BuildResult } | { ok: false; error: unknown }
let cache: { at: number; payload: Payload; outcome: Promise<Outcome> } | undefined

/** Test helper: forget the in-process memo. */
export function resetRedirectsCache(): void {
  cache = undefined
}

function build(payload: Payload): Promise<Outcome> {
  const now = Date.now()
  if (cache && cache.payload === payload && now - cache.at < CACHE_MS) return cache.outcome
  const outcome: Promise<Outcome> = generateRedirectMap(payload).then(
    (result): Outcome => ({ ok: true, result }),
    (error): Outcome => ({ ok: false, error }),
  )
  cache = { at: now, payload, outcome }
  return outcome
}

const corsHeaders = (origin: string | null): Record<string, string> =>
  origin
    ? {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'If-None-Match',
        'Access-Control-Expose-Headers': 'ETag',
        'Access-Control-Max-Age': '600',
      }
    : {}

const etagOf = (version: string): string => `"${version}"`

/** `If-None-Match` may list several tags and may use weak validators or `*`. */
const matches = (header: string | null, etag: string): boolean => {
  if (!header) return false
  if (header.trim() === '*') return true
  return header
    .split(',')
    .map((t) => t.trim().replace(/^W\//, ''))
    .includes(etag)
}

const errorResponse = (status: number, message: string, extra: Record<string, string> = {}) =>
  Response.json({ ok: false, errors: [{ message }] }, { status, headers: { 'Cache-Control': 'no-store', Vary: 'Origin', ...extra } })

async function respond(req: PayloadRequest, withBody: boolean): Promise<Response> {
  const origin = req.headers.get('origin')
  if (!isOriginAllowed(origin)) return errorResponse(403, 'Origin not allowed.')
  const cors = corsHeaders(origin)

  const outcome = await build(req.payload)
  if (!outcome.ok) {
    // A code only: a configuration problem or a size cap. Nothing from a request or from a rule.
    req.payload.logger.error(
      `redirect list refused (error=${errorCode(outcome.error)}): the public list is NOT served until this is fixed`,
    )
    return errorResponse(500, 'The redirect list is temporarily unavailable.', cors)
  }

  const { map, body, stats } = outcome.result
  if (hasDataWarnings(stats)) {
    req.payload.logger.warn(
      `redirect list served with data problems (counts only): overridden-derived=${stats.overriddenDerived} dropped=${JSON.stringify(stats.dropped)}`,
    )
  }
  const etag = etagOf(map.version)
  const headers = { ...cors, ETag: etag, 'Cache-Control': CACHE_CONTROL, Vary: 'Origin' }
  if (matches(req.headers.get('if-none-match'), etag)) return new Response(null, { status: 304, headers })
  return new Response(withBody ? body : null, {
    status: 200,
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
  })
}

export const publicRedirectsEndpoint: Endpoint = {
  path: '/public/redirects',
  method: 'get',
  handler: (req: PayloadRequest) => respond(req, true),
}

export const publicRedirectsHeadEndpoint: Endpoint = {
  path: '/public/redirects',
  method: 'head',
  handler: (req: PayloadRequest) => respond(req, false),
}

export const publicRedirectsPreflightEndpoint: Endpoint = {
  path: '/public/redirects',
  method: 'options',
  handler: async (req: PayloadRequest) => {
    const origin = req.headers.get('origin')
    if (origin && !isOriginAllowed(origin)) return new Response(null, { status: 403 })
    return new Response(null, { status: 204, headers: { ...corsHeaders(origin), Vary: 'Origin' } })
  },
}
