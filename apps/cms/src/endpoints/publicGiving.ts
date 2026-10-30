import { createHash } from 'node:crypto'

import { sql } from '@payloadcms/db-postgres'
import type { Endpoint, PayloadRequest } from 'payload'

import { isEditorInChief, type UserLike } from '../access/roles'
import { isDonationReference } from '../lib/giving/reference'
import { ProviderError } from '../lib/giving/provider'
import { givingDeps, loadGivingRuntime, type GivingRuntime } from '../lib/giving/runtime'
import { confirmDonation, PENDING_STATUS_TTL_MS, startDonation, statusMayVerify } from '../lib/giving/service'
import { publicGivingSettings } from '../lib/giving/settings'
import { GIVING_INIT_MAX_BODY_BYTES, GIVING_TURNSTILE_ACTION, validateGivingInit } from '../lib/giving/validate'
import {
  checkTurnstileForAction,
  corsHeaders,
  guardPublicRequest,
  makePreflightEndpoint,
  positiveInt,
  readJsonBody,
} from '../lib/publicEndpoint'
import { createRateLimiter, getClientIp } from '../lib/rateLimit'
import { safeErrorFields } from '../lib/safeLog'
import { isOriginAllowed } from './publicSubmissions'

/**
 * Giving endpoints (docs/w12/giving.md, plan section 6 D).
 *
 *   POST /api/public/giving/init               start a one-time donation; answers the provider's hosted checkout URL
 *   POST /api/public/giving/webhook/:provider  provider -> us; HMAC on the RAW body, then a server-side verify call
 *   GET  /api/public/giving/status?reference=  the donation's state (re-verified with the provider while recent)
 *   GET  /api/public/giving/settings           public-safe Give page settings ({ enabled: false } when off)
 *   GET  /api/giving/stats                     staff (admin / editor-in-chief): totals, no personal data
 *
 * Giving is off (404 / { enabled: false }) unless giving-settings.enabled AND PAYSTACK_SECRET_KEY are set; without the key
 * no endpoint reads the settings or calls the network. Card data never touches this server: the reader pays on the
 * provider's hosted page.
 */

const WEBHOOK_MAX_BYTES = 64 * 1024
const noStore = { 'Cache-Control': 'no-store' }

let initLimiter: ReturnType<typeof createRateLimiter> | undefined
let emailLimiter: ReturnType<typeof createRateLimiter> | undefined
let statusLimiter: ReturnType<typeof createRateLimiter> | undefined
let badSignatureLimiter: ReturnType<typeof createRateLimiter> | undefined
const getInitLimiter = () =>
  (initLimiter ??= createRateLimiter({
    limit: positiveInt(process.env.GIVING_RATE_LIMIT, 10),
    windowMs: positiveInt(process.env.GIVING_RATE_WINDOW_SECONDS, 900) * 1000,
  }))
const getEmailLimiter = () => (emailLimiter ??= createRateLimiter({ limit: 5, windowMs: 3600 * 1000 }))
const getStatusLimiter = () =>
  (statusLimiter ??= createRateLimiter({
    limit: positiveInt(process.env.GIVING_STATUS_RATE_LIMIT, 120),
    windowMs: positiveInt(process.env.GIVING_STATUS_RATE_WINDOW_SECONDS, 900) * 1000,
  }))
const getBadSignatureLimiter = () => (badSignatureLimiter ??= createRateLimiter({ limit: 30, windowMs: 600 * 1000 }))

/** Per-reference cooldown for provider verify calls made on behalf of the public status check. */
const VERIFY_COOLDOWN_MS = 5_000
const lastVerify = new Map<string, number>()
function verifyAllowed(reference: string, now: number): boolean {
  const last = lastVerify.get(reference)
  if (last !== undefined && now - last < VERIFY_COOLDOWN_MS) return false
  if (lastVerify.size >= 5_000) for (const [k, t] of lastVerify) if (now - t >= VERIFY_COOLDOWN_MS) lastVerify.delete(k)
  if (lastVerify.size >= 5_000) return false
  lastVerify.set(reference, now)
  return true
}

/**
 * Webhook deliveries already handled to a FINAL outcome, by SHA-256 of the raw body. A replay of a captured (validly signed)
 * body is answered 200 without any work. Paystack's signature has no timestamp, so this is defence in depth: the real
 * guarantee is that every state change is a conditional UPDATE and a succeeded row never changes again.
 */
const REPLAY_TTL_MS = 72 * 3600 * 1000
const handledDeliveries = new Map<string, number>()
function seenDelivery(digest: string, now: number): boolean {
  const at = handledDeliveries.get(digest)
  return at !== undefined && now - at < REPLAY_TTL_MS
}
function rememberDelivery(digest: string, now: number): void {
  if (handledDeliveries.size >= 10_000) {
    for (const [k, t] of handledDeliveries) if (now - t >= REPLAY_TTL_MS) handledDeliveries.delete(k)
    // Still full: drop the oldest (Map keeps insertion order).
    while (handledDeliveries.size >= 10_000) handledDeliveries.delete(handledDeliveries.keys().next().value as string)
  }
  handledDeliveries.set(digest, now)
}

/** Test helper: drop limiters, cooldowns and the replay cache. */
export function resetGivingState(): void {
  initLimiter = emailLimiter = statusLimiter = badSignatureLimiter = undefined
  lastVerify.clear()
  handledDeliveries.clear()
}

/** Reads at most `maxBytes` of the body as raw bytes (the HMAC must cover exactly what was sent). `null` = too large. */
async function readLimitedBuffer(req: PayloadRequest, maxBytes: number): Promise<Buffer | null> {
  const stream = req.body
  if (!stream) return Buffer.alloc(0)
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
  return Buffer.concat(chunks)
}

async function runtimeOrNull(req: PayloadRequest): Promise<GivingRuntime | null> {
  try {
    return await loadGivingRuntime(req.payload)
  } catch (err) {
    req.payload.logger.error(safeErrorFields(err), '[giving] runtime failed')
    return null
  }
}

// ---------------------------------------------------------------- init

export const givingInitEndpoint: Endpoint = {
  path: '/public/giving/init',
  method: 'post',
  handler: async (req: PayloadRequest) => {
    const guard = guardPublicRequest(req, { maxBytes: GIVING_INIT_MAX_BODY_BYTES })
    if ('response' in guard) return guard.response
    const { ctx } = guard

    const runtime = await runtimeOrNull(req)
    if (!runtime?.accepting || !runtime.provider || !runtime.settings) return ctx.fail(404, 'Online giving is not available.')

    const limited = ctx.limit(getInitLimiter().check(ctx.ip), 'Too many attempts. Please wait and try again.')
    if (limited) return limited

    const body = await readJsonBody(req, ctx, GIVING_INIT_MAX_BODY_BYTES)
    if ('response' in body) return body.response

    const result = validateGivingInit(body.value, runtime.settings)
    if (!result.ok) return ctx.invalid(result.errors)
    if (result.honeypot) return ctx.fail(400, 'We could not start this payment.')

    const rejected = await checkTurnstileForAction(req, ctx, body.value as Record<string, unknown>, GIVING_TURNSTILE_ACTION)
    if (rejected) return rejected

    const emailLimited = ctx.limit(getEmailLimiter().check(result.data.email), 'Too many attempts for this email address. Please wait and try again.')
    if (emailLimited) return emailLimited

    const started = await startDonation(givingDeps(req.payload, { ...runtime, provider: runtime.provider }), result.data)
    if (!started.ok) return ctx.fail(started.status, started.message)
    return ctx.ok({ ok: true, reference: started.reference, checkoutUrl: started.checkoutUrl }, 201)
  },
}

// ---------------------------------------------------------------- webhook

export const givingWebhookEndpoint: Endpoint = {
  path: '/public/giving/webhook/:provider',
  method: 'post',
  handler: async (req: PayloadRequest) => {
    const reply = (status: number, body: Record<string, unknown>) => Response.json(body, { status, headers: noStore })
    const name = String((req.routeParams as { provider?: unknown } | undefined)?.provider ?? '')

    const runtime = await runtimeOrNull(req)
    // No secret, unknown provider, or a provider other than the configured one: nothing to verify against.
    if (!runtime?.provider || runtime.provider.name !== name) return reply(404, { ok: false })
    const provider = runtime.provider

    const contentType = (req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
    if (contentType !== 'application/json') return reply(415, { ok: false })
    const declared = Number.parseInt(req.headers.get('content-length') ?? '', 10)
    if (Number.isFinite(declared) && declared > WEBHOOK_MAX_BYTES) return reply(413, { ok: false })

    const ip = getClientIp(req)
    const allowedIps = (process.env.PAYSTACK_WEBHOOK_IPS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    if (allowedIps.length > 0 && !allowedIps.includes(ip)) {
      req.payload.logger.warn({ outcome: 'ip-not-allowed' }, '[giving] webhook from an address outside PAYSTACK_WEBHOOK_IPS')
      return reply(403, { ok: false })
    }

    const raw = await readLimitedBuffer(req, WEBHOOK_MAX_BYTES)
    if (raw === null) return reply(413, { ok: false })

    if (!provider.verifyWebhook(raw, req.headers)) {
      const rl = getBadSignatureLimiter().check(ip)
      req.payload.logger.warn({ outcome: 'bad-signature' }, '[giving] webhook signature rejected')
      return rl.allowed ? reply(401, { ok: false }) : reply(429, { ok: false })
    }

    const now = Date.now()
    const digest = createHash('sha256').update(raw).digest('hex')
    if (seenDelivery(digest, now)) {
      req.payload.logger.info({ outcome: 'replay' }, '[giving] webhook delivery already handled')
      return reply(200, { ok: true })
    }

    const event = provider.parseWebhook(raw)
    if (!event) return reply(400, { ok: false })
    // Only a successful charge can change anything, and only via our own verify call. Everything else is acknowledged.
    if (event.event !== 'charge.success' || !isDonationReference(event.reference)) {
      req.payload.logger.info({ event: event.event, outcome: 'ignored' }, '[giving] webhook event ignored')
      rememberDelivery(digest, now)
      return reply(200, { ok: true })
    }

    try {
      const { outcome } = await confirmDonation(givingDeps(req.payload, { ...runtime, provider }), event.reference)
      req.payload.logger.info({ event: event.event, reference: event.reference, outcome }, '[giving] webhook handled')
      // The provider said "success" but verify does not agree yet: answer non-200 so it retries later.
      if (outcome === 'still-pending' || outcome === 'not-found-at-provider') return reply(503, { ok: false })
      rememberDelivery(digest, now)
      return reply(200, { ok: true })
    } catch (err) {
      const fields = err instanceof ProviderError ? { kind: err.kind, status: err.status } : safeErrorFields(err)
      req.payload.logger.error({ reference: event.reference, ...fields }, '[giving] webhook could not be confirmed; provider will retry')
      return reply(503, { ok: false })
    }
  },
}

// ---------------------------------------------------------------- status + settings (GET)

function getContext(req: PayloadRequest) {
  const origin = req.headers.get('origin')
  const cors = { ...corsHeaders(origin && isOriginAllowed(origin) ? origin : null, 'GET, OPTIONS'), Vary: 'Origin' }
  const fail = (status: number, message: string, extra: Record<string, string> = {}) =>
    Response.json({ ok: false, errors: [{ message }] }, { status, headers: { ...noStore, ...cors, ...extra } })
  return { origin, cors, fail, allowed: isOriginAllowed(origin) }
}

export const givingStatusEndpoint: Endpoint = {
  path: '/public/giving/status',
  method: 'get',
  handler: async (req: PayloadRequest) => {
    const { cors, fail, allowed } = getContext(req)
    if (!allowed) return fail(403, 'Origin not allowed.')
    const rl = getStatusLimiter().check(getClientIp(req))
    if (!rl.allowed) return fail(429, 'Too many requests. Please wait and try again.', { 'Retry-After': String(rl.retryAfterSeconds) })

    const params = req.searchParams ?? new URL(req.url ?? 'http://localhost/').searchParams
    const reference = params.get('reference') ?? ''
    if (!isDonationReference(reference)) return fail(400, 'Unknown or invalid reference.')

    const runtime = await runtimeOrNull(req)
    if (!runtime?.provider) return fail(404, 'Online giving is not available.')
    const deps = givingDeps(req.payload, { ...runtime, provider: runtime.provider })

    let row
    try {
      row = await deps.store.findByReference(reference)
    } catch (err) {
      req.payload.logger.error(safeErrorFields(err), '[giving] status lookup failed')
      return fail(500, 'Please try again shortly.')
    }
    if (!row) return fail(404, 'Unknown or invalid reference.')

    const now = new Date()
    if (statusMayVerify(row, now) && verifyAllowed(reference, now.getTime())) {
      try {
        row = (await confirmDonation(deps, reference)).row ?? row
      } catch (err) {
        // The provider is unreachable: report what we know; the webhook (or the next check) will settle it.
        const fields = err instanceof ProviderError ? { kind: err.kind, status: err.status } : safeErrorFields(err)
        req.payload.logger.warn({ reference, ...fields }, '[giving] status verify failed')
      }
    }
    const expired = row.status === 'pending' && now.getTime() - new Date(row.createdAt).getTime() >= PENDING_STATUS_TTL_MS
    return Response.json(
      { ok: true, reference: row.reference, status: row.status, amountMinor: row.amountMinor, currency: row.currency, expired },
      { status: 200, headers: { ...noStore, ...cors } },
    )
  },
}

export const givingSettingsEndpoint: Endpoint = {
  path: '/public/giving/settings',
  method: 'get',
  handler: async (req: PayloadRequest) => {
    const { cors, fail, allowed } = getContext(req)
    if (!allowed) return fail(403, 'Origin not allowed.')
    const rl = getStatusLimiter().check(getClientIp(req))
    if (!rl.allowed) return fail(429, 'Too many requests. Please wait and try again.', { 'Retry-After': String(rl.retryAfterSeconds) })
    const runtime = await runtimeOrNull(req)
    const body = runtime?.accepting ? publicGivingSettings(runtime.settings, runtime.provider) : { enabled: false as const }
    return Response.json(body, { status: 200, headers: { ...cors, 'Cache-Control': 'private, max-age=60' } })
  },
}

// ---------------------------------------------------------------- staff stats

/** GET /api/giving/stats: admin / editor-in-chief. Counts and totals per currency and status; no personal data. */
export const givingStatsEndpoint: Endpoint = {
  path: '/giving/stats',
  method: 'get',
  handler: async (req: PayloadRequest) => {
    const err = (status: number, message: string) => Response.json({ ok: false, errors: [{ message }] }, { status, headers: noStore })
    const user = req.user as UserLike | null
    if (!user) return err(401, 'Authentication required.')
    if (!isEditorInChief(user)) return err(403, 'Only an admin or the editor-in-chief can see giving totals.')
    const daysParam = Number.parseInt(req.searchParams.get('days') ?? '30', 10)
    const days = Number.isInteger(daysParam) && daysParam >= 1 && daysParam <= 366 ? daysParam : 30
    try {
      const db = (req.payload.db as unknown as { drizzle: { execute: (q: unknown) => Promise<{ rows?: unknown[] }> } }).drizzle
      const res = await db.execute(sql`select "currency"::text as currency, "status"::text as status, count(*)::int as count,
          coalesce(sum("amount_minor"), 0)::bigint as total
        from "donations" where "created_at" >= now() - make_interval(days => ${days})
        group by 1, 2 order by 1, 2`)
      const rows = (res.rows ?? []) as Array<{ currency: string; status: string; count: number; total: string | number }>
      const byCurrency: Record<string, { succeededMinor: number; counts: Record<string, number> }> = {}
      for (const r of rows) {
        const entry = (byCurrency[r.currency] ??= { succeededMinor: 0, counts: {} })
        entry.counts[r.status] = Number(r.count)
        if (r.status === 'succeeded') entry.succeededMinor = Number(r.total)
      }
      const runtime = await runtimeOrNull(req)
      return Response.json(
        { ok: true, days, byCurrency, accepting: Boolean(runtime?.accepting), mode: runtime?.provider?.mode ?? null, offReason: runtime?.accepting ? null : runtime?.reason ?? null },
        { headers: noStore },
      )
    } catch (e) {
      req.payload.logger.error(safeErrorFields(e), '[giving] stats failed')
      return err(500, 'Something went wrong. Please try again.')
    }
  },
}

const preflightGet = (path: string): Endpoint => ({
  path,
  method: 'options',
  handler: async (req: PayloadRequest) => {
    const origin = req.headers.get('origin')
    if (origin && !isOriginAllowed(origin)) return new Response(null, { status: 403 })
    return new Response(null, { status: 204, headers: { ...corsHeaders(origin, 'GET, OPTIONS'), Vary: 'Origin' } })
  },
})

export const givingEndpoints: Endpoint[] = [
  givingInitEndpoint,
  makePreflightEndpoint('/public/giving/init'),
  givingWebhookEndpoint,
  givingStatusEndpoint,
  preflightGet('/public/giving/status'),
  givingSettingsEndpoint,
  preflightGet('/public/giving/settings'),
  givingStatsEndpoint,
]
