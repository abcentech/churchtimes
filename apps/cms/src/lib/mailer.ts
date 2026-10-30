import type { Payload } from 'payload'

import type { TrustedEmailHtml } from './emailTemplate'
import { stripHeaderValue } from './publicEndpoint'
import { isValidEmail } from './sanitize'

/**
 * Thin wrapper over Payload's configured mail adapter (nodemailer when SMTP_HOST is set, see
 * payload.config.ts). Every header-bound value is stripped of CR/LF here, so no caller can forget it.
 * Any SMTP relay works (Brevo and Resend free tiers both offer one: docs/w12/growth.md); no provider SDK.
 */

/** True when SMTP is configured (payload.config.ts only builds the SMTP adapter when SMTP_HOST is set). */
export const isMailConfigured = (env: NodeJS.ProcessEnv = process.env): boolean =>
  Boolean(env.SMTP_HOST?.trim())

export type OutgoingMail = {
  to: string[]
  subject: string
  /** Plain text only: nothing here is ever rendered as HTML. */
  text: string
  replyTo?: string
}

/** Throws when nothing valid remains to send to, so callers cannot silently mail an empty list. */
export async function sendPlainMail(payload: Payload, mail: OutgoingMail): Promise<void> {
  const to = mail.to.map((a) => stripHeaderValue(a, 254)).filter((a) => isValidEmail(a))
  if (to.length === 0) throw new Error('No valid recipient.')
  const replyTo = mail.replyTo ? stripHeaderValue(mail.replyTo, 254) : ''
  await payload.sendEmail({
    to: to.join(', '),
    subject: stripHeaderValue(mail.subject, 200),
    text: mail.text,
    ...(replyTo && isValidEmail(replyTo) ? { replyTo } : {}),
  } as never)
}

// ---- HTML + text mail (newsletter digest; available to receipts) ----

/** `YYYY-MM-DD` in Africa/Lagos (UTC+1 all year, no daylight saving). */
export const lagosDay = (now: Date): string => new Date(now.getTime() + 3600 * 1000).toISOString().slice(0, 10)

/**
 * Per Lagos calendar day, per process, cap on HTML mails. A second safety net under the digest's own
 * `dailySendCap`, so a bug that loops cannot burn through the relay's free quota. A slot is used by every attempt,
 * including one the relay rejects (the provider may still have counted it). Several CMS processes each keep their own
 * counter (documented in docs/w12/growth.md).
 */
export class DailyMailCap {
  private day = ''
  private used = 0
  constructor(private readonly limit: () => number) {}

  /** Takes one slot for `now`'s Lagos day; false when the cap is reached. */
  take(now: Date = new Date()): boolean {
    const key = lagosDay(now)
    if (key !== this.day) {
      this.day = key
      this.used = 0
    }
    if (this.used >= this.limit()) return false
    this.used += 1
    return true
  }

  remaining(now: Date = new Date()): number {
    return lagosDay(now) === this.day ? Math.max(0, this.limit() - this.used) : this.limit()
  }
}

/** MAIL_HTML_DAILY_CAP: default 300 (the order of the free relay tiers); 0 blocks every HTML mail. */
export const htmlDailyCapFromEnv = (env: NodeJS.ProcessEnv = process.env): number => {
  const raw = env.MAIL_HTML_DAILY_CAP?.trim() ?? ''
  if (!/^[0-9]{1,7}$/.test(raw)) return 300
  return Number(raw)
}

export const processHtmlMailCap = new DailyMailCap(() => htmlDailyCapFromEnv())

export class MailCapReachedError extends Error {
  constructor() {
    super('Daily HTML mail cap reached.')
    this.name = 'MailCapReachedError'
  }
}

export type OutgoingHtmlMail = {
  /** One recipient: list mail never carries several addresses in To (no address leaks between readers). */
  to: string
  subject: string
  text: string
  /** Only lib/emailTemplate.ts can produce this type: every interpolated value there is escaped. */
  html: TrustedEmailHtml
  replyTo?: string
  fromName?: string
  /**
   * RFC 2369 + RFC 8058: `List-Unsubscribe: <one-click url>[, <mailto:...>]` and
   * `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. https only (http only for loopback in development).
   */
  unsubscribeUrl?: string
  unsubscribeMailto?: string
  /** RFC 2919 List-Id, e.g. `daily-digest.churchtimesnigeria.net`. */
  listId?: string
}

const SAFE_URL = /^https:\/\/[^\s<>"]+$|^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/[^\s<>"]*$/
const SAFE_LIST_ID = /^[A-Za-z0-9.-]{1,200}$/

/** Extra headers for the mail. Exported for tests. Throws on an unsafe value instead of sending it. */
export function htmlMailHeaders(
  mail: Pick<OutgoingHtmlMail, 'unsubscribeUrl' | 'unsubscribeMailto' | 'listId'>,
): Record<string, string> {
  const headers: Record<string, string> = {}
  if (mail.unsubscribeUrl) {
    const url = stripHeaderValue(mail.unsubscribeUrl, 1000)
    if (!SAFE_URL.test(url)) throw new Error('Unsafe unsubscribe URL.')
    const parts = [`<${url}>`]
    if (mail.unsubscribeMailto) {
      const address = stripHeaderValue(mail.unsubscribeMailto, 254)
      if (!isValidEmail(address)) throw new Error('Unsafe unsubscribe mailto.')
      parts.push(`<mailto:${address}?subject=unsubscribe>`)
    }
    headers['List-Unsubscribe'] = parts.join(', ')
    // RFC 8058: valid only together with a List-Unsubscribe URI that accepts the one-click POST.
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click'
  }
  if (mail.listId) {
    const id = stripHeaderValue(mail.listId, 200)
    if (!SAFE_LIST_ID.test(id)) throw new Error('Unsafe List-Id.')
    headers['List-Id'] = `<${id}>`
  }
  return headers
}

/**
 * Multipart (text + HTML) mail to ONE recipient through the configured relay. Header values are stripped of CR/LF;
 * the HTML body must come from lib/emailTemplate.ts (type-enforced). Takes a slot from `cap` (default: the
 * per-process daily HTML cap) and throws MailCapReachedError, without sending, when none is left.
 */
export async function sendHtmlMail(
  payload: Payload,
  mail: OutgoingHtmlMail,
  { cap = processHtmlMailCap, now = new Date() }: { cap?: DailyMailCap; now?: Date } = {},
): Promise<void> {
  const to = stripHeaderValue(mail.to, 254)
  if (!isValidEmail(to)) throw new Error('No valid recipient.')
  const replyTo = mail.replyTo ? stripHeaderValue(mail.replyTo, 254) : ''
  const headers = htmlMailHeaders(mail)
  const fromName = mail.fromName ? stripHeaderValue(mail.fromName, 80).replace(/["<>\\]/g, '') : ''
  const fromAddress = stripHeaderValue(process.env.EMAIL_FROM_ADDRESS ?? '', 254)
  if (!cap.take(now)) throw new MailCapReachedError()
  await payload.sendEmail({
    to,
    subject: stripHeaderValue(mail.subject, 200),
    text: mail.text,
    html: mail.html,
    ...(fromName && isValidEmail(fromAddress) ? { from: { name: fromName, address: fromAddress } } : {}),
    ...(replyTo && isValidEmail(replyTo) ? { replyTo } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
  } as never)
}
