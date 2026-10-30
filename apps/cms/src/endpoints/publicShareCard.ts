import { createHash } from 'node:crypto'

import type { Endpoint, Payload, PayloadRequest, Where } from 'payload'

import { positiveInt } from '../lib/publicEndpoint'
import { createRateLimiter, getClientIp } from '../lib/rateLimit'
import { safeErrorFields } from '../lib/safeLog'
import { SLUG_RE } from '../lib/sanitize'
import { cleanCardText, renderShareCard, type ShareCardInput } from '../lib/shareCard'

/**
 * `GET|HEAD /api/public/share-card/:slug` (also `:slug.png`): the 1200x630 Open Graph PNG of a PUBLISHED article.
 *
 * - Off unless SHARE_CARDS_ENABLED=true (404 `no-store` when off), so nothing renders until the owner opts in.
 * - Anonymous, read-only, no cookies used, no CORS (an <img>/crawler fetch needs none). Slug shape is checked before the
 *   database is touched; drafts, scheduled and unknown slugs are 404.
 * - Per-IP rate limit (SHARE_CARD_RATE_LIMIT per SHARE_CARD_RATE_WINDOW_SECONDS, default 60 per 60 s) -> 429 + Retry-After.
 * - The ETag is a hash of the render input (headline, label, date, renderer version), so a matching If-None-Match is
 *   answered 304 without rendering. Rendered PNGs are kept in a small in-process LRU (SHARE_CARD_CACHE_MAX entries,
 *   default 50, and at most 25 MB). `Cache-Control: public, max-age=86400`: a CDN in front absorbs repeat crawler hits.
 * - At most SHARE_CARD_MAX_CONCURRENT renders (default 2) run at once; identical requests share one render; beyond that
 *   the answer is 503 + Retry-After so a crawler burst cannot pin the CPU.
 */

/** Bump when the card layout changes: every ETag and cache key changes with it. */
export const SHARE_CARD_RENDER_VERSION = 'og-v1'

const MAX_CACHE_BYTES = 25 * 1024 * 1024

export const shareCardsEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.SHARE_CARDS_ENABLED === 'true'

let limiter: ReturnType<typeof createRateLimiter> | undefined
const getLimiter = () =>
  (limiter ??= createRateLimiter({
    limit: positiveInt(process.env.SHARE_CARD_RATE_LIMIT, 60),
    windowMs: positiveInt(process.env.SHARE_CARD_RATE_WINDOW_SECONDS, 60) * 1000,
  }))

const cache = new Map<string, Buffer>()
let cacheBytes = 0
const inflight = new Map<string, Promise<Buffer>>()
let active = 0

/** Test helper: drop the cache, in-flight renders and rate-limit counters, and re-read limits from the environment. */
export function resetShareCardState(): void {
  limiter = undefined
  cache.clear()
  cacheBytes = 0
  inflight.clear()
  active = 0
}

export const shareCardCacheSize = (): { entries: number; bytes: number } => ({ entries: cache.size, bytes: cacheBytes })

function cacheGet(key: string): Buffer | undefined {
  const hit = cache.get(key)
  if (hit) {
    cache.delete(key)
    cache.set(key, hit)
  }
  return hit
}

function cachePut(key: string, png: Buffer): void {
  const maxEntries = positiveInt(process.env.SHARE_CARD_CACHE_MAX, 50)
  const old = cache.get(key)
  if (old) {
    cache.delete(key)
    cacheBytes -= old.length
  }
  if (png.length > MAX_CACHE_BYTES) return
  cache.set(key, png)
  cacheBytes += png.length
  while (cache.size > maxEntries || cacheBytes > MAX_CACHE_BYTES) {
    const oldest = cache.keys().next().value as string
    cacheBytes -= cache.get(oldest)!.length
    cache.delete(oldest)
  }
}

/** Accepts `my-story` and `my-story.png`. Null when the value cannot be a published slug. */
export function parseCardSlug(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const slug = raw.endsWith('.png') ? raw.slice(0, -4) : raw
  return slug.length > 0 && slug.length <= 160 && SLUG_RE.test(slug) ? slug : null
}

export type CardArticle = { id: string; slug: string; input: ShareCardInput }

/** True when the articles collection has a field (the w12 `kicker` field may not be migrated yet). */
function hasArticleField(payload: Payload, name: string): boolean {
  const fields = (payload.collections as Record<string, { config?: { flattenedFields?: Array<{ name?: string }> } }>)?.articles
    ?.config?.flattenedFields
  return Array.isArray(fields) && fields.some((f) => f?.name === name)
}

/** Published article -> card input (kicker first, else the primary category title). Null when not published or unknown. */
export async function findCardArticle(payload: Payload, where: Where): Promise<CardArticle | null> {
  const withKicker = hasArticleField(payload, 'kicker')
  const result = await payload.find({
    collection: 'articles',
    where: { and: [where, { status: { equals: 'published' } }] },
    limit: 1,
    depth: 1,
    pagination: false,
    overrideAccess: true,
    select: {
      title: true,
      slug: true,
      status: true,
      publishedAt: true,
      category: true,
      ...(withKicker ? { kicker: true } : {}),
    } as never,
  })
  const doc = result.docs[0] as unknown as Record<string, unknown> | undefined
  if (!doc || doc.status !== 'published' || typeof doc.slug !== 'string' || !SLUG_RE.test(doc.slug)) return null
  const category = doc.category && typeof doc.category === 'object' ? (doc.category as Record<string, unknown>).title : null
  const kicker = withKicker ? cleanCardText(doc.kicker, 60) : ''
  return {
    id: String(doc.id),
    slug: doc.slug,
    input: {
      title: cleanCardText(doc.title, 400),
      label: kicker || cleanCardText(category, 100) || null,
      date: typeof doc.publishedAt === 'string' ? doc.publishedAt : null,
    },
  }
}

/** Cache key and ETag source: everything that changes the pixels. */
export function cardKey(input: ShareCardInput): string {
  const date = input.date instanceof Date ? input.date.toISOString() : (input.date ?? '')
  return createHash('sha256')
    .update(JSON.stringify([SHARE_CARD_RENDER_VERSION, input.title, input.label ?? '', date]))
    .digest('hex')
    .slice(0, 32)
}

type RenderOutcome = { png: Buffer } | { busy: true }

async function renderCached(key: string, input: ShareCardInput, render = renderShareCard): Promise<RenderOutcome> {
  const hit = cacheGet(key)
  if (hit) return { png: hit }
  const running = inflight.get(key)
  if (running) return { png: await running }
  if (active >= positiveInt(process.env.SHARE_CARD_MAX_CONCURRENT, 2)) return { busy: true }
  active += 1
  const job = render(input)
    .then((png) => {
      cachePut(key, png)
      return png
    })
    .finally(() => {
      active -= 1
      inflight.delete(key)
    })
  inflight.set(key, job)
  return { png: await job }
}

/**
 * Renders (or refreshes) the card of a published article into the in-process cache, e.g. right after publishing, so the
 * first crawler hit is served from memory. Never throws: returns false when the article is not published, the feature
 * is off or rendering fails.
 */
export async function warmShareCard(payload: Payload, articleId: number | string): Promise<boolean> {
  if (!shareCardsEnabled()) return false
  try {
    const article = await findCardArticle(payload, { id: { equals: articleId } })
    if (!article) return false
    const outcome = await renderCached(cardKey(article.input), article.input)
    return 'png' in outcome
  } catch (err) {
    payload.logger.error(safeErrorFields(err), 'share card warm-up failed')
    return false
  }
}

const textResponse = (status: number, message: string, headers: Record<string, string> = {}) =>
  new Response(message, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  })

const etagMatches = (header: string | null, etag: string): boolean =>
  Boolean(header && header.split(',').map((t) => t.trim().replace(/^W\//, '')).some((t) => t === etag || t === '*'))

export async function respondShareCard(req: PayloadRequest, withBody: boolean): Promise<Response> {
  if (!shareCardsEnabled()) return textResponse(404, 'Not found')

  const slug = parseCardSlug(req.routeParams?.slug)
  if (!slug) return textResponse(404, 'Not found')

  const rate = getLimiter().check(getClientIp(req))
  if (!rate.allowed) return textResponse(429, 'Too many requests', { 'Retry-After': String(rate.retryAfterSeconds) })

  let article: CardArticle | null
  try {
    article = await findCardArticle(req.payload, { slug: { equals: slug } })
  } catch (err) {
    req.payload.logger.error(safeErrorFields(err), 'share card lookup failed')
    return textResponse(503, 'Temporarily unavailable', { 'Retry-After': '60' })
  }
  if (!article) return textResponse(404, 'Not found', { 'Cache-Control': 'public, max-age=60' })

  const key = cardKey(article.input)
  const etag = `"${key}"`
  const headers = { ETag: etag, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' }
  if (etagMatches(req.headers.get('if-none-match'), etag)) return new Response(null, { status: 304, headers })

  let outcome: RenderOutcome
  try {
    outcome = await renderCached(key, article.input)
  } catch (err) {
    req.payload.logger.error(safeErrorFields(err), 'share card render failed')
    return textResponse(503, 'Temporarily unavailable', { 'Retry-After': '60' })
  }
  if ('busy' in outcome) return textResponse(503, 'Busy', { 'Retry-After': '5' })

  return new Response(withBody ? new Uint8Array(outcome.png) : null, {
    status: 200,
    headers: { ...headers, 'Content-Type': 'image/png', 'Content-Length': String(outcome.png.length) },
  })
}

export const shareCardEndpoints: Endpoint[] = [
  { path: '/public/share-card/:slug', method: 'get', handler: (req: PayloadRequest) => respondShareCard(req, true) },
  { path: '/public/share-card/:slug', method: 'head', handler: (req: PayloadRequest) => respondShareCard(req, false) },
]
