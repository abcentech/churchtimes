import type { Endpoint, PayloadRequest } from 'payload'

import { isStaff, type UserLike } from '../access/roles'
import { lexicalToPlainText } from '../lib/articleSearch'
import { positiveInt } from '../lib/publicEndpoint'
import { createRateLimiter } from '../lib/rateLimit'
import { safeErrorFields } from '../lib/safeLog'
import {
  deriveTerms,
  findRelatedArticles,
  readLimitedText,
  RETRIEVER_DEFAULT_LIMIT,
  RETRIEVER_INPUT_MAX,
  RETRIEVER_MAX_LIMIT,
} from '../lib/staffRetriever'

/**
 * `POST /api/staff/related-articles` body `{ text?, articleId?, limit? }`. Staff session only (every role may use it),
 * read-only, no generation. Cookie sessions are subject to Payload's CSRF origin check (a request from an origin outside
 * the `csrf` list is anonymous and gets 401). The text is never logged. `Cache-Control: private, no-store`.
 */

const HEADERS = { 'Cache-Control': 'private, no-store', Vary: 'Cookie, Authorization', 'X-Content-Type-Options': 'nosniff' }
/** Raw body ceiling: generous for 20k characters of any script plus JSON escaping, small enough to refuse abuse early. */
const BODY_MAX_BYTES = 256 * 1024

const fail = (status: number, message: string, extra: Record<string, string> = {}) =>
  Response.json({ ok: false, errors: [{ message }] }, { status, headers: { ...HEADERS, ...extra } })

let limiter: ReturnType<typeof createRateLimiter> | undefined
const getLimiter = () =>
  (limiter ??= createRateLimiter({
    limit: positiveInt(process.env.STAFF_RELATED_RATE_LIMIT, 30),
    windowMs: positiveInt(process.env.STAFF_RELATED_RATE_WINDOW_SECONDS, 60) * 1000,
  }))

/** Test helper: drop all counters and re-read limits from the environment. */
export function resetStaffRelatedLimiter(): void {
  limiter = undefined
}

async function readJson(req: PayloadRequest): Promise<unknown> {
  const declared = Number(req.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > BODY_MAX_BYTES) return 'too-large'
  const raw = await readLimitedText((req as unknown as Request).body, BODY_MAX_BYTES)
  if (raw === null) return 'too-large'
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

async function handle(req: PayloadRequest): Promise<Response> {
  const user = req.user as UserLike | null
  if (!user) return fail(401, 'Authentication required.')
  if (!isStaff(user)) return fail(403, 'Staff access required.')

  const rl = getLimiter().check(String(user.id ?? 'unknown'))
  if (!rl.allowed) return fail(429, 'Too many requests. Try again shortly.', { 'Retry-After': String(rl.retryAfterSeconds) })

  const body = await readJson(req)
  if (body === 'too-large') return fail(413, 'Request body is too large.')
  if (body === null || body === undefined || typeof body !== 'object' || Array.isArray(body)) {
    return fail(400, 'A JSON object body is required.')
  }
  const { text, articleId, limit: rawLimit } = body as Record<string, unknown>

  if (text !== undefined && text !== null && typeof text !== 'string') return fail(400, '"text" must be a string.')
  const freeText = typeof text === 'string' ? text : ''
  let id: number | null = null
  if (articleId !== undefined && articleId !== null) {
    const s = typeof articleId === 'number' ? String(articleId) : articleId
    if (typeof s !== 'string' || !/^\d{1,9}$/.test(s)) return fail(400, '"articleId" must be a positive integer id.')
    id = Number(s)
  }
  if (freeText.trim() === '' && id === null) return fail(400, 'Provide "text" or "articleId".')

  let limit = RETRIEVER_DEFAULT_LIMIT
  if (rawLimit !== undefined && rawLimit !== null) {
    if (typeof rawLimit !== 'number' || !Number.isInteger(rawLimit) || rawLimit < 1) return fail(400, '"limit" must be a positive integer.')
    limit = Math.min(rawLimit, RETRIEVER_MAX_LIMIT)
  }

  try {
    let title = ''
    let content = freeText
    if (id !== null) {
      // Local API with the caller's own access rules: a reporter can only load drafts they may read.
      let doc: Record<string, unknown> | null = null
      try {
        doc = (await req.payload.findByID({ collection: 'articles', id, depth: 0, user, overrideAccess: false, req })) as unknown as Record<string, unknown>
      } catch {
        doc = null
      }
      if (!doc) return fail(404, 'Article not found.')
      title = String(doc.title ?? '')
      if (content.trim() === '') content = `${String(doc.excerpt ?? '')} ${lexicalToPlainText(doc.content, RETRIEVER_INPUT_MAX)}`
    }
    const { terms, truncated } = deriveTerms(title, content)
    const results = await findRelatedArticles(req.payload, terms, { limit, excludeId: id })
    return Response.json(
      { ok: true, results, limit, truncated },
      { status: 200, headers: { ...HEADERS, 'Content-Type': 'application/json; charset=utf-8' } },
    )
  } catch (err) {
    req.payload.logger.error(safeErrorFields(err), '[staff-related] query failed')
    return fail(500, 'Related-article search is temporarily unavailable.')
  }
}

export const staffRelatedArticlesEndpoints: Endpoint[] = [{ path: '/staff/related-articles', method: 'post', handler: handle }]
