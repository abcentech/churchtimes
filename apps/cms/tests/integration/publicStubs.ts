import type { Payload } from 'payload'

import { setTurnstileFetchForTests } from '../../src/lib/turnstile'

/**
 * STUBS, NOT END-TO-END. Two seams replace only the outside world for the contact and newsletter tests:
 *
 * 1. Turnstile Siteverify transport: `token` of the form `ok:<action>` answers success with that widget
 *    action (the real verification code still runs against the canned JSON); `ok` answers success with no
 *    action; anything else is rejected.
 * 2. The mail transport: `payload.sendEmail` is replaced by a capturing function, so no SMTP server is
 *    involved. What is asserted is what the CMS HANDS to the mailer, not delivery.
 */

export const tsToken = (action?: string): string => (action ? `ok:${action}` : 'ok')
export const TS_BAD = 'test-token-rejected'

export const siteverifyCalls: { response: string }[] = []

export function installActionTurnstileStub(): void {
  setTurnstileFetchForTests(async (_url, init) => {
    const form = new URLSearchParams(String(init.body))
    const response = form.get('response') ?? ''
    siteverifyCalls.push({ response })
    if (response === 'ok') return Response.json({ success: true, hostname: 'allowed.test' })
    if (response.startsWith('ok:')) {
      return Response.json({ success: true, hostname: 'allowed.test', action: response.slice(3) })
    }
    return Response.json({ success: false, 'error-codes': ['invalid-input-response'] })
  })
}

export function removeActionTurnstileStub(): void {
  setTurnstileFetchForTests(undefined)
}

export type CapturedMail = {
  to: string
  subject: string
  text: string
  replyTo?: string
  [key: string]: unknown
}

export type MailCapture = {
  /** STUB: every message the CMS handed to the mailer. */
  sent: CapturedMail[]
  /** Make the next send throw an error whose message contains the recipient (it must never reach a client). */
  failNext: () => void
  /** Put the real mailer back. */
  restore: () => void
}

export function installMailCapture(payload: Payload): MailCapture {
  const original = payload.sendEmail
  const sent: CapturedMail[] = []
  let failing = false
  payload.sendEmail = (async (message: CapturedMail) => {
    if (failing) {
      failing = false
      throw new Error(`stub SMTP failure while sending to ${String(message.to)}`)
    }
    sent.push(message)
    return { stub: true }
  }) as never
  return {
    sent,
    failNext: () => {
      failing = true
    },
    restore: () => {
      payload.sendEmail = original
    },
  }
}
