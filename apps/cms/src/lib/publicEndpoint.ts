import type { Endpoint, PayloadRequest } from 'payload'

import { isOriginAllowed } from '../endpoints/publicSubmissions'
import type { RateLimitResult } from './rateLimit'
import { getClientIp } from './rateLimit'
import { isTurnstileDummySecret, verifyTurnstile } from './turnstile'

/**
 * Shared mechanics of the NEW anonymous endpoints (contact, newsletter). They follow the same rules
 * as POST /api/public/submissions (go-live contracts section 0): Origin allowlist, CORS with an
 * exposed Retry-After, JSON only, a hard body cap, one error shape. `publicSubmissions.ts` keeps its own
 * copy on purpose (it is deliberately left untouched); nothing here changes its behaviour.
 */

export type FieldError = { field?: string; message: string }

export const positiveInt = (value: string | undefined, fallback: number): number => {
  const n = Number.parseInt(value ?? '', 10)
  return n > 0 ? n : fallback
}

export const json = (body: unknown, status: number, headers: Record<string, string> = {}): Response =>
  Response.json(body, { status, headers })

export const corsHeaders = (origin: string | null, methods = 'POST, OPTIONS'): Record<string, string> =>
  origin
    ? {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': methods,
        'Access-Control-Allow-Headers': 'Content-Type',
        // Retry-After is not CORS-safelisted: without this a cross-origin script reads null on a 429.
        'Access-Control-Expose-Headers': 'Retry-After',
        'Access-Control-Max-Age': '600',
        Vary: 'Origin',
      }
    : {}

/**
 * Make a value safe to put in a mail header (subject, display name): control characters, including
 * CR and LF, become spaces, runs of whitespace collapse, and the result is capped. Header injection
 * needs a line break, so none can survive this.
 */
export function stripHeaderValue(value: unknown, max = 200): string {
  if (typeof value !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  // \s also matches U+2028 / U+2029, so those line separators collapse to a space as well.
  const out = value.replace(/[\x00-\x1F\x7F-\x9F]/g, ' ').replace(/\s+/g, ' ').trim()
  return out.length > max ? out.slice(0, max).trim() : out
}

/** A non-empty `website` field is the honeypot. Same rule as story submissions. */
export function isHoneypotHit(input: Record<string, unknown>): boolean {
  const hp = input.website
  if (hp === undefined || hp === null || hp === '') return false
  return !(typeof hp === 'string' && hp.trim() === '')
}

/** Reads at most `maxBytes` of the request body. `null` means the cap was exceeded. */
export async function readLimitedText(req: PayloadRequest, maxBytes: number): Promise<string | null> {
  const stream = req.body
  if (!stream) return ''
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export type PublicContext = {
  ip: string
  origin: string | null
  /** CORS headers to attach to every response (empty when there is no allowlisted Origin). */
  cors: Record<string, string>
  /** Uniform error response. */
  fail: (status: number, message: string, extra?: Record<string, string>) => Response
  /** Per-field validation error response (400). */
  invalid: (errors: FieldError[]) => Response
  /** 429 with Retry-After when the limiter says no, otherwise null. */
  limit: (result: RateLimitResult, message: string) => Response | null
  ok: (body: unknown, status: number) => Response
}

/**
 * Steps 1 of the shared processing order: Origin (403), Content-Type (415), declared size (413).
 * Returns the response that ends the request, or a context for the remaining steps.
 */
export function guardPublicRequest(
  req: PayloadRequest,
  options: { maxBytes: number; methods?: string },
): { response: Response } | { ctx: PublicContext } {
  const origin = req.headers.get('origin')
  const allowed = isOriginAllowed(origin)
  const cors = corsHeaders(origin && allowed ? origin : null, options.methods)
  const fail: PublicContext['fail'] = (status, message, extra = {}) =>
    json({ ok: false, errors: [{ message }] }, status, { ...cors, ...extra })
  const ctx: PublicContext = {
    ip: getClientIp(req),
    origin,
    cors,
    fail,
    invalid: (errors) => json({ ok: false, errors }, 400, cors),
    limit: (result, message) =>
      result.allowed ? null : fail(429, message, { 'Retry-After': String(result.retryAfterSeconds) }),
    ok: (body, status) => json(body, status, cors),
  }

  if (!allowed) return { response: fail(403, 'Origin not allowed.') }

  const contentType = (req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (contentType !== 'application/json') {
    return { response: fail(415, 'Content-Type must be application/json.') }
  }

  const declared = Number.parseInt(req.headers.get('content-length') ?? '', 10)
  if (Number.isFinite(declared) && declared > options.maxBytes) {
    return { response: fail(413, 'Request body too large.') }
  }
  return { ctx }
}

/** Capped body read plus JSON parse. */
export async function readJsonBody(
  req: PayloadRequest,
  ctx: PublicContext,
  maxBytes: number,
): Promise<{ value: unknown } | { response: Response }> {
  const text = await readLimitedText(req, maxBytes)
  if (text === null) return { response: ctx.fail(413, 'Request body too large.') }
  try {
    return { value: JSON.parse(text) as unknown }
  } catch {
    return { response: ctx.fail(400, 'Request body must be valid JSON.') }
  }
}

/**
 * Server-side Turnstile check for ONE endpoint action. verifyTurnstile is the same check story submissions use and
 * decides everything it decides there (a missing token, an action missing from TURNSTILE_EXPECTED_ACTION, a token without an
 * action while that list is set, Cloudflare's dummy test secret). On top of it, and ONLY when that allowlist is set, the
 * secret is a real one and the token does report an action, the action must be this endpoint's own, so a token minted for
 * the newsletter widget cannot be replayed against the contact form (or the reverse) because both are on the allowlist.
 * It is never stricter than the story endpoint where that endpoint is lenient: allowlist unset, no action reported, or a
 * dummy secret (which reports the fixed action "test") behave exactly as for story submissions. Returns the rejecting
 * response, or null.
 */
export async function checkTurnstileForAction(
  req: PayloadRequest,
  ctx: PublicContext,
  input: Record<string, unknown>,
  action: string,
): Promise<Response | null> {
  const verdict = await verifyTurnstile({
    token: input.turnstileToken ?? input['cf-turnstile-response'],
    remoteip: ctx.ip,
    logger: req.payload.logger,
  })
  if (!verdict.ok) {
    return json(
      { ok: false, errors: [{ field: verdict.field, message: verdict.message }] },
      verdict.status,
      ctx.cors,
    )
  }
  const allowlistSet = (process.env.TURNSTILE_EXPECTED_ACTION ?? '').split(',').some((s) => s.trim() !== '')
  const secret = process.env.TURNSTILE_SECRET_KEY?.trim()
  const realSecret = Boolean(secret) && !isTurnstileDummySecret(secret as string)
  if (allowlistSet && realSecret && verdict.action !== undefined && verdict.action !== action) {
    req.payload.logger.warn({ got: verdict.action, expected: action }, '[turnstile] action does not match this endpoint.')
    return json(
      { ok: false, errors: [{ field: 'turnstileToken', message: 'Verification failed. Please try again.' }] },
      403,
      ctx.cors,
    )
  }
  return null
}

/** OPTIONS preflight for a public POST path. */
export function makePreflightEndpoint(path: Endpoint['path']): Endpoint {
  return {
    path,
    method: 'options',
    handler: async (req: PayloadRequest) => {
      const origin = req.headers.get('origin')
      if (origin && !isOriginAllowed(origin)) return new Response(null, { status: 403 })
      return new Response(null, { status: 204, headers: corsHeaders(origin) })
    },
  }
}

/** 405 answers (with `Allow`) for every non-POST method, so a link pre-fetch can never act on a POST-only path. */
export function makeMethodNotAllowedEndpoints(path: Endpoint['path']): Endpoint[] {
  return (['get', 'put', 'patch', 'delete'] as const).map((method) => ({
    path,
    method,
    handler: async () =>
      Response.json(
        { ok: false, errors: [{ message: 'Method not allowed. Use POST.' }] },
        { status: 405, headers: { Allow: 'POST, OPTIONS', 'Cache-Control': 'no-store' } },
      ),
  }))
}
