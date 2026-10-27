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
  /** Make the next send hang until the returned function is called (a stuck SMTP server). */
  hangNext: () => () => void
  /** Put the real mailer back. */
  restore: () => void
}

export function installMailCapture(payload: Payload): MailCapture {
  const original = payload.sendEmail
  const sent: CapturedMail[] = []
  let failing = false
  let hang: Promise<void> | undefined
  payload.sendEmail = (async (message: CapturedMail) => {
    if (hang) {
      const wait = hang
      hang = undefined
      await wait
    }
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
    hangNext: () => {
      let release!: () => void
      hang = new Promise<void>((resolve) => {
        release = resolve
      })
      return release
    },
    restore: () => {
      payload.sendEmail = original
    },
  }
}

/**
 * Captures what the CMS logs through payload.logger (STUB logger) so tests can assert nothing personal is written.
 */
export type LogCapture = { lines: string[]; text: () => string; restore: () => void }

export function captureLogs(payload: Payload): LogCapture {
  const original = payload.logger
  const lines: string[] = []
  const record = (level: string) => (...args: unknown[]) => {
    lines.push(JSON.stringify({ level, args }, (_k, v) => (v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v)))
  }
  const stub: Record<string, unknown> = {}
  for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) stub[level] = record(level)
  stub.child = () => stub
  payload.logger = stub as never
  return {
    lines,
    text: () => lines.join('\n'),
    restore: () => {
      payload.logger = original
    },
  }
}

/** An error shaped like drizzle's DrizzleQueryError: the message carries the SQL and every parameter (personal data). */
export function drizzleLikeError(params: string[]): Error {
  const err = new Error(`Failed query: insert into "t" values ($1) params: ${params.join(',')}`)
  err.name = 'DrizzleQueryError'
  ;(err as { cause?: unknown }).cause = Object.assign(new Error(`duplicate key value (${params.join(',')})`), { code: '23505' })
  return err
}
