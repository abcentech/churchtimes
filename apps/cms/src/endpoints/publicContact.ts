import type { Endpoint, Payload, PayloadRequest } from 'payload'

import { writeAuditLog } from '../lib/audit'
import {
  buildContactNotification,
  computeContactHash,
  CONTACT_MAX_BODY_BYTES,
  CONTACT_TURNSTILE_ACTION,
  generateContactReference,
  parseRecipientList,
  validateContactInput,
} from '../lib/contactMessage'
import { isMailConfigured, sendPlainMail } from '../lib/mailer'
import {
  checkTurnstileForAction,
  guardPublicRequest,
  makePreflightEndpoint,
  positiveInt,
  readJsonBody,
} from '../lib/publicEndpoint'
import { createRateLimiter, hashIp } from '../lib/rateLimit'
import { cleanText } from '../lib/sanitize'
import { safeErrorFields } from '../lib/safeLog'

/**
 * POST /api/public/contact (go-live contract C5). Processing order (each step can end the request):
 * origin, content type, size, per-IP rate limit, body read and JSON parse, honeypot, validation,
 * Turnstile, duplicate, per-address limit, write, notification. The message is stored BEFORE any mail is
 * attempted, and a mail failure never changes the answer.
 */

let ipLimiter: ReturnType<typeof createRateLimiter> | undefined
let addressLimiter: ReturnType<typeof createRateLimiter> | undefined

const getIpLimiter = () =>
  (ipLimiter ??= createRateLimiter({
    limit: positiveInt(process.env.CONTACT_RATE_LIMIT, 5),
    windowMs: positiveInt(process.env.CONTACT_RATE_WINDOW_SECONDS, 900) * 1000,
  }))

/** Per address: 3 per hour (counted only for verified, non-duplicate messages). */
const getAddressLimiter = () => (addressLimiter ??= createRateLimiter({ limit: 3, windowMs: 3600 * 1000 }))

/** Test helper: drop all counters and re-read limits from the environment. */
export function resetContactLimiters(): void {
  ipLimiter = undefined
  addressLimiter = undefined
}

const DUPLICATE_WINDOW_MS = 72 * 3600 * 1000

export const publicContactEndpoint: Endpoint = {
  path: '/public/contact',
  method: 'post',
  handler: async (req: PayloadRequest) => {
    const guard = guardPublicRequest(req, { maxBytes: CONTACT_MAX_BODY_BYTES })
    if ('response' in guard) return guard.response
    const { ctx } = guard

    const limited = ctx.limit(getIpLimiter().check(ctx.ip), 'Too many messages. Try again later.')
    if (limited) return limited

    const body = await readJsonBody(req, ctx, CONTACT_MAX_BODY_BYTES)
    if ('response' in body) return body.response

    const result = validateContactInput(body.value)
    if (!result.ok) return ctx.invalid(result.errors)

    const reference = generateContactReference()
    const okBody = { ok: true, reference, message: 'Received. We will reply by email.' }
    if (result.honeypot) return ctx.ok(okBody, 201)

    const rejected = await checkTurnstileForAction(
      req,
      ctx,
      body.value as Record<string, unknown>,
      CONTACT_TURNSTILE_ACTION,
    )
    if (rejected) return rejected

    const contentHash = computeContactHash(result.data)
    const since = new Date(Date.now() - DUPLICATE_WINDOW_MS).toISOString()
    try {
      const dup = await req.payload.find({
        collection: 'contact-messages',
        where: { and: [{ contentHash: { equals: contentHash } }, { createdAt: { greater_than: since } }] },
        limit: 1,
        depth: 0,
        pagination: false,
        select: { contentHash: true },
        overrideAccess: true,
      })
      if (dup.docs.length > 0) return ctx.fail(409, 'We already received this message.')
    } catch (err) {
      req.payload.logger.error(safeErrorFields(err), 'contact duplicate check failed')
      return ctx.fail(500, 'Could not save your message. Please try again.')
    }

    const addressLimited = ctx.limit(
      getAddressLimiter().check(result.data.email),
      'Too many messages from this email address. Try again later.',
    )
    if (addressLimited) return addressLimited

    let ipHash: string
    try {
      ipHash = hashIp(ctx.ip)
    } catch (err) {
      req.payload.logger.error(safeErrorFields(err), 'IP_HASH_SALT misconfigured')
      return ctx.fail(500, 'Messages are temporarily unavailable.')
    }
    const userAgent = cleanText(req.headers.get('user-agent'), { max: 300 })

    let docId: number | string
    try {
      const doc = await req.payload.create({
        collection: 'contact-messages',
        data: { ...result.data, status: 'new', reference, ipHash, userAgent, contentHash } as never,
        overrideAccess: true,
      })
      docId = (doc as { id: number | string }).id
      await writeAuditLog(req, {
        action: 'contact.create',
        collection: 'contact-messages',
        docId,
        actor: null,
        toStatus: 'new',
        summary: `Public contact message ${reference}`,
      })
    } catch (err) {
      req.payload.logger.error(safeErrorFields(err), 'public contact message failed')
      return ctx.fail(500, 'Could not save your message. Please try again.')
    }

    // The message is safe in the database. The staff notification is queued AFTER the answer (never awaited): a slow or
    // hanging SMTP server must not make the reader wait, time out and retry into a 409. It never leaks and never fails the request.
    queueStaffNotification(req.payload, docId, { ...result.data, reference })

    return ctx.ok(okBody, 201)
  },
}

// Notification jobs run after the response. The set lets tests wait for them to settle.
const pendingMail = new Set<Promise<unknown>>()
export async function waitForPendingContactMail(): Promise<void> {
  await Promise.allSettled([...pendingMail])
}

function queueStaffNotification(
  payload: Payload,
  docId: number | string,
  msg: Parameters<typeof buildContactNotification>[0],
): void {
  const job = (async () => {
    const notifyStatus = await notifyStaff(payload, msg)
    try {
      await payload.update({
        collection: 'contact-messages',
        id: docId,
        data: { notifyStatus } as never,
        overrideAccess: true,
      })
    } catch (err) {
      payload.logger.error({ reference: msg.reference, ...safeErrorFields(err) }, 'could not record contact notification status')
    }
  })()
    .catch((err: unknown) => {
      payload.logger.error({ reference: msg.reference, ...safeErrorFields(err) }, 'contact notification job failed')
    })
    .finally(() => pendingMail.delete(job))
  pendingMail.add(job)
}

async function notifyStaff(
  payload: Payload,
  msg: Parameters<typeof buildContactNotification>[0],
): Promise<'sent' | 'failed' | 'not-configured'> {
  const { valid } = parseRecipientList(process.env.CONTACT_NOTIFY_TO)
  if (valid.length === 0 || !isMailConfigured()) {
    payload.logger.warn(
      { reference: msg.reference },
      'contact message stored but no notification sent: CONTACT_NOTIFY_TO or SMTP is not configured',
    )
    return 'not-configured'
  }
  try {
    const mail = buildContactNotification(msg)
    await sendPlainMail(payload, { to: valid, subject: mail.subject, text: mail.text, replyTo: mail.replyTo })
    return 'sent'
  } catch (err) {
    // Log the failure for operators (reference, error class and code only: no recipient, no message text) and carry on.
    payload.logger.error(
      { reference: msg.reference, ...safeErrorFields(err) },
      'contact notification email failed; the message is stored',
    )
    return 'failed'
  }
}

export const publicContactPreflightEndpoint = makePreflightEndpoint('/public/contact')
