import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import { isHoneypotHit, type FieldError } from './publicEndpoint'
import { cleanText, isValidEmail } from './sanitize'
import { insecureLocalStaging, parseOrigin } from './securityConfig'

/** Pure helpers for the newsletter endpoints and staff tools (go-live contract C4). */

export const NEWSLETTER_SOURCES = ['footer', 'article', 'home', 'other'] as const
export type NewsletterSource = (typeof NEWSLETTER_SOURCES)[number]

export const SUBSCRIBER_STATUSES = ['pending', 'confirmed', 'unsubscribed', 'bounced', 'erased'] as const
export type SubscriberStatus = (typeof SUBSCRIBER_STATUSES)[number]

/** Version of the consent wording the public site shows next to the sign-up form. Bump when the wording changes. */
export const NEWSLETTER_CONSENT_VERSION = 'newsletter-consent-v1'
export const MAILCHIMP_CONSENT_VERSION = 'mailchimp-import-v1'
/** Wording of the one-off re-permission e-mail sent to imported rows that carry no proof of opt-in (lib/subscriberReconfirm.ts). */
export const RECONFIRM_CONSENT_VERSION = 'mailchimp-reconfirm-v1'
/** `importedFrom` of an imported row with no OPTIN_TIME: stored `pending`, never mailed or exported as confirmed until the person confirms. */
export const IMPORT_NO_OPTIN_MARKER = 'mailchimp-import-no-optin-time'

export const SUBSCRIBE_TURNSTILE_ACTION = 'newsletter-subscribe'
export const SUBSCRIBE_MAX_BODY_BYTES = 8 * 1024
export const TOKEN_MAX_BODY_BYTES = 2 * 1024

export const NEUTRAL_SUBSCRIBE_MESSAGE = 'If this address can be subscribed, we sent a confirmation email.'
export const INVALID_LINK_MESSAGE = 'This link is no longer valid.'

export const CONFIRM_TOKEN_TTL_MS = 72 * 3600 * 1000

export type ValidSubscribe = { email: string; name?: string; source: NewsletterSource }

export type SubscribeValidation =
  | { ok: true; honeypot: false; data: ValidSubscribe }
  | { ok: true; honeypot: true }
  | { ok: false; errors: FieldError[] }

/**
 * Whitelist copy of the sign-up body. `name` missing, null or an empty string all mean "no name", so a
 * form that cannot leave a field out never gets a 400 for an empty box. `consent` must be literally true.
 */
export function validateSubscribeInput(raw: unknown): SubscribeValidation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: [{ message: 'Request body must be a JSON object.' }] }
  }
  const input = raw as Record<string, unknown>
  if (isHoneypotHit(input)) return { ok: true, honeypot: true }

  const errors: FieldError[] = []

  const email = typeof input.email === 'string' ? input.email.trim() : ''
  if (!email) errors.push({ field: 'email', message: 'Email is required.' })
  else if (!isValidEmail(email)) errors.push({ field: 'email', message: 'Enter a valid email address.' })

  let name: string | undefined
  if (input.name !== undefined && input.name !== null) {
    if (typeof input.name !== 'string') errors.push({ field: 'name', message: 'Name must be text.' })
    else {
      const cleaned = cleanText(input.name)
      if (cleaned) {
        if (cleaned.length < 2) errors.push({ field: 'name', message: 'Name must be at least 2 characters.' })
        else if (cleaned.length > 120) errors.push({ field: 'name', message: 'Name must be at most 120 characters.' })
        else name = cleaned
      }
    }
  }

  if (input.consent !== true) errors.push({ field: 'consent', message: 'Please confirm that you want to receive the newsletter.' })

  const source = input.source
  if (typeof source !== 'string' || !(NEWSLETTER_SOURCES as readonly string[]).includes(source)) {
    errors.push({ field: 'source', message: `Source must be one of: ${NEWSLETTER_SOURCES.join(', ')}.` })
  }

  if (errors.length) return { ok: false, errors }
  return {
    ok: true,
    honeypot: false,
    data: { email: email.toLowerCase(), ...(name ? { name } : {}), source: source as NewsletterSource },
  }
}

// ---- Confirmation tokens (random, single use, only the SHA-256 is stored) ----

export const generateConfirmToken = (): string => randomBytes(32).toString('base64url')
export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex')
/** Cheap shape check before touching the database (random tokens are 43 base64url characters). */
export const isPlausibleToken = (token: unknown): token is string =>
  typeof token === 'string' && /^[A-Za-z0-9._-]{16,200}$/.test(token)

// ---- Signed unsubscribe tokens (stateless, no expiry, so every future email can carry a working link) ----

export const MIN_TOKEN_SECRET_LENGTH = 32

/**
 * NEWSLETTER_TOKEN_SECRET (>= 32 chars). Required in production (startup check). Outside production, and on the
 * loopback-only disposable staging stack, a key derived from PAYLOAD_SECRET is used so development works with
 * no extra setup. Returns undefined when no safe key exists: every unsubscribe token is then refused.
 */
export function resolveNewsletterTokenSecret(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = env.NEWSLETTER_TOKEN_SECRET?.trim()
  if (configured && configured.length >= MIN_TOKEN_SECRET_LENGTH) return configured
  if (env.NODE_ENV !== 'production' || insecureLocalStaging(env).enabled) {
    const base = env.PAYLOAD_SECRET ?? ''
    return createHash('sha256').update(`newsletter-token-dev-key:${base}`).digest('hex')
  }
  return undefined
}

const unsubscribeMac = (id: string, secret: string): Buffer =>
  createHmac('sha256', secret).update(`unsubscribe:v1:${id}`).digest()

/** `u1.<subscriber id>.<base64url HMAC-SHA256>` */
export function signUnsubscribeToken(id: number | string, secret: string): string {
  const sid = String(id)
  return `u1.${sid}.${unsubscribeMac(sid, secret).toString('base64url')}`
}

/** Returns the subscriber id when the token is authentic, otherwise null. Constant-time MAC comparison. */
export function verifyUnsubscribeToken(token: unknown, secret: string | undefined): string | null {
  if (!secret || typeof token !== 'string' || token.length > 200) return null
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== 'u1') return null
  const [, id, mac] = parts as [string, string, string]
  if (!/^[0-9]{1,18}$/.test(id) || !/^[A-Za-z0-9_-]{43}$/.test(mac)) return null
  const given = Buffer.from(mac, 'base64url')
  const expected = unsubscribeMac(id, secret)
  if (given.length !== expected.length) return null
  return timingSafeEqual(given, expected) ? id : null
}

// ---- Public site URL (links in e-mails point at the public site, never at the API) ----

/**
 * PUBLIC_SITE_URL: a bare origin. https only in production (http loopback on the disposable local staging stack
 * and http://localhost in development). Returns the normalised origin, or null when unset or unsafe.
 */
export function resolvePublicSiteUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.PUBLIC_SITE_URL?.trim().replace(/\/+$/, '')
  if (!raw) return null
  const url = parseOrigin(raw)
  if (!url) return null
  if (url.protocol === 'https:') return url.origin
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname.endsWith('.localhost')
  if (env.NODE_ENV !== 'production' && local) return url.origin
  if (insecureLocalStaging(env).enabled && local) return url.origin
  return null
}

export const buildConfirmUrl = (siteUrl: string, token: string): string =>
  `${siteUrl}/newsletter/confirm?token=${encodeURIComponent(token)}`

export const buildUnsubscribeUrl = (siteUrl: string, token: string): string =>
  `${siteUrl}/newsletter/unsubscribe?token=${encodeURIComponent(token)}`

// ---- Erasure ----

/**
 * Suppression record for an erased address: `erased:` plus HMAC-SHA256 (keyed with IP_HASH_SALT, domain-separated)
 * of the lower-cased address. Keeps "this person asked to be forgotten" without keeping the address.
 */
export function hashSubscriberEmail(email: string, env: NodeJS.ProcessEnv = process.env): string {
  const salt = env.IP_HASH_SALT ?? ''
  if (env.NODE_ENV !== 'test' && salt.length < 16) {
    throw new Error('IP_HASH_SALT must be set and at least 16 characters long.')
  }
  return `erased:${createHmac('sha256', salt).update(`subscriber-email:${email.trim().toLowerCase()}`).digest('hex')}`
}

// ---- CSV export ----

/**
 * One CSV cell. Cells starting with `=`, `+`, `-` or `@` (and tab or CR, which spreadsheets also treat as formula
 * starters) are prefixed with `'` so a spreadsheet shows text instead of running a formula. Then standard CSV quoting.
 */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export const EXPORT_COLUMNS = [
  'email',
  'name',
  'status',
  'source',
  'consentAt',
  'confirmedAt',
  'unsubscribedAt',
  'importedFrom',
] as const

export function toCsv(rows: Array<Record<string, unknown>>): string {
  const lines = [EXPORT_COLUMNS.join(',')]
  for (const row of rows) lines.push(EXPORT_COLUMNS.map((c) => csvCell(row[c])).join(','))
  return `${lines.join('\r\n')}\r\n`
}

// ---- Anti mail-bombing for confirmation e-mails ----

const nonNegativeInt = (value: string | undefined, fallback: number): number => {
  const n = Number.parseInt(value ?? '', 10)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

export type ConfirmMailState = {
  status: SubscriberStatus
  lastConfirmMailAt?: string | Date | null
  confirmMailsDayStart?: string | Date | null
  confirmMailsInDay?: number | null
}

export type ConfirmMailCounters = { lastConfirmMailAt: string; confirmMailsDayStart: string; confirmMailsInDay: number }

export type ConfirmMailDecision =
  | { send: false; reason: 'bounced' | 'cooldown' | 'daily-cap' }
  | { send: true; counters: ConfirmMailCounters }

const time = (v: string | Date | null | undefined): number | null => {
  if (!v) return null
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime()
  return Number.isNaN(t) ? null : t
}

/**
 * Should a confirmation e-mail go to this existing subscriber now? Besides the 3 per hour per address limiter:
 * - `bounced` addresses are never mailed automatically (staff can reset the status);
 * - resend cooldown NEWSLETTER_RESEND_COOLDOWN_SECONDS (default 600; 0 turns it off);
 * - daily cap NEWSLETTER_MAX_CONFIRM_MAILS_PER_DAY (default 5) within a rolling 24 h window that starts at the first mail.
 * In every refused case the caller still answers the same neutral 202.
 */
export function decideConfirmMail(
  row: ConfirmMailState,
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): ConfirmMailDecision {
  if (row.status === 'bounced') return { send: false, reason: 'bounced' }
  const t = now.getTime()
  const cooldownMs = nonNegativeInt(env.NEWSLETTER_RESEND_COOLDOWN_SECONDS, 600) * 1000
  const last = time(row.lastConfirmMailAt)
  if (cooldownMs > 0 && last !== null && t - last < cooldownMs) return { send: false, reason: 'cooldown' }

  const cap = Math.max(1, nonNegativeInt(env.NEWSLETTER_MAX_CONFIRM_MAILS_PER_DAY, 5))
  const dayStart = time(row.confirmMailsDayStart)
  const inWindow = dayStart !== null && t - dayStart < 24 * 3600 * 1000
  const used = inWindow ? Math.max(0, row.confirmMailsInDay ?? 0) : 0
  if (used >= cap) return { send: false, reason: 'daily-cap' }

  return {
    send: true,
    counters: {
      lastConfirmMailAt: now.toISOString(),
      confirmMailsDayStart: inWindow ? new Date(dayStart as number).toISOString() : now.toISOString(),
      confirmMailsInDay: used + 1,
    },
  }
}

/** Counters stamped on a brand-new row whose first confirmation mail is being queued. */
export const firstConfirmMailCounters = (now: Date = new Date()): ConfirmMailCounters => ({
  lastConfirmMailAt: now.toISOString(),
  confirmMailsDayStart: now.toISOString(),
  confirmMailsInDay: 1,
})
