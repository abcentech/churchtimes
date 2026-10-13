import { randomInt } from 'node:crypto'

import type { Endpoint, PayloadRequest } from 'payload'

import { writeAuditLog } from '../lib/audit'
import { createRateLimiter, getClientIp, hashIp } from '../lib/rateLimit'
import { cleanText, isValidEmail } from '../lib/sanitize'
import { computeContentHash } from '../lib/submissionHash'
import { verifyTurnstile } from '../lib/turnstile'

const MAX_BODY_BYTES = 64 * 1024
const REF_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' // no 0/O/1/I/L

export type FieldError = { field?: string; message: string }

export type ValidSubmission = {
  name: string
  email: string
  phone?: string
  title: string
  body: string
  categorySuggestion?: string
  location?: string
}

export type ValidationResult =
  | { ok: true; honeypot: false; data: ValidSubmission }
  | { ok: true; honeypot: true }
  | { ok: false; errors: FieldError[] }

/**
 * Pure validation + sanitising of the raw JSON body. Only whitelisted fields are copied;
 * unknown fields (including `status`, `reference`, ...) are ignored.
 */
export function validateSubmissionInput(raw: unknown): ValidationResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: [{ message: 'Request body must be a JSON object.' }] }
  }
  const input = raw as Record<string, unknown>

  const hp = input.website
  if (hp !== undefined && hp !== null && hp !== '' && !(typeof hp === 'string' && hp.trim() === '')) {
    return { ok: true, honeypot: true }
  }

  const errors: FieldError[] = []
  const check = (
    field: string,
    value: unknown,
    min: number,
    max: number,
    opts: { required: boolean; multiline?: boolean; label: string },
  ): string => {
    const full = cleanText(value, { multiline: opts.multiline })
    if (!full) {
      if (opts.required) errors.push({ field, message: `${opts.label} is required.` })
      return ''
    }
    if (full.length < min) errors.push({ field, message: `${opts.label} must be at least ${min} characters.` })
    else if (full.length > max) errors.push({ field, message: `${opts.label} must be at most ${max} characters.` })
    return full
  }

  const name = check('name', input.name, 2, 120, { required: true, label: 'Name' })
  const title = check('title', input.title, 5, 200, { required: true, label: 'Title' })
  const body = check('body', input.body, 30, 20_000, { required: true, multiline: true, label: 'Story' })
  const phone = check('phone', input.phone, 0, 40, { required: false, label: 'Phone' })
  const categorySuggestion = check('categorySuggestion', input.categorySuggestion, 0, 100, {
    required: false,
    label: 'Category',
  })
  const location = check('location', input.location, 0, 120, { required: false, label: 'Location' })

  const email = typeof input.email === 'string' ? input.email.trim() : ''
  if (!email) errors.push({ field: 'email', message: 'Email is required.' })
  else if (!isValidEmail(email)) errors.push({ field: 'email', message: 'Enter a valid email address.' })

  if (errors.length) return { ok: false, errors }

  return {
    ok: true,
    honeypot: false,
    data: {
      name,
      email,
      title,
      body,
      ...(phone ? { phone } : {}),
      ...(categorySuggestion ? { categorySuggestion } : {}),
      ...(location ? { location } : {}),
    },
  }
}

export function generateReference(): string {
  let out = ''
  for (let i = 0; i < 8; i++) out += REF_ALPHABET[randomInt(REF_ALPHABET.length)]
  return `SUB-${out}`
}

/**
 * Allowed browser origins. PUBLIC_SUBMISSION_ORIGINS (comma list).
 * - set: Origin header, when present, must match exactly.
 * - unset + NODE_ENV=production: any request carrying an Origin header is rejected (non-browser
 *   clients without Origin still work; rate limiting applies).
 * - unset + non-production: allowed (local development).
 */
export function isOriginAllowed(origin: string | null, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!origin) return true
  const list = (env.PUBLIC_SUBMISSION_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean)
  if (list.length === 0) return env.NODE_ENV !== 'production'
  return list.includes(origin.replace(/\/$/, ''))
}

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers })

const corsHeaders = (origin: string | null): Record<string, string> =>
  origin
    ? {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '600',
        Vary: 'Origin',
      }
    : {}

let limiter: ReturnType<typeof createRateLimiter> | undefined
let emailLimiter: ReturnType<typeof createRateLimiter> | undefined

const positiveInt = (value: string | undefined, fallback: number): number => {
  const n = Number.parseInt(value ?? '', 10)
  return n > 0 ? n : fallback
}

/** Per-email limiter: SUBMISSION_EMAIL_RATE_LIMIT (default 3) per SUBMISSION_EMAIL_RATE_WINDOW_SECONDS (default 3600). */
const getEmailLimiter = () => {
  if (!emailLimiter) {
    emailLimiter = createRateLimiter({
      limit: positiveInt(process.env.SUBMISSION_EMAIL_RATE_LIMIT, 3),
      windowMs: positiveInt(process.env.SUBMISSION_EMAIL_RATE_WINDOW_SECONDS, 3600) * 1000,
    })
  }
  return emailLimiter
}

/** Test helper: drop all counters and re-read limits from the environment. */
export function resetPublicSubmissionLimiters(): void {
  limiter = undefined
  emailLimiter = undefined
}

const getLimiter = () => {
  if (!limiter) {
    const limit = Number.parseInt(process.env.SUBMISSION_RATE_LIMIT ?? '', 10)
    const windowSec = Number.parseInt(process.env.SUBMISSION_RATE_WINDOW_SECONDS ?? '', 10)
    limiter = createRateLimiter({
      limit: limit > 0 ? limit : 5,
      windowMs: (windowSec > 0 ? windowSec : 900) * 1000,
    })
  }
  return limiter
}

async function readLimitedText(req: PayloadRequest): Promise<string | null> {
  const stream = req.body
  if (!stream) return ''
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export const publicSubmissionsEndpoint: Endpoint = {
  path: '/public/submissions',
  method: 'post',
  handler: async (req: PayloadRequest) => {
    const origin = req.headers.get('origin')
    const cors = corsHeaders(origin && isOriginAllowed(origin) ? origin : null)
    const fail = (status: number, message: string, extra: Record<string, string> = {}) =>
      json({ ok: false, errors: [{ message }] }, status, { ...cors, ...extra })

    if (!isOriginAllowed(origin)) return fail(403, 'Origin not allowed.')

    const contentType = (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (contentType !== 'application/json') return fail(415, 'Content-Type must be application/json.')

    const declared = Number.parseInt(req.headers.get('content-length') ?? '', 10)
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return fail(413, 'Request body too large.')

    const ip = getClientIp(req)
    const rl = getLimiter().check(ip)
    if (!rl.allowed) {
      return fail(429, 'Too many submissions. Try again later.', {
        'Retry-After': String(rl.retryAfterSeconds),
      })
    }

    const text = await readLimitedText(req)
    if (text === null) return fail(413, 'Request body too large.')

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return fail(400, 'Request body must be valid JSON.')
    }

    const result = validateSubmissionInput(parsed)
    if (!result.ok) return json({ ok: false, errors: result.errors }, 400, cors)

    const reference = generateReference()
    const okBody = {
      ok: true,
      reference,
      message: 'Received. An editor will review your submission.',
    }
    if (result.honeypot) return json(okBody, 201, cors)

    // Turnstile (mandatory, server-side Siteverify). Runs after the IP rate limit and input
    // validation so bots cannot burn our Siteverify quota. Fails closed.
    const rawInput = parsed as Record<string, unknown>
    const turnstileToken = rawInput.turnstileToken ?? rawInput['cf-turnstile-response']
    const verdict = await verifyTurnstile({
      token: turnstileToken,
      remoteip: ip,
      logger: req.payload.logger,
    })
    if (!verdict.ok) {
      return json(
        { ok: false, errors: [{ field: verdict.field, message: verdict.message }] },
        verdict.status,
        cors,
      )
    }

    // Duplicate detection (same email + title + body within the window).
    const contentHash = computeContentHash(result.data)
    const windowHours = positiveInt(process.env.SUBMISSION_DUPLICATE_WINDOW_HOURS, 72)
    const since = new Date(Date.now() - windowHours * 3600 * 1000).toISOString()
    try {
      const dup = await req.payload.find({
        collection: 'submissions',
        where: { and: [{ contentHash: { equals: contentHash } }, { createdAt: { greater_than: since } }] },
        limit: 1,
        depth: 0,
        pagination: false,
        select: { contentHash: true },
        overrideAccess: true,
      })
      if (dup.docs.length > 0) return fail(409, 'We already received this submission.')
    } catch (err) {
      req.payload.logger.error({ err }, 'duplicate check failed')
      return fail(500, 'Could not save your submission. Please try again.')
    }

    // Per-email limit (counted only for verified, non-duplicate submissions).
    const emailRl = getEmailLimiter().check(result.data.email.toLowerCase())
    if (!emailRl.allowed) {
      return fail(429, 'Too many submissions from this email address. Try again later.', {
        'Retry-After': String(emailRl.retryAfterSeconds),
      })
    }

    let ipHash: string
    try {
      ipHash = hashIp(ip)
    } catch (err) {
      req.payload.logger.error({ err }, 'IP_HASH_SALT misconfigured')
      return fail(500, 'Submissions are temporarily unavailable.')
    }

    const userAgent = cleanText(req.headers.get('user-agent'), { max: 300 })

    try {
      const doc = await req.payload.create({
        collection: 'submissions',
        data: { ...result.data, status: 'new', reference, ipHash, userAgent, contentHash } as never,
        overrideAccess: true,
      })
      await writeAuditLog(req, {
        action: 'submission.create',
        collection: 'submissions',
        docId: (doc as { id: number | string }).id,
        actor: null,
        toStatus: 'new',
        summary: `Public submission ${reference}`,
      })
    } catch (err) {
      req.payload.logger.error({ err }, 'public submission failed')
      return fail(500, 'Could not save your submission. Please try again.')
    }

    return json(okBody, 201, cors)
  },
}

export const publicSubmissionsPreflightEndpoint: Endpoint = {
  path: '/public/submissions',
  method: 'options',
  handler: async (req: PayloadRequest) => {
    const origin = req.headers.get('origin')
    if (origin && !isOriginAllowed(origin)) return new Response(null, { status: 403 })
    return new Response(null, { status: 204, headers: corsHeaders(origin) })
  },
}
