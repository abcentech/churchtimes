import type { Endpoint, PayloadRequest } from 'payload'

import { buildUnsubscribeUrl, INVALID_LINK_MESSAGE, isPlausibleToken, resolvePublicSiteUrl } from '../lib/newsletter'
import { positiveInt, readLimitedText } from '../lib/publicEndpoint'
import { createRateLimiter, getClientIp } from '../lib/rateLimit'
import { unsubscribeByToken } from './publicNewsletter'

/**
 * RFC 8058 one-click unsubscribe: the URL in every digest's `List-Unsubscribe` header.
 * - POST `/api/public/newsletter/one-click?token=u1...` with body `List-Unsubscribe=One-Click` (form-urlencoded or
 *   multipart, as sent by Gmail, Yahoo, Apple Mail and others). Unsubscribes at once and answers 200 text/plain.
 *   There is no Origin, cookie, CORS or Turnstile requirement: the mailbox provider's server makes the request, and
 *   the signed HMAC token (lib/newsletter.ts) is the only credential. The body marker is required so that a stray
 *   POST cannot trigger it.
 * - GET never changes anything (mail scanners pre-fetch links): it redirects (303) to the public site's unsubscribe
 *   page, where the reader presses the button.
 * Nothing new is logged: the shared unsubscribe writes the same single audit row as the reader page.
 */

const MAX_BODY = 4 * 1024

let limiter: ReturnType<typeof createRateLimiter> | undefined
/** Mailbox providers send from shared egress IPs, so the per-IP budget is generous (NEWSLETTER_ONE_CLICK_RATE_LIMIT, per 15 min). */
const getLimiter = () =>
  (limiter ??= createRateLimiter({
    limit: positiveInt(process.env.NEWSLETTER_ONE_CLICK_RATE_LIMIT, 600),
    windowMs: 900 * 1000,
  }))

export function resetOneClickLimiter(): void {
  limiter = undefined
}

const text = (status: number, body: string, extra: Record<string, string> = {}) =>
  new Response(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', ...extra },
  })

/** True for `List-Unsubscribe=One-Click` as a urlencoded pair or as a multipart field. */
export function isOneClickBody(contentType: string, body: string): boolean {
  const type = contentType.split(';')[0]!.trim().toLowerCase()
  if (type === 'application/x-www-form-urlencoded') {
    return new URLSearchParams(body).getAll('List-Unsubscribe').includes('One-Click')
  }
  if (type === 'multipart/form-data') {
    return /name="List-Unsubscribe"\r?\n(?:[^\r\n]+\r?\n)*\r?\nOne-Click\r?\n/i.test(body)
  }
  return false
}

const tokenOf = (req: PayloadRequest): string | null => {
  const values = req.searchParams.getAll('token')
  return values.length === 1 && isPlausibleToken(values[0]) ? values[0]! : null
}

export const newsletterOneClickEndpoint: Endpoint = {
  path: '/public/newsletter/one-click',
  method: 'post',
  handler: async (req: PayloadRequest) => {
    const limit = getLimiter().check(getClientIp(req))
    if (!limit.allowed) return text(429, 'Too many requests.', { 'Retry-After': String(limit.retryAfterSeconds) })
    const token = tokenOf(req)
    if (!token) return text(400, INVALID_LINK_MESSAGE)
    const declared = Number.parseInt(req.headers.get('content-length') ?? '', 10)
    if (Number.isFinite(declared) && declared > MAX_BODY) return text(413, 'Request body too large.')
    const body = await readLimitedText(req, MAX_BODY)
    if (body === null) return text(413, 'Request body too large.')
    if (!isOneClickBody(req.headers.get('content-type') ?? '', body)) {
      return text(400, 'Expected List-Unsubscribe=One-Click.')
    }
    const result = await unsubscribeByToken(req, token)
    if (result === 'invalid') return text(400, INVALID_LINK_MESSAGE)
    if (result === 'error') return text(500, 'Could not unsubscribe. Please try again.')
    return text(200, 'You have been unsubscribed from the Church Times Nigeria newsletter.')
  },
}

export const newsletterOneClickGetEndpoint: Endpoint = {
  path: '/public/newsletter/one-click',
  method: 'get',
  handler: async (req: PayloadRequest) => {
    const limit = getLimiter().check(getClientIp(req))
    if (!limit.allowed) return text(429, 'Too many requests.', { 'Retry-After': String(limit.retryAfterSeconds) })
    const token = tokenOf(req)
    const site = resolvePublicSiteUrl()
    if (!token || !site) return text(400, INVALID_LINK_MESSAGE)
    return new Response(null, {
      status: 303,
      headers: { Location: buildUnsubscribeUrl(site, token), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
    })
  },
}

export const newsletterOneClickEndpoints: Endpoint[] = [newsletterOneClickEndpoint, newsletterOneClickGetEndpoint]
