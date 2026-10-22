import type { Endpoint, Payload, PayloadRequest } from 'payload'

import { writeAuditLog } from '../lib/audit'
import { claimSubscriberConfirmation } from '../lib/dbTransaction'
import { isMailConfigured, sendPlainMail } from '../lib/mailer'
import {
  buildConfirmUrl,
  CONFIRM_TOKEN_TTL_MS,
  decideConfirmMail,
  firstConfirmMailCounters,
  generateConfirmToken,
  hashToken,
  IMPORT_NO_OPTIN_MARKER,
  INVALID_LINK_MESSAGE,
  isPlausibleToken,
  NEUTRAL_SUBSCRIBE_MESSAGE,
  NEWSLETTER_CONSENT_VERSION,
  resolveNewsletterTokenSecret,
  resolvePublicSiteUrl,
  SUBSCRIBE_MAX_BODY_BYTES,
  SUBSCRIBE_TURNSTILE_ACTION,
  TOKEN_MAX_BODY_BYTES,
  validateSubscribeInput,
  verifyUnsubscribeToken,
  type ValidSubscribe,
} from '../lib/newsletter'
import {
  checkTurnstileForAction,
  guardPublicRequest,
  makeMethodNotAllowedEndpoints,
  makePreflightEndpoint,
  positiveInt,
  readJsonBody,
} from '../lib/publicEndpoint'
import { createRateLimiter, hashIp } from '../lib/rateLimit'
import { safeErrorFields } from '../lib/safeLog'

/**
 * Newsletter endpoints (go-live contract C4). Double opt-in: subscribe stores a `pending` row with the SHA-256 of a
 * random single-use token and e-mails a link to the PUBLIC SITE; the public page POSTs the token to /confirm.
 * Confirm and unsubscribe are POST only so mail scanners that pre-fetch links cannot change anyone's state.
 */

type SubscriberDoc = {
  id: number
  email: string
  status: 'pending' | 'confirmed' | 'unsubscribed' | 'bounced' | 'erased'
  importedFrom?: string | null
  lastConfirmMailAt?: string | null
  confirmMailsDayStart?: string | null
  confirmMailsInDay?: number | null
}

let ipLimiter: ReturnType<typeof createRateLimiter> | undefined
let addressLimiter: ReturnType<typeof createRateLimiter> | undefined
let tokenLimiter: ReturnType<typeof createRateLimiter> | undefined

const windowMs = () => positiveInt(process.env.NEWSLETTER_RATE_WINDOW_SECONDS, 900) * 1000
const getIpLimiter = () =>
  (ipLimiter ??= createRateLimiter({ limit: positiveInt(process.env.NEWSLETTER_RATE_LIMIT, 5), windowMs: windowMs() }))
/** Per address: 3 per hour, counted for every verified attempt whatever the address's state (no enumeration). */
const getAddressLimiter = () => (addressLimiter ??= createRateLimiter({ limit: 3, windowMs: 3600 * 1000 }))
/** confirm and unsubscribe share one per-IP bucket; the tokens themselves are unguessable. */
const getTokenLimiter = () =>
  (tokenLimiter ??= createRateLimiter({
    limit: positiveInt(process.env.NEWSLETTER_TOKEN_RATE_LIMIT, 20),
    windowMs: windowMs(),
  }))

/** Test helper: drop all counters and re-read limits from the environment. */
export function resetNewsletterLimiters(): void {
  ipLimiter = undefined
  addressLimiter = undefined
  tokenLimiter = undefined
}

// Confirmation e-mails are sent after the answer is built (not awaited), so the response time does not reveal
// whether an address already exists. The set lets tests wait for them to settle.
const pendingMail = new Set<Promise<unknown>>()
export async function waitForPendingNewsletterMail(): Promise<void> {
  await Promise.allSettled([...pendingMail])
}

const internal = { subscriberSystemWrite: true }

const neutral = { ok: true, message: NEUTRAL_SUBSCRIBE_MESSAGE }

const findByEmail = async (payload: Payload, email: string): Promise<SubscriberDoc | undefined> =>
  (
    await payload.find({
      collection: 'subscribers',
      where: { email: { equals: email } },
      limit: 1,
      depth: 0,
      overrideAccess: true,
    })
  ).docs[0] as unknown as SubscriberDoc | undefined

function queueConfirmationMail(payload: Payload, email: string, token: string): void {
  const siteUrl = resolvePublicSiteUrl()
  if (!siteUrl) return
  const url = buildConfirmUrl(siteUrl, token)
  if (!isMailConfigured()) {
    // Reachable only outside production (production answers 503 before storing anything).
    payload.logger.info({ confirmUrl: url }, 'DEV ONLY: SMTP is not configured, so the confirmation link is logged here')
    return
  }
  const job = sendPlainMail(payload, {
    to: [email],
    subject: 'Confirm your Church Times Nigeria newsletter subscription',
    text: [
      'Someone, hopefully you, asked to receive the Church Times Nigeria newsletter at this address.',
      '',
      'To confirm, open this link (it works for 72 hours and only once):',
      url,
      '',
      'If you did not ask for this, ignore this email and nothing will be sent to you.',
    ].join('\n'),
  })
    .catch((err: unknown) => {
      // Never leaks to the client: the answer is already the neutral one. Log the failure only (no address, no link).
      payload.logger.error(safeErrorFields(err), 'newsletter confirmation email failed')
    })
    .finally(() => pendingMail.delete(job))
  pendingMail.add(job)
}

async function subscribe(req: PayloadRequest, data: ValidSubscribe, ipHash: string): Promise<void> {
  const payload = req.payload
  const token = generateConfirmToken()
  const tokenFields = {
    confirmTokenHash: hashToken(token),
    confirmTokenExpiresAt: new Date(Date.now() + CONFIRM_TOKEN_TTL_MS).toISOString(),
  }

  const existing = await findByEmail(payload, data.email)
  if (!existing) {
    const created = (await payload.create({
      collection: 'subscribers',
      data: {
        email: data.email,
        ...(data.name ? { name: data.name } : {}),
        status: 'pending',
        source: data.source,
        consentTextVersion: NEWSLETTER_CONSENT_VERSION,
        consentAt: new Date().toISOString(),
        ipHash,
        importedFrom: 'web',
        ...tokenFields,
        ...firstConfirmMailCounters(),
      } as never,
      overrideAccess: true,
      context: internal,
    })) as unknown as SubscriberDoc
    await writeAuditLog(req, {
      action: 'subscriber.subscribe',
      collection: 'subscribers',
      docId: created.id,
      actor: null,
      toStatus: 'pending',
      summary: `Newsletter sign-up ${created.id} (${data.source})`,
    })
    queueConfirmationMail(payload, data.email, token)
    return
  }

  if (existing.status === 'confirmed') return // already subscribed: same answer, no mail, nothing changes

  if (existing.status === 'erased') return // cannot happen for a real address (the row holds a hash); defensive

  // pending: a fresh link replaces the old one. unsubscribed: NOT re-added; the status stays as it is until the person opens
  // a fresh confirmation link (the only way back). bounced: never mailed automatically. Every case is also held back by the
  // resend cooldown and the daily cap, and the answer is the same neutral 202 whether or not a mail goes out.
  const decision = decideConfirmMail(existing)
  if (!decision.send) return
  await payload.update({
    collection: 'subscribers',
    id: existing.id,
    data: {
      ...tokenFields,
      ...decision.counters,
      // An imported row with no proof of opt-in is re-permissioned by this form: the wording the person just ticked is the consent on record.
      ...(existing.importedFrom === IMPORT_NO_OPTIN_MARKER ? { consentTextVersion: NEWSLETTER_CONSENT_VERSION } : {}),
    } as never,
    overrideAccess: true,
    context: internal,
  })
  queueConfirmationMail(payload, data.email, token)
}

export const publicNewsletterSubscribeEndpoint: Endpoint = {
  path: '/public/newsletter/subscribe',
  method: 'post',
  handler: async (req: PayloadRequest) => {
    const guard = guardPublicRequest(req, { maxBytes: SUBSCRIBE_MAX_BODY_BYTES })
    if ('response' in guard) return guard.response
    const { ctx } = guard

    // In production a sign-up that cannot be mailed must not be stored: a reader would wait for an e-mail that never comes.
    if (process.env.NODE_ENV === 'production' && (!isMailConfigured() || !resolvePublicSiteUrl())) {
      return ctx.fail(503, 'Sign-up is unavailable.')
    }

    const limited = ctx.limit(getIpLimiter().check(ctx.ip), 'Too many attempts. Try again later.')
    if (limited) return limited

    const body = await readJsonBody(req, ctx, SUBSCRIBE_MAX_BODY_BYTES)
    if ('response' in body) return body.response

    const result = validateSubscribeInput(body.value)
    if (!result.ok) return ctx.invalid(result.errors)
    if (result.honeypot) return ctx.ok(neutral, 202)

    const rejected = await checkTurnstileForAction(
      req,
      ctx,
      body.value as Record<string, unknown>,
      SUBSCRIBE_TURNSTILE_ACTION,
    )
    if (rejected) return rejected

    const addressLimited = ctx.limit(
      getAddressLimiter().check(result.data.email),
      'Too many attempts for this email address. Try again later.',
    )
    if (addressLimited) return addressLimited

    let ipHash: string
    try {
      ipHash = hashIp(ctx.ip)
    } catch (err) {
      req.payload.logger.error(safeErrorFields(err), 'IP_HASH_SALT misconfigured')
      return ctx.fail(500, 'Sign-up is temporarily unavailable.')
    }

    try {
      await subscribe(req, result.data, ipHash)
    } catch (err) {
      // A concurrent sign-up for the same address loses the unique-index race: it is not an error for the reader.
      req.payload.logger.error(safeErrorFields(err), 'newsletter sign-up could not be stored')
    }
    return ctx.ok(neutral, 202)
  },
}

/** Reads `{ token }`. Returns the plausible token string or the response that ends the request. */
async function readToken(req: PayloadRequest, ctx: Parameters<typeof readJsonBody>[1]): Promise<{ token: string } | { response: Response }> {
  const limited = ctx.limit(getTokenLimiter().check(ctx.ip), 'Too many attempts. Try again later.')
  if (limited) return { response: limited }
  const body = await readJsonBody(req, ctx, TOKEN_MAX_BODY_BYTES)
  if ('response' in body) return body
  const raw = body.value
  const token = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>).token : undefined
  if (!isPlausibleToken(token)) return { response: ctx.fail(400, INVALID_LINK_MESSAGE) }
  return { token }
}

export const publicNewsletterConfirmEndpoint: Endpoint = {
  path: '/public/newsletter/confirm',
  method: 'post',
  handler: async (req: PayloadRequest) => {
    const guard = guardPublicRequest(req, { maxBytes: TOKEN_MAX_BODY_BYTES })
    if ('response' in guard) return guard.response
    const { ctx } = guard
    const read = await readToken(req, ctx)
    if ('response' in read) return read.response

    const found = await req.payload
      .find({
      collection: 'subscribers',
      where: {
        and: [
          { confirmTokenHash: { equals: hashToken(read.token) } },
          { confirmTokenExpiresAt: { greater_than: new Date().toISOString() } },
          { status: { in: ['pending', 'unsubscribed', 'bounced'] } },
        ],
      },
      limit: 1,
      depth: 0,
      overrideAccess: true,
      })
      .catch((err: unknown) => {
        req.payload.logger.error(safeErrorFields(err), 'newsletter confirm lookup failed')
        return null
      })
    if (!found) return ctx.fail(500, 'Could not confirm. Please try again.')
    const doc = found.docs[0] as unknown as SubscriberDoc | undefined
    if (!doc) return ctx.fail(400, INVALID_LINK_MESSAGE)

    try {
      // ONE conditional UPDATE (status, token hash and expiry in the WHERE, token cleared in the same statement): of two
      // simultaneous confirms exactly one wins; the other matches no row and gets the same "no longer valid" answer.
      const won = await claimSubscriberConfirmation(req, {
        id: doc.id,
        tokenHash: hashToken(read.token),
        fromStatus: doc.status,
        consentTextVersion: NEWSLETTER_CONSENT_VERSION,
      })
      if (!won) return ctx.fail(400, INVALID_LINK_MESSAGE)
      await writeAuditLog(req, {
        action: 'subscriber.confirm',
        collection: 'subscribers',
        docId: doc.id,
        actor: null,
        fromStatus: doc.status,
        toStatus: 'confirmed',
        summary: `Subscriber ${doc.id} confirmed`,
      })
    } catch (err) {
      req.payload.logger.error(safeErrorFields(err), 'newsletter confirm failed')
      return ctx.fail(500, 'Could not confirm. Please try again.')
    }
    return ctx.ok({ ok: true }, 200)
  },
}

export const publicNewsletterUnsubscribeEndpoint: Endpoint = {
  path: '/public/newsletter/unsubscribe',
  method: 'post',
  handler: async (req: PayloadRequest) => {
    const guard = guardPublicRequest(req, { maxBytes: TOKEN_MAX_BODY_BYTES })
    if ('response' in guard) return guard.response
    const { ctx } = guard
    const read = await readToken(req, ctx)
    if ('response' in read) return read.response

    const id = verifyUnsubscribeToken(read.token, resolveNewsletterTokenSecret())
    if (!id) return ctx.fail(400, INVALID_LINK_MESSAGE)

    const doc = (await req.payload
      .findByID({ collection: 'subscribers', id, depth: 0, overrideAccess: true })
      .catch(() => null)) as unknown as SubscriberDoc | null
    if (!doc) return ctx.fail(400, INVALID_LINK_MESSAGE)

    // Idempotent: already unsubscribed (or erased, which stays erased) is a success and changes nothing.
    if (doc.status !== 'unsubscribed' && doc.status !== 'erased') {
      try {
        await req.payload.update({
          collection: 'subscribers',
          id: doc.id,
          data: {
            status: 'unsubscribed',
            unsubscribedAt: new Date().toISOString(),
            confirmTokenHash: null,
            confirmTokenExpiresAt: null,
          } as never,
          overrideAccess: true,
          context: internal,
        })
        await writeAuditLog(req, {
          action: 'subscriber.unsubscribe',
          collection: 'subscribers',
          docId: doc.id,
          actor: null,
          fromStatus: doc.status,
          toStatus: 'unsubscribed',
          summary: `Subscriber ${doc.id} unsubscribed`,
        })
      } catch (err) {
        req.payload.logger.error(safeErrorFields(err), 'newsletter unsubscribe failed')
        return ctx.fail(500, 'Could not unsubscribe. Please try again.')
      }
    }
    return ctx.ok({ ok: true }, 200)
  },
}

export const newsletterEndpoints: Endpoint[] = [
  publicNewsletterSubscribeEndpoint,
  publicNewsletterConfirmEndpoint,
  publicNewsletterUnsubscribeEndpoint,
  makePreflightEndpoint('/public/newsletter/subscribe'),
  makePreflightEndpoint('/public/newsletter/confirm'),
  makePreflightEndpoint('/public/newsletter/unsubscribe'),
  ...makeMethodNotAllowedEndpoints('/public/newsletter/confirm'),
  ...makeMethodNotAllowedEndpoints('/public/newsletter/unsubscribe'),
  ...makeMethodNotAllowedEndpoints('/public/newsletter/subscribe'),
]
