import type { Payload } from 'payload'

import { stripHeaderValue } from './publicEndpoint'
import { isValidEmail } from './sanitize'

/**
 * Thin wrapper over Payload's configured mail adapter (nodemailer when SMTP_HOST is set, see
 * payload.config.ts). Every header-bound value is stripped of CR/LF here, so no caller can forget it.
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
