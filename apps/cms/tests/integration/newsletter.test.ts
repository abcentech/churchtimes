import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  resetNewsletterLimiters,
  waitForPendingNewsletterMail,
} from '../../src/endpoints/publicNewsletter'
import { hashSubscriberEmail, hashToken, signUnsubscribeToken } from '../../src/lib/newsletter'
import { formatImportReport, runSubscriberImport } from '../../src/lib/subscriberImport'
import { api, newRunId, setupFixtures, type Fixtures } from './helpers'
import {
  installActionTurnstileStub,
  installMailCapture,
  removeActionTurnstileStub,
  siteverifyCalls,
  TS_BAD,
  tsToken,
  type MailCapture,
} from './publicStubs'

const runId = newRunId()
const ALLOWED = 'http://allowed.test'
const SITE = 'https://www.example.test'
const TOKEN_SECRET = 'newsletter-test-only-secret-0123456789abcdef'
const NEUTRAL = { ok: true, message: 'If this address can be subscribed, we sent a confirmation email.' }
let f: Fixtures
let mail: MailCapture
let ipCounter = 0
const nextIp = () => `10.${Math.floor(ipCounter / 250)}.${(ipCounter += 1) % 250}.${Math.floor(Math.random() * 200) + 1}`
const env = process.env as Record<string, string | undefined>
const saved = { ...process.env }

beforeAll(async () => {
  env.SMTP_HOST = 'smtp.stub.example.test' // only says "SMTP is configured"; sendEmail is stubbed below
  env.PUBLIC_SITE_URL = SITE
  env.NEWSLETTER_TOKEN_SECRET = TOKEN_SECRET
  env.NEWSLETTER_RATE_LIMIT = '5'
  env.NEWSLETTER_RATE_WINDOW_SECONDS = '900'
  env.NEWSLETTER_TOKEN_RATE_LIMIT = '6'
  resetNewsletterLimiters()
  installActionTurnstileStub()
  f = await setupFixtures(runId)
  mail = installMailCapture(f.payload)
})

afterAll(async () => {
  removeActionTurnstileStub()
  mail?.restore()
  await f?.payload.delete({ collection: 'subscribers', where: { id: { exists: true } }, overrideAccess: true }).catch(() => undefined)
  await f?.payload
    .delete({ collection: 'audit-logs', where: { collection: { equals: 'subscribers' } }, overrideAccess: true })
    .catch(() => undefined)
  await f?.cleanup()
  for (const k of ['SMTP_HOST', 'PUBLIC_SITE_URL', 'NEWSLETTER_TOKEN_SECRET', 'NEWSLETTER_RATE_LIMIT', 'NEWSLETTER_RATE_WINDOW_SECONDS', 'NEWSLETTER_TOKEN_RATE_LIMIT']) {
    if (saved[k] === undefined) delete env[k]
    else env[k] = saved[k]
  }
})

let n = 0
const newEmail = () => `Reader${++n}-${runId}@Example.test`
const body = (extra: Record<string, unknown> = {}) => ({
  email: newEmail(),
  consent: true,
  source: 'footer',
  turnstileToken: tsToken('newsletter-subscribe'),
  ...extra,
})

type Opts = { ip?: string; origin?: string; contentType?: string; raw?: string }
const headersFor = (opts: Opts) => ({
  'x-forwarded-for': opts.ip ?? nextIp(),
  ...(opts.contentType ? { 'content-type': opts.contentType } : {}),
  ...(opts.origin ? { origin: opts.origin } : {}),
})
const subscribe = async (payload: unknown, opts: Opts = {}) => {
  const res = await api('POST', '/api/public/newsletter/subscribe', { body: opts.raw ?? payload, headers: headersFor(opts) })
  await waitForPendingNewsletterMail()
  return res
}
const confirm = (token: unknown, opts: Opts = {}) =>
  api('POST', '/api/public/newsletter/confirm', { body: opts.raw ?? { token }, headers: headersFor(opts) })
const unsubscribe = (token: unknown, opts: Opts = {}) =>
  api('POST', '/api/public/newsletter/unsubscribe', { body: opts.raw ?? { token }, headers: headersFor(opts) })

const row = async (email: string) =>
  (
    await f.payload.find({ collection: 'subscribers', where: { email: { equals: email.toLowerCase() } }, limit: 1, depth: 0, overrideAccess: true })
  ).docs[0] as Record<string, any> | undefined

const tokenFromMail = (m: { text: string }): string => /token=([A-Za-z0-9_-]+)/.exec(m.text)![1]!
const lastMail = () => mail.sent[mail.sent.length - 1]!

/** Create a subscriber directly (arrange step) in a given state. */
const seed = async (status: string, extra: Record<string, unknown> = {}) => {
  const email = newEmail().toLowerCase()
  const doc = (await f.payload.create({
    collection: 'subscribers',
    data: {
      email,
      status,
      source: 'footer',
      consentTextVersion: 'newsletter-consent-v1',
      consentAt: new Date().toISOString(),
      importedFrom: 'web',
      ...extra,
    } as never,
    overrideAccess: true,
    context: { subscriberSystemWrite: true },
  })) as { id: number }
  return { email, id: doc.id }
}

describe('double opt-in happy path', () => {
  it('stores pending with a hashed token, mails a PUBLIC SITE link, confirms once, and refuses GET', async () => {
    const payload = body({ name: 'Ada Obi' })
    const ip = '203.0.113.50'
    const before = mail.sent.length
    const res = await subscribe(payload, { ip, origin: ALLOWED })
    expect(res.status).toBe(202)
    expect(res.json).toEqual(NEUTRAL)
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED)

    const doc = (await row(payload.email))!
    expect(doc.email).toBe(payload.email.toLowerCase())
    expect(doc).toMatchObject({ status: 'pending', source: 'footer', name: 'Ada Obi', importedFrom: 'web', consentTextVersion: 'newsletter-consent-v1' })
    expect(doc.consentAt).toBeTruthy()
    expect(doc.confirmedAt ?? null).toBeNull()
    expect(doc.ipHash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(doc)).not.toContain(ip)
    const ttl = new Date(doc.confirmTokenExpiresAt).getTime() - Date.now()
    expect(ttl).toBeGreaterThan(71.9 * 3600 * 1000)
    expect(ttl).toBeLessThanOrEqual(72 * 3600 * 1000)

    // STUB mail transport: what the CMS handed to the mailer.
    expect(mail.sent.length).toBe(before + 1)
    const m = lastMail()
    expect(m.to).toBe(payload.email.toLowerCase())
    expect(m.text).toContain(`${SITE}/newsletter/confirm?token=`)
    expect(m.text).not.toContain('/api/')
    const token = tokenFromMail(m)
    expect(doc.confirmTokenHash).toBe(hashToken(token))
    expect(JSON.stringify(doc)).not.toContain(token) // only the hash is stored

    const get = await api('GET', '/api/public/newsletter/confirm')
    expect(get.status).toBe(405)
    expect(get.headers.get('allow')).toContain('POST')
    expect((await row(payload.email))!.status).toBe('pending') // a GET (link pre-fetch) changed nothing

    const ok = await confirm(token)
    expect(ok.status).toBe(200)
    expect(ok.json).toEqual({ ok: true })
    const after = (await row(payload.email))!
    expect(after.status).toBe('confirmed')
    expect(after.confirmedAt).toBeTruthy()
    expect(after.confirmTokenHash ?? null).toBeNull()

    const again = await confirm(token)
    expect(again.status).toBe(400)
    expect(again.json).toEqual({ ok: false, errors: [{ message: 'This link is no longer valid.' }] })
  })

  it('expires confirmation links after 72 hours', async () => {
    const payload = body()
    await subscribe(payload)
    const token = tokenFromMail(lastMail())
    const doc = (await row(payload.email))!
    await f.payload.update({
      collection: 'subscribers',
      id: doc.id,
      data: { confirmTokenExpiresAt: new Date(Date.now() - 1000).toISOString() } as never,
      overrideAccess: true,
      context: { subscriberSystemWrite: true },
    })
    const res = await confirm(token)
    expect(res.status).toBe(400)
    expect(res.json.errors[0].message).toBe('This link is no longer valid.')
    expect((await row(payload.email))!.status).toBe('pending')
  })

  it('rejects garbage, empty and missing tokens with the same 400', async () => {
    for (const token of ['nope', '', undefined, 12, 'x'.repeat(40), 'A'.repeat(43)]) {
      const res = await confirm(token)
      expect(res.status, String(token)).toBe(400)
      expect(res.json.errors[0].message).toBe('This link is no longer valid.')
    }
  })
})

describe('neutral answers (no enumeration)', () => {
  it('gives new, pending and confirmed addresses byte-identical answers; only unconfirmed ones are mailed', async () => {
    const payload = body()
    const first = await subscribe(payload)
    const token1 = tokenFromMail(lastMail())

    const mailsAfterFirst = mail.sent.length
    const second = await subscribe({ ...payload, turnstileToken: tsToken('newsletter-subscribe') }) // pending now
    expect(mail.sent.length).toBe(mailsAfterFirst + 1)
    const token2 = tokenFromMail(lastMail())
    expect(token2).not.toBe(token1)
    // the old link was replaced
    expect((await confirm(token1)).status).toBe(400)
    expect((await confirm(token2)).status).toBe(200)

    const mailsAfterConfirm = mail.sent.length
    const third = await subscribe(payload) // confirmed now
    expect(mail.sent.length).toBe(mailsAfterConfirm) // nothing is sent to a confirmed address

    for (const r of [first, second, third]) {
      expect(r.status).toBe(202)
      expect(r.text).toBe(first.text)
    }
    expect((await row(payload.email))!.status).toBe('confirmed')
  })

  it('does not silently re-add an unsubscribed address: it stays unsubscribed until a fresh confirmation', async () => {
    const payload = body()
    await subscribe(payload)
    await confirm(tokenFromMail(lastMail()))
    const doc = (await row(payload.email))!
    expect((await unsubscribe(signUnsubscribeToken(doc.id, TOKEN_SECRET))).status).toBe(200)
    expect((await row(payload.email))!.status).toBe('unsubscribed')

    const again = await subscribe(payload)
    expect(again.status).toBe(202)
    expect(again.json).toEqual(NEUTRAL)
    expect((await row(payload.email))!.status).toBe('unsubscribed') // not re-added
    const token = tokenFromMail(lastMail())

    expect((await confirm(token)).status).toBe(200) // the fresh confirmation is the only way back
    const back = (await row(payload.email))!
    expect(back.status).toBe('confirmed')
    expect(back.unsubscribedAt ?? null).toBeNull()
  })

  it('still answers 202 and keeps the row when the confirmation mail cannot be sent', async () => {
    const payload = body()
    mail.failNext()
    const before = mail.sent.length
    const res = await subscribe(payload)
    expect(res.status).toBe(202)
    expect(res.json).toEqual(NEUTRAL)
    expect(res.text).not.toContain('stub SMTP failure')
    expect(mail.sent.length).toBe(before)
    expect((await row(payload.email))!.status).toBe('pending')
  })
})

describe('POST /api/public/newsletter/subscribe: validation and abuse paths', () => {
  it('validates every field', async () => {
    const empty = await subscribe({ turnstileToken: tsToken('newsletter-subscribe') })
    expect(empty.status).toBe(400)
    expect(empty.json.errors.map((e: any) => e.field).sort()).toEqual(['consent', 'email', 'source'])
    const cases: Array<[string, Record<string, unknown>]> = [
      ['email', { email: 'not-an-email' }],
      ['consent', { consent: false }],
      ['consent', { consent: 'true' }],
      ['consent', { consent: undefined }],
      ['source', { source: 'sidebar' }],
      ['source', { source: undefined }],
      ['name', { name: 'A' }],
      ['name', { name: 'N'.repeat(121) }],
    ]
    for (const [field, patch] of cases) {
      const res = await subscribe(body(patch))
      expect(res.status, JSON.stringify(patch)).toBe(400)
      expect(res.json.errors).toEqual(expect.arrayContaining([expect.objectContaining({ field })]))
    }
    expect((await subscribe(undefined, { raw: '{nope', contentType: 'application/json' })).status).toBe(400)
  })

  it('treats a missing name and an empty name string the same (no name, no 400)', async () => {
    const a = body()
    const b = body({ name: '' })
    for (const p of [a, b]) expect((await subscribe(p)).status).toBe(202)
    for (const p of [a, b]) expect((await row(p.email))!.name ?? null).toBeNull()
  })

  it('ignores server-owned fields supplied by the client', async () => {
    const p = body({ status: 'confirmed', importedFrom: 'mailchimp-import', confirmedAt: '2020-01-01T00:00:00Z', ipHash: 'x', confirmTokenHash: 'y' })
    expect((await subscribe(p)).status).toBe(202)
    const doc = (await row(p.email))!
    expect(doc.status).toBe('pending')
    expect(doc.importedFrom).toBe('web')
    expect(doc.confirmedAt ?? null).toBeNull()
    expect(doc.ipHash).not.toBe('x')
    expect(doc.confirmTokenHash).not.toBe('y')
  })

  it('a honeypot hit answers the normal 202, stores nothing, mails nothing and skips Siteverify', async () => {
    const p = body({ website: 'http://spam.example.test' })
    const before = { mail: mail.sent.length, calls: siteverifyCalls.length }
    const res = await subscribe(p)
    expect(res.status).toBe(202)
    expect(res.json).toEqual(NEUTRAL)
    expect(await row(p.email)).toBeUndefined()
    expect(mail.sent.length).toBe(before.mail)
    expect(siteverifyCalls.length).toBe(before.calls)
  })

  it('requires a Turnstile token bound to the newsletter-subscribe action', async () => {
    const missing = await subscribe(body({ turnstileToken: undefined }))
    expect(missing.status).toBe(400)
    expect(missing.json.errors[0].field).toBe('turnstileToken')
    const bad = body({ turnstileToken: TS_BAD })
    expect((await subscribe(bad)).status).toBe(403)
    const wrong = body({ turnstileToken: tsToken('contact-message') })
    expect((await subscribe(wrong)).status).toBe(403)
    expect(await row(bad.email)).toBeUndefined()
    expect(await row(wrong.email)).toBeUndefined()
    const saved = env.TURNSTILE_EXPECTED_ACTION
    try {
      env.TURNSTILE_EXPECTED_ACTION = 'submit-story,contact-message,newsletter-subscribe'
      expect((await subscribe(body())).status).toBe(202)
      env.TURNSTILE_EXPECTED_ACTION = 'submit-story'
      expect((await subscribe(body())).status).toBe(403)
    } finally {
      if (saved === undefined) delete env.TURNSTILE_EXPECTED_ACTION
      else env.TURNSTILE_EXPECTED_ACTION = saved
    }
  })

  it('answers 503 and stores nothing in production when SMTP or PUBLIC_SITE_URL is missing', async () => {
    const smtp = env.SMTP_HOST
    const site = env.PUBLIC_SITE_URL
    const nodeEnv = env.NODE_ENV
    const p = body()
    const before = mail.sent.length
    try {
      env.NODE_ENV = 'production'
      delete env.SMTP_HOST
      const noSmtp = await subscribe(p)
      expect(noSmtp.status).toBe(503)
      expect(noSmtp.json).toEqual({ ok: false, errors: [{ message: 'Sign-up is unavailable.' }] })

      env.SMTP_HOST = smtp
      delete env.PUBLIC_SITE_URL
      expect((await subscribe(p)).status).toBe(503)
      env.PUBLIC_SITE_URL = 'http://insecure.example.test' // https only in production
      expect((await subscribe(p)).status).toBe(503)
    } finally {
      env.NODE_ENV = nodeEnv
      env.SMTP_HOST = smtp
      env.PUBLIC_SITE_URL = site
    }
    expect(await row(p.email)).toBeUndefined()
    expect(mail.sent.length).toBe(before)
  })

  it('limits each IP with Retry-After exposed to the allowlisted origin', async () => {
    const ip = nextIp()
    for (let i = 0; i < 5; i++) expect((await subscribe(body(), { ip })).status).toBe(202)
    const res = await subscribe(body(), { ip, origin: ALLOWED })
    expect(res.status).toBe(429)
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
    expect(res.headers.get('access-control-expose-headers')).toBe('Retry-After')
    expect((await subscribe(body())).status).toBe(202)
  })

  it('limits each address to 3 per hour whatever its state', async () => {
    const email = newEmail()
    for (let i = 0; i < 3; i++) expect((await subscribe(body({ email }))).status).toBe(202)
    const res = await subscribe(body({ email }))
    expect(res.status).toBe(429)
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
  })

  it('refuses a wrong content type (415), oversized bodies (413), unlisted origins (403) and answers preflights', async () => {
    expect((await subscribe(undefined, { contentType: 'text/plain', raw: JSON.stringify(body()) })).status).toBe(415)
    expect((await subscribe(body({ name: 'x'.repeat(9 * 1024) }))).status).toBe(413)
    const declared = await api('POST', '/api/public/newsletter/subscribe', {
      body: JSON.stringify(body()),
      headers: { 'content-type': 'application/json', 'content-length': String(9 * 1024), 'x-forwarded-for': nextIp() },
    })
    expect(declared.status).toBe(413)
    const bad = await subscribe(body(), { origin: 'http://evil.test' })
    expect(bad.status).toBe(403)
    expect(bad.headers.get('access-control-allow-origin')).toBeNull()
    for (const path of ['subscribe', 'confirm', 'unsubscribe']) {
      const pre = await api('OPTIONS', `/api/public/newsletter/${path}`, { headers: { origin: ALLOWED } })
      expect(pre.status, path).toBe(204)
      expect(pre.headers.get('access-control-allow-origin')).toBe(ALLOWED)
    }
    expect((await api('GET', '/api/public/newsletter/subscribe')).status).toBe(405)
  })
})

describe('unsubscribe', () => {
  it('unsubscribes with a signed token, is idempotent and POST only', async () => {
    const s = await seed('confirmed', { confirmedAt: new Date().toISOString() })
    const token = signUnsubscribeToken(s.id, TOKEN_SECRET)
    expect((await api('GET', '/api/public/newsletter/unsubscribe')).status).toBe(405)
    expect((await api('PATCH', '/api/public/newsletter/unsubscribe')).status).toBe(405)
    expect((await row(s.email))!.status).toBe('confirmed')

    const res = await unsubscribe(token)
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ ok: true })
    const doc = (await row(s.email))!
    expect(doc.status).toBe('unsubscribed')
    expect(doc.unsubscribedAt).toBeTruthy()
    const first = doc.unsubscribedAt
    expect((await unsubscribe(token)).status).toBe(200) // the link keeps working
    expect((await row(s.email))!.unsubscribedAt).toBe(first)
  })

  it('rejects forged, tampered, wrong-key and unknown-subscriber tokens with 400', async () => {
    const s = await seed('confirmed')
    const good = signUnsubscribeToken(s.id, TOKEN_SECRET)
    const forged = [
      signUnsubscribeToken(s.id, 'a-different-secret-that-is-long-enough-xx'),
      good.replace(`.${s.id}.`, `.${s.id + 1}.`),
      `${good.slice(0, -2)}AA`,
      signUnsubscribeToken(s.id + 100000, TOKEN_SECRET), // authentic shape and key, no such subscriber
      `u1.${s.id}.`,
      String(s.id),
    ]
    for (const token of forged) {
      const res = await unsubscribe(token)
      expect(res.status, token).toBe(400)
      expect(res.json.errors[0].message).toBe('This link is no longer valid.')
    }
    expect((await row(s.email))!.status).toBe('confirmed')
  })

  it('does not revive an erased subscriber', async () => {
    const s = await seed('confirmed')
    expect((await api('POST', `/api/subscribers/${s.id}/erase`, { token: f.tokens.admin })).status).toBe(200)
    expect((await unsubscribe(signUnsubscribeToken(s.id, TOKEN_SECRET))).status).toBe(200)
    expect((await f.payload.findByID({ collection: 'subscribers', id: s.id, overrideAccess: true })).status).toBe('erased')
  })

  it('rate limits confirm and unsubscribe per IP with Retry-After', async () => {
    const ip = nextIp()
    for (let i = 0; i < 6; i++) expect((await confirm('nope', { ip })).status).toBe(400)
    const res = await unsubscribe('nope', { ip, origin: ALLOWED })
    expect(res.status).toBe(429)
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
    expect(res.headers.get('access-control-expose-headers')).toBe('Retry-After')
  })
})

describe('staff access to subscribers', () => {
  it('is admin and editor-in-chief only, never anonymous, and never shows token fields', async () => {
    const s = await seed('pending', { confirmTokenHash: 'a'.repeat(64), confirmTokenExpiresAt: new Date(Date.now() + 1000).toISOString() })
    const anon = await api('GET', '/api/subscribers')
    expect([401, 403]).toContain(anon.status)
    expect(anon.text).not.toContain(s.email)
    expect([401, 403, 404]).toContain((await api('GET', `/api/subscribers/${s.id}`)).status)
    for (const role of ['reporter', 'trusted', 'sectionEditor'] as const) {
      expect((await api('GET', '/api/subscribers', { token: f.tokens[role] })).status, role).toBe(403)
      expect([403, 404]).toContain((await api('GET', `/api/subscribers/${s.id}`, { token: f.tokens[role] })).status)
    }
    for (const role of ['eic', 'admin'] as const) {
      const one = await api('GET', `/api/subscribers/${s.id}`, { token: f.tokens[role] })
      expect(one.status, role).toBe(200)
      expect(one.json.email).toBe(s.email)
      expect(one.text).not.toContain('confirmTokenHash')
      expect(one.text).not.toContain('confirmTokenExpiresAt')
      expect(one.text).not.toContain('a'.repeat(64))
    }
  })

  it('cannot create, delete or fake consent over REST', async () => {
    const s = await seed('pending')
    expect((await api('POST', '/api/subscribers', { token: f.tokens.admin, body: { email: newEmail(), status: 'confirmed' } })).status).toBe(403)
    expect((await api('DELETE', `/api/subscribers/${s.id}`, { token: f.tokens.admin })).status).toBe(403)
    const toConfirmed = await api('PATCH', `/api/subscribers/${s.id}`, { token: f.tokens.eic, body: { status: 'confirmed' } })
    expect(toConfirmed.status).toBe(403)
    expect((await row(s.email))!.status).toBe('pending')
    const rewrite = await api('PATCH', `/api/subscribers/${s.id}`, { token: f.tokens.eic, body: { email: 'other@example.test', name: 'X Y', status: 'unsubscribed' } })
    expect(rewrite.status).toBe(200)
    const after = (await row(s.email))!
    expect(after.status).toBe('unsubscribed')
    expect(after.email).toBe(s.email) // only the status is editable
  })
})

describe('export', () => {
  it('is admin only, audited, no-store, filtered by status and guards against formula injection', async () => {
    const evilName = await seed('confirmed', { name: '=HYPERLINK("http://x.example","go")' })
    const plus = await f.payload.create({
      collection: 'subscribers',
      data: {
        email: `+tag-${runId}@example.test`,
        name: '-2+3',
        status: 'confirmed',
        source: 'home',
        consentTextVersion: 'newsletter-consent-v1',
        consentAt: new Date().toISOString(),
        importedFrom: 'web',
      } as never,
      overrideAccess: true,
      context: { subscriberSystemWrite: true },
    })
    const pending = await seed('pending')

    expect((await api('GET', '/api/subscribers/export')).status).toBe(401)
    expect((await api('GET', '/api/subscribers/export', { token: f.tokens.eic })).status).toBe(403)
    expect((await api('GET', '/api/subscribers/export', { token: f.tokens.sectionEditor })).status).toBe(403)
    expect((await api('GET', '/api/subscribers/export?status=erased', { token: f.tokens.admin })).status).toBe(400)
    expect((await api('GET', '/api/subscribers/export?status=bogus', { token: f.tokens.admin })).status).toBe(400)

    const res = await api('GET', '/api/subscribers/export?status=confirmed', { token: f.tokens.admin })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/csv')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('content-disposition')).toContain('attachment')
    const lines = res.text.split('\r\n')
    expect(lines[0]).toBe('email,name,status,source,consentAt,confirmedAt,unsubscribedAt,importedFrom')
    expect(res.text).toContain(evilName.email)
    expect(res.text).not.toContain(pending.email)
    expect(res.text).not.toContain('ipHash')
    expect(res.text).toContain(`"'=HYPERLINK(""http://x.example"",""go"")"`)
    expect(res.text).toContain(`'+tag-${runId}@example.test,'-2+3,confirmed`)
    // no data cell starts with a formula character
    for (const line of lines.slice(1).filter(Boolean)) expect(line).not.toMatch(/^[=+\-@]/)
    expect(plus).toBeTruthy()

    const audit = await f.payload.find({
      collection: 'audit-logs',
      where: { and: [{ action: { equals: 'subscriber.export' } }, { actor: { equals: f.users.admin.id } }] },
      overrideAccess: true,
    })
    expect(audit.docs.length).toBeGreaterThanOrEqual(1)
    expect(audit.docs.map((d: any) => `${d.summary} ${JSON.stringify(d.details)}`).join()).not.toContain('@')
  })
})

describe('erasure', () => {
  it('replaces the address with its salted hash, keeps a suppression record, is admin only and idempotent', async () => {
    const s = await seed('confirmed', { name: 'Ada Obi', ipHash: 'h'.repeat(64) })
    expect((await api('POST', `/api/subscribers/${s.id}/erase`)).status).toBe(401)
    expect((await api('POST', `/api/subscribers/${s.id}/erase`, { token: f.tokens.eic })).status).toBe(403)
    expect((await row(s.email))!.status).toBe('confirmed')

    const res = await api('POST', `/api/subscribers/${s.id}/erase`, { token: f.tokens.admin })
    expect(res.status).toBe(200)
    expect(res.json).toEqual({ ok: true })
    const doc = (await f.payload.findByID({ collection: 'subscribers', id: s.id, overrideAccess: true })) as Record<string, any>
    expect(doc.status).toBe('erased')
    expect(doc.email).toBe(hashSubscriberEmail(s.email))
    expect(doc.email).toMatch(/^erased:[0-9a-f]{64}$/)
    expect(doc.name ?? null).toBeNull()
    expect(doc.ipHash ?? null).toBeNull()
    expect(JSON.stringify(doc)).not.toContain(s.email)
    expect(await row(s.email)).toBeUndefined()
    expect((await api('POST', `/api/subscribers/${s.id}/erase`, { token: f.tokens.admin })).status).toBe(200)

    const exported = await api('GET', '/api/subscribers/export?status=confirmed', { token: f.tokens.admin })
    expect(exported.text).not.toContain(s.email)
    expect((await api('POST', '/api/subscribers/9999999/erase', { token: f.tokens.admin })).status).toBe(404)
    expect((await api('POST', '/api/subscribers/abc/erase', { token: f.tokens.admin })).status).toBe(404)
  })

  it('a person who signed up again after erasure is a fresh double opt-in; erasing them again keeps one suppression record', async () => {
    const s = await seed('confirmed')
    await api('POST', `/api/subscribers/${s.id}/erase`, { token: f.tokens.admin })
    const res = await subscribe(body({ email: s.email }))
    expect(res.status).toBe(202)
    const fresh = (await row(s.email))!
    expect(fresh.status).toBe('pending')
    expect(fresh.id).not.toBe(s.id)
    expect((await api('POST', `/api/subscribers/${fresh.id}/erase`, { token: f.tokens.admin })).status).toBe(200)
    expect(await row(s.email)).toBeUndefined()
    const tombstones = await f.payload.find({
      collection: 'subscribers',
      where: { email: { equals: hashSubscriberEmail(s.email) } },
      overrideAccess: true,
    })
    expect(tombstones.docs).toHaveLength(1)
  })
})

describe('Mailchimp import CLI logic (SYNTHETIC data)', () => {
  const header = 'Email Address,First Name,Last Name,OPTIN_TIME,CONFIRM_TIME,Status'
  const mk = (suffix: string) => `imp-${suffix}-${runId}@example.test`

  it('dry run writes nothing; apply imports only subscribed rows as confirmed; reruns and suppressed addresses are skipped', async () => {
    const existingUnsub = await seed('unsubscribed')
    const erased = await seed('confirmed')
    await api('POST', `/api/subscribers/${erased.id}/erase`, { token: f.tokens.admin })
    const csv = [
      header,
      `${mk('a')},Ada,Obi,2024-03-01 09:30:00,2024-03-01 09:31:00,subscribed`,
      `${mk('b')},Bola,,,2024-04-02 10:00:00,subscribed`,
      `${mk('unsub')},U,V,,,unsubscribed`,
      `${mk('cleaned')},C,D,,,cleaned`,
      `${mk('pending')},P,Q,,,pending`,
      `${existingUnsub.email},Old,Row,2020-01-01 00:00:00,,subscribed`,
      `${erased.email},Gone,Person,2020-01-01 00:00:00,,subscribed`,
      `${mk('a').toUpperCase()},Dup,Row,,,subscribed`,
      `not-an-email,I,J,,,subscribed`,
    ].join('\n')

    const dry = await runSubscriberImport(f.payload, csv, { apply: false })
    expect(dry).toMatchObject({
      rowsRead: 9,
      candidates: 4,
      skippedNotSubscribed: 3,
      skippedInvalidEmail: 1,
      skippedDuplicateInFile: 1,
      skippedAlreadyPresent: 1,
      skippedErasedOrSuppressed: 1,
      wouldCreate: 2,
      created: 0,
    })
    expect(await row(mk('a'))).toBeUndefined()
    expect(formatImportReport(dry, false)).not.toContain('@')
    expect(formatImportReport(dry, false)).toContain('DRY RUN')

    const applied = await runSubscriberImport(f.payload, csv, { apply: true })
    expect(applied.created).toBe(2)
    expect(formatImportReport(applied, true)).not.toContain('@')
    const a = (await row(mk('a')))!
    expect(a).toMatchObject({ status: 'confirmed', importedFrom: 'mailchimp-import', name: 'Ada Obi', consentTextVersion: 'mailchimp-import-v1' })
    expect(new Date(a.consentAt).toISOString()).toBe('2024-03-01T09:30:00.000Z')
    expect(new Date(a.confirmedAt).toISOString()).toBe('2024-03-01T09:31:00.000Z')
    expect((await row(mk('b')))!.status).toBe('confirmed')
    expect(await row(mk('unsub'))).toBeUndefined()
    expect(await row(mk('cleaned'))).toBeUndefined()
    expect(await row(mk('pending'))).toBeUndefined()
    expect((await row(existingUnsub.email))!.status).toBe('unsubscribed') // a stale export never re-subscribes anyone
    expect(await row(erased.email)).toBeUndefined() // erased stays erased

    const rerun = await runSubscriberImport(f.payload, csv, { apply: true })
    expect(rerun.created).toBe(0)
    expect(rerun.skippedAlreadyPresent).toBe(3)
  })

  it('refuses a file without a status column unless it is declared the Subscribed export', async () => {
    const csv = `Email Address,First Name\n${mk('ns')},A`
    const refused = await runSubscriberImport(f.payload, csv, { apply: true })
    expect(refused.refused).toBe('no-status-column')
    expect(await row(mk('ns'))).toBeUndefined()
    const ok = await runSubscriberImport(f.payload, csv, { apply: true, assumeSubscribed: true })
    expect(ok.created).toBe(1)
  })
})
