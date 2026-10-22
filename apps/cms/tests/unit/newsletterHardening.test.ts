import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { decideConfirmMail, firstConfirmMailCounters } from '../../src/lib/newsletter'
import { isPathInside } from '../../src/lib/pathGuard'
import { cliFailureMessage, CliUsageError, safeErrorFields, safeErrorSummary } from '../../src/lib/safeLog'
import { planMailchimpImport } from '../../src/lib/subscriberImport'
import { turnstileActionWarnings, validateProductionEnv } from '../../src/lib/securityConfig'

describe('decideConfirmMail (resend cooldown, daily cap, bounced)', () => {
  const NOW = new Date('2026-10-16T12:00:00Z')
  const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()
  const env = (o: Record<string, string> = {}) => o as NodeJS.ProcessEnv

  it('never mails a bounced address', () => {
    expect(decideConfirmMail({ status: 'bounced' }, NOW, env({ NEWSLETTER_RESEND_COOLDOWN_SECONDS: '0' }))).toEqual({
      send: false,
      reason: 'bounced',
    })
  })

  it('holds a resend inside the cooldown (default 600 s) and allows it after', () => {
    expect(decideConfirmMail({ status: 'pending', lastConfirmMailAt: ago(599_000) }, NOW, env())).toEqual({ send: false, reason: 'cooldown' })
    expect(decideConfirmMail({ status: 'pending', lastConfirmMailAt: ago(601_000) }, NOW, env()).send).toBe(true)
    expect(
      decideConfirmMail({ status: 'unsubscribed', lastConfirmMailAt: ago(60_000) }, NOW, env({ NEWSLETTER_RESEND_COOLDOWN_SECONDS: '30' })).send,
    ).toBe(true)
    expect(
      decideConfirmMail({ status: 'pending', lastConfirmMailAt: ago(1000) }, NOW, env({ NEWSLETTER_RESEND_COOLDOWN_SECONDS: '0' })).send,
    ).toBe(true)
    expect(decideConfirmMail({ status: 'pending' }, NOW, env()).send).toBe(true) // never mailed before
  })

  it('caps mails per rolling 24 h window (default 5) and opens a new window afterwards', () => {
    const off = env({ NEWSLETTER_RESEND_COOLDOWN_SECONDS: '0' })
    const inWindow = { confirmMailsDayStart: ago(3600_000) }
    expect(decideConfirmMail({ status: 'pending', ...inWindow, confirmMailsInDay: 4 }, NOW, off)).toMatchObject({
      send: true,
      counters: { confirmMailsInDay: 5, confirmMailsDayStart: inWindow.confirmMailsDayStart },
    })
    expect(decideConfirmMail({ status: 'pending', ...inWindow, confirmMailsInDay: 5 }, NOW, off)).toEqual({ send: false, reason: 'daily-cap' })
    expect(
      decideConfirmMail({ status: 'pending', ...inWindow, confirmMailsInDay: 2 }, NOW, env({ ...off, NEWSLETTER_MAX_CONFIRM_MAILS_PER_DAY: '2' })),
    ).toEqual({ send: false, reason: 'daily-cap' })
    const rolled = decideConfirmMail({ status: 'pending', confirmMailsDayStart: ago(25 * 3600_000), confirmMailsInDay: 99 }, NOW, off)
    expect(rolled).toMatchObject({ send: true, counters: { confirmMailsInDay: 1, confirmMailsDayStart: NOW.toISOString() } })
  })

  it('first mail counters', () => {
    expect(firstConfirmMailCounters(NOW)).toEqual({
      lastConfirmMailAt: NOW.toISOString(),
      confirmMailsDayStart: NOW.toISOString(),
      confirmMailsInDay: 1,
    })
  })
})

describe('safeLog: nothing personal survives', () => {
  const drizzleLike = () => {
    const e = new Error('Failed query: insert into t values ($1) params: secret.pii@example.test,Zed Personname')
    e.name = 'DrizzleQueryError'
    ;(e as { cause?: unknown }).cause = Object.assign(new Error('dup (secret.pii@example.test)'), { code: '23505' })
    return e
  }

  it('keeps only the class name and a short code', () => {
    const fields = safeErrorFields(drizzleLike())
    expect(fields).toEqual({ errName: 'DrizzleQueryError', errCode: '23505' })
    expect(JSON.stringify(fields)).not.toMatch(/secret|Zed|Failed query/)
    expect(safeErrorSummary(drizzleLike())).toBe('DrizzleQueryError (23505)')
    expect(safeErrorFields('a string with secret.pii@example.test')).toEqual({ errName: 'Error' })
    expect(safeErrorFields(Object.assign(new Error('x'), { code: 'has spaces and secret@example.test' }))).toEqual({ errName: 'Error' })
  })

  it('the CLI prints its own fixed messages but only class and code for anything else', () => {
    expect(cliFailureMessage(new CliUsageError('Usage: fixed text'))).toBe('Usage: fixed text')
    const printed = cliFailureMessage(drizzleLike())
    expect(printed).toContain('DrizzleQueryError (23505)')
    expect(printed).not.toMatch(/secret|Zed|Failed query|@/)
  })
})

describe('isPathInside (the import file must stay outside the repository)', () => {
  it('detects the directory itself and its descendants, not siblings, parents or ".." escapes', () => {
    expect(isPathInside('/repo', '/repo', path.posix)).toBe(true)
    expect(isPathInside('/repo/apps/x.csv', '/repo', path.posix)).toBe(true)
    expect(isPathInside('/repo-other/x.csv', '/repo', path.posix)).toBe(false)
    expect(isPathInside('/elsewhere/x.csv', '/repo', path.posix)).toBe(false)
    expect(isPathInside('/', '/repo', path.posix)).toBe(false)
    expect(isPathInside('/repo/../etc/x.csv', '/repo', path.posix)).toBe(false)
    expect(isPathInside('/repo/..hidden/x.csv', '/repo', path.posix)).toBe(true)
  })

  it('is case-insensitive on Windows paths and treats another drive as outside', () => {
    expect(isPathInside('c:\\users\\hp\\REPO\\export.csv', 'C:\\Users\\HP\\repo', path.win32)).toBe(true)
    expect(isPathInside('C:\\Users\\HP\\Repo2\\export.csv', 'C:\\Users\\HP\\repo', path.win32)).toBe(false)
    expect(isPathInside('D:\\repo\\export.csv', 'C:\\repo', path.win32)).toBe(false)
  })
})

describe('importer refuses unsubscribed and cleaned exports', () => {
  it('UNSUB_TIME or CLEAN_TIME columns are refused, with or without --assume-subscribed', () => {
    for (const col of ['UNSUB_TIME', 'CLEAN_TIME', 'Unsub Time']) {
      const csv = `Email Address,Status,${col}\na@example.test,subscribed,2024-01-01 00:00:00`
      for (const assumeSubscribed of [false, true]) {
        const r = planMailchimpImport(csv, { assumeSubscribed })
        expect(r.counts.refused, col).toBe('unsubscribed-or-cleaned-export')
        expect(r.candidates).toEqual([])
      }
    }
  })
})

describe('turnstileActionWarnings (contact-message and newsletter-subscribe must be on a configured allowlist)', () => {
  const env = (v?: string) => ({ TURNSTILE_EXPECTED_ACTION: v }) as unknown as NodeJS.ProcessEnv

  it('is silent when the list is unset or complete', () => {
    expect(turnstileActionWarnings(env())).toEqual([])
    expect(turnstileActionWarnings(env('  '))).toEqual([])
    expect(turnstileActionWarnings(env('submit-story,contact-message,newsletter-subscribe'))).toEqual([])
    expect(turnstileActionWarnings(env(' contact-message , newsletter-subscribe '))).toEqual([])
  })

  it('warns once, in one line, naming what is missing', () => {
    const both = turnstileActionWarnings(env('submit-story'))
    expect(both).toHaveLength(1)
    expect(both[0]).toMatch(/contact-message and newsletter-subscribe/)
    expect(both[0]).not.toMatch(/\n/)
    expect(turnstileActionWarnings(env('submit-story,contact-message'))[0]).toMatch(/newsletter-subscribe/)
    expect(turnstileActionWarnings(env('submit-story,newsletter-subscribe'))[0]).toMatch(/contact-message/)
    // case-sensitive exact match, like the CMS check itself
    expect(turnstileActionWarnings(env('Contact-Message,newsletter-subscribe'))[0]).toMatch(/contact-message/)
  })

  it('does not change validateProductionEnv warnings (existing exact-warning behaviour is untouched)', () => {
    const good = {
      NODE_ENV: 'production',
      PAYLOAD_SECRET: 'a'.repeat(40),
      PREVIEW_SECRET: 'b'.repeat(40),
      IP_HASH_SALT: 'c'.repeat(20),
      NEWSLETTER_TOKEN_SECRET: 'd'.repeat(40),
      TURNSTILE_SECRET_KEY: '0x4AAAAAAAreal-looking-secret',
      TURNSTILE_ALLOWED_HOSTNAMES: 'www.example.org',
      TURNSTILE_EXPECTED_ACTION: 'submit-story',
      SMTP_HOST: 'smtp.example.org',
      EMAIL_FROM_ADDRESS: 'cms@example.org',
      CMS_PUBLIC_URL: 'https://cms.example.org',
      CMS_CORS_ORIGINS: 'https://www.example.org',
      CMS_CSRF_ORIGINS: 'https://cms.example.org',
      PUBLIC_SUBMISSION_ORIGINS: 'https://www.example.org',
      TRUST_PROXY: 'true',
    } as NodeJS.ProcessEnv
    expect(validateProductionEnv(good)).toEqual({ problems: [], warnings: [] })
  })
})
