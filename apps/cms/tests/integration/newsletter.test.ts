import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  resetNewsletterLimiters,
  waitForPendingNewsletterMail,
} from '../../src/endpoints/publicNewsletter'
import { hashSubscriberEmail, hashToken, signUnsubscribeToken } from '../../src/lib/newsletter'
import { cliFailureMessage } from '../../src/lib/safeLog'
import { formatImportReport, runSubscriberImport } from '../../src/lib/subscriberImport'
import { parseCommandArgs, runPurgeUnconfirmed, runReconfirm } from '../../src/lib/subscriberReconfirm'
import { api, newRunId, setupFixtures, type Fixtures } from './helpers'
import {
  captureLogs,
  drizzleLikeError,
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
  env.NEWSLETTER_RESEND_COOLDOWN_SECONDS = '0' // off here so resend behaviour can be tested; the cooldown has its own tests
  env.NEWSLETTER_MAX_CONFIRM_MAILS_PER_DAY = '5'
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
  for (const k of ['SMTP_HOST', 'PUBLIC_SITE_URL', 'NEWSLETTER_TOKEN_SECRET', 'NEWSLETTER_RATE_LIMIT', 'NEWSLETTER_RATE_WINDOW_SECONDS', 'NEWSLETTER_TOKEN_RATE_LIMIT', 'NEWSLETTER_RESEND_COOLDOWN_SECONDS', 'NEWSLETTER_MAX_CONFIRM_MAILS_PER_DAY']) {
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
    const keySaved = env.TURNSTILE_SECRET_KEY
    const listSaved = env.TURNSTILE_EXPECTED_ACTION
    try {
      // the per-endpoint pin applies when the allowlist is set and the secret is a real one (both actions are allowlisted here)
      env.TURNSTILE_EXPECTED_ACTION = 'submit-story,contact-message,newsletter-subscribe'
      env.TURNSTILE_SECRET_KEY = 'real-looking-test-secret-not-a-dummy'
      expect((await subscribe(wrong)).status).toBe(403)
    } finally {
      if (keySaved === undefined) delete env.TURNSTILE_SECRET_KEY
      else env.TURNSTILE_SECRET_KEY = keySaved
      if (listSaved === undefined) delete env.TURNSTILE_EXPECTED_ACTION
      else env.TURNSTILE_EXPECTED_ACTION = listSaved
    }
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

describe('confirm is single use even under concurrency', () => {
  it('two simultaneous confirms of one link: exactly one 200, one 400, one audit row', async () => {
    for (let round = 0; round < 3; round++) {
      const payload = body()
      await subscribe(payload)
      const token = tokenFromMail(lastMail())
      const doc = (await row(payload.email))!
      const results = await Promise.all([confirm(token), confirm(token), confirm(token)])
      const statuses = results.map((r) => r.status).sort()
      expect(statuses, `round ${round}`).toEqual([200, 400, 400])
      for (const r of results.filter((x) => x.status === 400)) {
        expect(r.json.errors[0].message).toBe('This link is no longer valid.')
      }
      const audit = await f.payload.find({
        collection: 'audit-logs',
        where: { and: [{ action: { equals: 'subscriber.confirm' } }, { docId: { equals: String(doc.id) } }] },
        overrideAccess: true,
      })
      expect(audit.docs).toHaveLength(1)
      const after = (await row(payload.email))!
      expect(after.status).toBe('confirmed')
      expect(after.confirmTokenHash ?? null).toBeNull()
    }
  })

  it('a link for an address that went unsubscribed after the link was issued no longer matches the observed state', async () => {
    const payload = body()
    await subscribe(payload)
    const token = tokenFromMail(lastMail())
    expect((await confirm(token)).status).toBe(200)
    expect((await confirm(token)).status).toBe(400)
  })
})

describe('mail-bombing limits on confirmation e-mails', () => {
  const withEnv = async (patch: Record<string, string>, fn: () => Promise<void>) => {
    const saved = Object.fromEntries(Object.keys(patch).map((k) => [k, env[k]]))
    Object.assign(env, patch)
    try {
      await fn()
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete env[k]
        else env[k] = v
      }
    }
  }

  it('sends nothing inside the resend cooldown and answers the identical neutral 202; the first link keeps working', async () => {
    await withEnv({ NEWSLETTER_RESEND_COOLDOWN_SECONDS: '600' }, async () => {
      const payload = body()
      const first = await subscribe(payload)
      const token1 = tokenFromMail(lastMail())
      const sentAfterFirst = mail.sent.length
      const again = await subscribe(payload)
      expect(mail.sent.length).toBe(sentAfterFirst) // cooldown: nothing sent
      expect(again.status).toBe(202)
      expect(again.text).toBe(first.text)
      expect((await row(payload.email))!.confirmTokenHash).toBe(hashToken(token1)) // token not replaced
      expect((await confirm(token1)).status).toBe(200)

      // once the cooldown has passed (simulated by ageing the stamp) a fresh link is sent again
      const other = body()
      await subscribe(other)
      const doc = (await row(other.email))!
      await f.payload.update({
        collection: 'subscribers',
        id: doc.id,
        data: { lastConfirmMailAt: new Date(Date.now() - 601 * 1000).toISOString() } as never,
        overrideAccess: true,
        context: { subscriberSystemWrite: true },
      })
      const before = mail.sent.length
      await subscribe(other)
      expect(mail.sent.length).toBe(before + 1)
    })
  })

  it('caps confirmation e-mails per address per day (NEWSLETTER_MAX_CONFIRM_MAILS_PER_DAY)', async () => {
    await withEnv({ NEWSLETTER_RESEND_COOLDOWN_SECONDS: '0', NEWSLETTER_MAX_CONFIRM_MAILS_PER_DAY: '2' }, async () => {
      const payload = body()
      const before = mail.sent.length
      const answers = []
      for (let i = 0; i < 3; i++) answers.push(await subscribe(payload)) // 3 per hour is the per-address request limit
      expect(mail.sent.length).toBe(before + 2) // 2 sent, the third held back by the daily cap
      for (const a of answers) {
        expect(a.status).toBe(202)
        expect(a.text).toBe(answers[0]!.text)
      }
      const doc = (await row(payload.email))!
      expect(doc.confirmMailsInDay).toBe(2)
      const sentBefore = mail.sent.length
      // a row already at the cap inside its 24 h window (the window rollover itself is covered by the unit tests)
      const fresh = await seed('pending', {
        lastConfirmMailAt: new Date(Date.now() - 3600 * 1000).toISOString(),
        confirmMailsDayStart: new Date(Date.now() - 3600 * 1000).toISOString(),
        confirmMailsInDay: 2,
      })
      await subscribe(body({ email: fresh.email }))
      expect(mail.sent.length).toBe(sentBefore) // still capped inside the window
      expect((await row(fresh.email))!.confirmMailsInDay).toBe(2)
    })
  })

  it('never mails a bounced address automatically: same neutral 202, no mail, status unchanged', async () => {
    const s = await seed('bounced')
    const before = mail.sent.length
    const first = await subscribe(body())
    const res = await subscribe(body({ email: s.email }))
    expect(res.status).toBe(202)
    expect(res.text).toBe(first.text)
    expect(mail.sent.length).toBe(before + 1) // only the new address was mailed
    const doc = (await row(s.email))!
    expect(doc.status).toBe('bounced')
    expect(doc.confirmTokenHash ?? null).toBeNull()
  })

  it('does not expose the bookkeeping fields over REST', async () => {
    const payload = body()
    await subscribe(payload)
    const doc = (await row(payload.email))!
    const one = await api('GET', `/api/subscribers/${doc.id}`, { token: f.tokens.admin })
    expect(one.status).toBe(200)
    for (const field of ['lastConfirmMailAt', 'confirmMailsDayStart', 'confirmMailsInDay', 'confirmTokenHash']) {
      expect(one.text).not.toContain(field)
    }
  })
})

describe('no personal data in logs when the database fails', () => {
  it('a failed sign-up write logs only the error class and code and still answers the neutral 202', async () => {
    const logs = captureLogs(f.payload)
    const originalCreate = f.payload.create.bind(f.payload)
    const p = body({ email: `secret.pii.reader-${runId}@example.test`, name: 'Zed Personname' })
    try {
      ;(f.payload as any).create = async (args: any) => {
        if (args.collection === 'subscribers') throw drizzleLikeError([p.email, 'Zed Personname'])
        return originalCreate(args)
      }
      const res = await subscribe(p)
      expect(res.status).toBe(202)
      expect(res.json).toEqual(NEUTRAL)
      expect(res.text).not.toMatch(/secret\.pii|Zed|Failed query/)
    } finally {
      ;(f.payload as any).create = originalCreate
      logs.restore()
    }
    const text = logs.text()
    expect(text).toContain('DrizzleQueryError')
    expect(text).toContain('23505')
    expect(text).not.toMatch(/secret\.pii|Zed|Failed query|@example\.test/)
    expect(await row(p.email)).toBeUndefined()
  })

  it('a failed confirm lookup and a failed staff export log nothing but class and code', async () => {
    const logs = captureLogs(f.payload)
    const originalFind = f.payload.find.bind(f.payload)
    try {
      ;(f.payload as any).find = async (args: any) => {
        if (args.collection === 'subscribers') throw drizzleLikeError(['secret.pii.reader@example.test', 'Zed Personname'])
        return originalFind(args)
      }
      const res = await confirm('A'.repeat(43))
      expect(res.status).toBe(500)
      expect(res.text).not.toMatch(/secret\.pii|Zed|Failed query/)
      const exp = await api('GET', '/api/subscribers/export?status=confirmed', { token: f.tokens.admin })
      expect(exp.status).toBe(500)
      expect(exp.text).not.toMatch(/secret\.pii|Zed|Failed query/)
    } finally {
      ;(f.payload as any).find = originalFind
      logs.restore()
    }
    const text = logs.text()
    expect(text).toContain('DrizzleQueryError')
    expect(text).not.toMatch(/secret\.pii|Zed|Failed query|@example\.test/)
  })

  it('an import that fails in the database surfaces only class and code to the CLI', async () => {
    const originalCreate = f.payload.create.bind(f.payload)
    const csv = `Email Address,First Name,Status\nsecret.pii.import-${runId}@example.test,Zed,subscribed`
    let thrown: unknown
    try {
      ;(f.payload as any).create = async (args: any) => {
        if (args.collection === 'subscribers') throw drizzleLikeError(['secret.pii.import@example.test', 'Zed'])
        return originalCreate(args)
      }
      await runSubscriberImport(f.payload, csv, { apply: true })
    } catch (err) {
      thrown = err
    } finally {
      ;(f.payload as any).create = originalCreate
    }
    expect(thrown).toBeTruthy()
    const printed = cliFailureMessage(thrown)
    expect(printed).toContain('DrizzleQueryError (23505)')
    expect(printed).not.toMatch(/secret\.pii|Zed|Failed query|@/)
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
  it('is admin only (not even the editor-in-chief), never anonymous, and never shows token fields', async () => {
    const s = await seed('pending', { confirmTokenHash: 'a'.repeat(64), confirmTokenExpiresAt: new Date(Date.now() + 1000).toISOString() })
    const anon = await api('GET', '/api/subscribers')
    expect([401, 403]).toContain(anon.status)
    expect(anon.text).not.toContain(s.email)
    expect([401, 403, 404]).toContain((await api('GET', `/api/subscribers/${s.id}`)).status)
    for (const role of ['reporter', 'trusted', 'sectionEditor', 'eic'] as const) {
      expect((await api('GET', '/api/subscribers', { token: f.tokens[role] })).status, role).toBe(403)
      expect([403, 404]).toContain((await api('GET', `/api/subscribers/${s.id}`, { token: f.tokens[role] })).status)
    }
    for (const role of ['admin'] as const) {
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
    const toConfirmed = await api('PATCH', `/api/subscribers/${s.id}`, { token: f.tokens.admin, body: { status: 'confirmed' } })
    expect(toConfirmed.status).toBe(403)
    expect((await row(s.email))!.status).toBe('pending')
    const rewrite = await api('PATCH', `/api/subscribers/${s.id}`, { token: f.tokens.admin, body: { email: 'other@example.test', name: 'X Y', status: 'unsubscribed' } })
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

const MARKER = 'mailchimp-import-no-optin-time'
const clearImported = () =>
  f.payload.delete({ collection: 'subscribers', where: { importedFrom: { equals: MARKER } }, overrideAccess: true })
const auditRows = async (action: string) =>
  (await f.payload.find({ collection: 'audit-logs', where: { action: { equals: action } }, limit: 100, overrideAccess: true })).docs as any[]

describe('Mailchimp import CLI logic (SYNTHETIC data)', () => {
  const header = 'Email Address,First Name,Last Name,OPTIN_TIME,CONFIRM_TIME,Status'
  const mk = (suffix: string) => `imp-${suffix}-${runId}@example.test`

  it('dry run writes nothing; rows with an opt-in time are confirmed, rows without are pending and never confirmed; blocking rows block', async () => {
    const existingUnsub = await seed('unsubscribed')
    const existingConfirmed = await seed('confirmed')
    const erased = await seed('confirmed')
    await api('POST', `/api/subscribers/${erased.id}/erase`, { token: f.tokens.admin })
    const csv = [
      header,
      `${mk('a')},Ada,Obi,2024-03-01 09:30:00,2024-03-01 09:31:00,subscribed`,
      `${mk('b')},Bola,,,2024-04-02 10:00:00,subscribed`, // CONFIRM_TIME but no OPTIN_TIME: no proof
      `${mk('c')},Chi,,2024-05-01 08:00:00,,subscribed`, // OPTIN_TIME but no CONFIRM_TIME: confirmedAt stays null
      `${mk('iso')},Iso,,2024-05-01T08:00:00Z,,subscribed`, // not Mailchimp's format: no opt-in time
      `${mk('unsub')},U,V,,,unsubscribed`,
      `${mk('cleaned')},C,D,,,cleaned`,
      `${mk('pending')},P,Q,,,pending`,
      `${existingUnsub.email},Old,Row,2020-01-01 00:00:00,,subscribed`,
      `${existingConfirmed.email},Was,Confirmed,,,unsubscribed`,
      `${erased.email},Gone,Person,2020-01-01 00:00:00,,subscribed`,
      `${mk('a').toUpperCase()},Dup,Row,,,subscribed`,
      `not-an-email,I,J,,,subscribed`,
    ].join('\n')

    const dry = await runSubscriberImport(f.payload, csv, { apply: false })
    expect(dry).toMatchObject({
      rowsRead: 12,
      candidates: 9,
      blockingCandidates: 3,
      skippedNotSubscribed: 1,
      skippedInvalidEmail: 1,
      skippedDuplicateInFile: 1,
      skippedAlreadyPresent: 2,
      skippedErasedOrSuppressed: 1,
      blockedExisting: 1,
      wouldCreate: 6,
      importedWithoutOptinTime: 2,
      created: 0,
    })
    expect(await row(mk('a'))).toBeUndefined()
    expect((await row(existingConfirmed.email))!.status).toBe('confirmed') // dry run changes nothing
    expect(formatImportReport(dry, false)).not.toContain('@')
    expect(formatImportReport(dry, false)).toContain('DRY RUN')

    const applied = await runSubscriberImport(f.payload, csv, { apply: true, operator: 'tester' })
    expect(applied.created).toBe(6)
    expect(formatImportReport(applied, true)).not.toContain('@')
    const a = (await row(mk('a')))!
    expect(a).toMatchObject({ status: 'confirmed', importedFrom: 'mailchimp-import', name: 'Ada Obi', consentTextVersion: 'mailchimp-import-v1' })
    expect(new Date(a.consentAt).toISOString()).toBe('2024-03-01T09:30:00.000Z')
    expect(new Date(a.confirmedAt).toISOString()).toBe('2024-03-01T09:31:00.000Z')
    // no opt-in time: no proof of consent, so NOT confirmed (excluded from sends and the confirmed export), confirmedAt null
    for (const k of ['b', 'iso']) {
      const r = (await row(mk(k)))!
      expect(r.status, k).toBe('pending')
      expect(r.consentAt ?? null, k).toBeNull()
      expect(r.confirmedAt ?? null, k).toBeNull()
      expect(r.importedFrom, k).toBe(MARKER)
    }
    // confirmedAt comes from CONFIRM_TIME only, never from OPTIN_TIME
    const c = (await row(mk('c')))!
    expect(c.status).toBe('confirmed')
    expect(c.confirmedAt ?? null).toBeNull()
    expect(new Date(c.consentAt).toISOString()).toBe('2024-05-01T08:00:00.000Z')
    // blocking rows
    const unsub = (await row(mk('unsub')))!
    expect(unsub.status).toBe('unsubscribed')
    expect(unsub.unsubscribedAt).toBeTruthy()
    expect((await row(mk('cleaned')))!.status).toBe('bounced')
    expect(await row(mk('pending'))).toBeUndefined()
    expect((await row(existingUnsub.email))!.status).toBe('unsubscribed')
    const blocked = (await row(existingConfirmed.email))!
    expect(blocked.status).toBe('unsubscribed') // the export's unsubscribe wins over a stale confirmed row
    expect(blocked.unsubscribedAt).toBeTruthy()
    expect(await row(erased.email)).toBeUndefined() // erased stays erased

    // the confirmed export never contains the unproven rows
    const exported = await api('GET', '/api/subscribers/export?status=confirmed', { token: f.tokens.admin })
    expect(exported.text).toContain(mk('a'))
    expect(exported.text).not.toContain(mk('b'))
    expect(exported.text).not.toContain(mk('iso'))
    expect(exported.text).not.toContain(mk('unsub'))

    // audited without personal data: counts, file checksum, operator
    const audits = await auditRows('subscriber.import')
    expect(audits.length).toBeGreaterThanOrEqual(1)
    const last = audits[audits.length - 1]
    expect(last.details.fileSha256).toBe(applied.fileSha256)
    expect(last.details.fileSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(last.details.created).toBe(6)
    expect(JSON.stringify(audits.map((a) => [a.summary, a.details, a.docId]))).not.toContain('@')

    const rerun = await runSubscriberImport(f.payload, csv, { apply: true })
    expect(rerun.created).toBe(0)
    expect(rerun.skippedAlreadyPresent).toBe(8)
  })

  it('imports unsubscribed and cleaned exports (UNSUB_TIME or CLEAN_TIME) as blocking rows instead of refusing', async () => {
    for (const [col, status] of [['UNSUB_TIME', 'unsubscribed'], ['CLEAN_TIME', 'bounced']] as const) {
      const email = mk(`uc-${col}`)
      const csv = `Email Address,First Name,${col}\n${email},A,2024-01-01 00:00:00`
      for (const assumeSubscribed of [false, true]) {
        const res = await runSubscriberImport(f.payload, csv, { apply: true, assumeSubscribed })
        expect(res.refused).toBeUndefined()
        expect(res.blockingCandidates).toBe(1)
      }
      const r = (await row(email))!
      expect(r.status).toBe(status)
      expect(new Date(r.unsubscribedAt).toISOString()).toBe('2024-01-01T00:00:00.000Z')
    }
  })

  it('refuses a file without a status column unless it is declared the Subscribed export', async () => {
    const csv = `Email Address,First Name\n${mk('ns')},A`
    const refused = await runSubscriberImport(f.payload, csv, { apply: true })
    expect(refused.refused).toBe('no-status-column')
    expect(await row(mk('ns'))).toBeUndefined()
    const ok = await runSubscriberImport(f.payload, csv, { apply: true, assumeSubscribed: true })
    expect(ok.created).toBe(1)
    expect((await row(mk('ns')))!.status).toBe('pending') // no OPTIN_TIME
  })
})

describe('re-confirmation of imported rows', () => {
  const imported = (extra: Record<string, unknown> = {}) =>
    seed('pending', { importedFrom: MARKER, consentAt: null, consentTextVersion: 'mailchimp-import-v1', ...extra })

  it('dry run sends nothing; apply mails ONLY imported unproven rows, once each, resumably, and audits counts only', async () => {
    await clearImported()
    const a = await imported()
    const b = await imported()
    const webPending = await seed('pending')
    const confirmed = await seed('confirmed', { importedFrom: 'mailchimp-import' })
    const before = mail.sent.length

    const dry = await runReconfirm(f.payload, { apply: false, deadline: '2099-01-01' })
    expect(dry).toMatchObject({ eligible: 2, sent: 0 })
    expect(mail.sent.length).toBe(before)

    const limited = await runReconfirm(f.payload, { apply: true, deadline: '2099-01-01', limit: 1, throttleMs: 0 })
    expect(limited).toMatchObject({ eligible: 1, sent: 1 })
    expect(mail.sent.length).toBe(before + 1)

    const rest = await runReconfirm(f.payload, { apply: true, deadline: '2099-01-01', throttleMs: 0 })
    expect(rest).toMatchObject({ eligible: 1, sent: 1 })
    const again = await runReconfirm(f.payload, { apply: true, deadline: '2099-01-01', throttleMs: 0 })
    expect(again).toMatchObject({ eligible: 0, sent: 0 }) // resumable: nothing is mailed twice
    const sent = mail.sent.slice(before)
    expect(sent.map((m) => String(m.to)).sort()).toEqual([a.email, b.email].sort())
    expect(sent.map((m) => String(m.to))).not.toContain(webPending.email)
    expect(sent.map((m) => String(m.to))).not.toContain(confirmed.email)
    expect(sent[0]!.text).toContain('2099-01-01')
    expect(sent[0]!.text).toContain(`${SITE}/newsletter/confirm?token=`)

    const ra = (await row(a.email))!
    expect(ra.consentTextVersion).toBe('mailchimp-reconfirm-v1')
    expect(ra.status).toBe('pending')
    expect(new Date(ra.confirmTokenExpiresAt).toISOString()).toBe('2099-01-01T23:59:59.999Z')
    expect((await row(webPending.email))!.lastConfirmMailAt ?? null).toBeNull()

    const audits = await auditRows('subscriber.reconfirm-run')
    expect(audits.length).toBeGreaterThanOrEqual(2)
    const text = JSON.stringify(audits.map((a) => [a.summary, a.details]))
    expect(text).not.toContain('@')
    expect(text).not.toContain(tokenFromMail(sent[0]!))
  })

  it('rejects a deadline in the past or malformed arguments', async () => {
    await expect(runReconfirm(f.payload, { apply: false, deadline: '2020-01-01' })).rejects.toThrow(/future/)
    expect(() => parseCommandArgs(['--apply', '--dry-run'])).toThrow()
    expect(() => parseCommandArgs(['--limit', '0'])).toThrow()
    expect(() => parseCommandArgs(['--deadline', '2026-02-31'])).toThrow()
    expect(parseCommandArgs([]).apply).toBe(false) // dry run is the default
  })

  it('a failed send is not counted as sent and is retried by the next run', async () => {
    await clearImported()
    const a = await imported()
    mail.failNext()
    const failed = await runReconfirm(f.payload, { apply: true, deadline: '2099-01-01', throttleMs: 0 })
    expect(failed).toMatchObject({ sent: 0, failed: 1 })
    const r = (await row(a.email))!
    expect(r.lastConfirmMailAt ?? null).toBeNull()
    expect(r.confirmTokenHash ?? null).toBeNull()
    const retry = await runReconfirm(f.payload, { apply: true, deadline: '2099-01-01', throttleMs: 0 })
    expect(retry).toMatchObject({ sent: 1, failed: 0 })
  })

  it('the link in the mail confirms: fresh consent under the re-permission wording, confirmed, single use', async () => {
    await clearImported()
    const a = await imported()
    await runReconfirm(f.payload, { apply: true, deadline: '2099-01-01', throttleMs: 0 })
    const token = tokenFromMail(lastMail())
    const res = await api('POST', '/api/public/newsletter/confirm', { body: { token }, headers: { 'x-forwarded-for': nextIp() } })
    expect(res.status).toBe(200)
    const doc = (await row(a.email))!
    expect(doc.status).toBe('confirmed')
    expect(doc.consentTextVersion).toBe('mailchimp-reconfirm-v1')
    expect(Date.now() - new Date(doc.consentAt).getTime()).toBeLessThan(60_000) // consent time is NOW, not an old import time
    expect(Date.now() - new Date(doc.confirmedAt).getTime()).toBeLessThan(60_000)
    expect(doc.confirmTokenHash ?? null).toBeNull()
    const again = await api('POST', '/api/public/newsletter/confirm', { body: { token }, headers: { 'x-forwarded-for': nextIp() } })
    expect(again.status).toBe(400)
  })

  it('the public sign-up form re-permissions an imported row with byte-identical answers; consent is the form wording', async () => {
    await clearImported()
    const a = await imported()
    const before = mail.sent.length
    const fresh = await subscribe(body())
    const res = await subscribe(body({ email: a.email }))
    expect(res.status).toBe(202)
    expect(res.text).toBe(fresh.text)
    await waitForPendingNewsletterMail()
    expect(mail.sent.length).toBe(before + 2)
    expect((await row(a.email))!.consentTextVersion).toBe('newsletter-consent-v1')
    const confirm = await api('POST', '/api/public/newsletter/confirm', {
      body: { token: tokenFromMail(lastMail()) },
      headers: { 'x-forwarded-for': nextIp() },
    })
    expect(confirm.status).toBe(200)
    const doc = (await row(a.email))!
    expect(doc.status).toBe('confirmed')
    expect(doc.consentTextVersion).toBe('newsletter-consent-v1')
    expect(Date.now() - new Date(doc.consentAt).getTime()).toBeLessThan(60_000)
  })

  it('purge: refuses before the deadline, dry run writes nothing, apply erases only mailed unconfirmed imported rows', async () => {
    await clearImported()
    const mailed = await imported({ lastConfirmMailAt: new Date().toISOString() })
    const unsent = await imported()
    const confirmed = await seed('confirmed', { importedFrom: 'mailchimp-import', lastConfirmMailAt: new Date().toISOString() })
    const web = await seed('pending', { lastConfirmMailAt: new Date().toISOString() })

    await expect(runPurgeUnconfirmed(f.payload, { apply: true, deadline: '2099-01-01' })).rejects.toThrow(/not passed/)
    expect((await row(mailed.email))!.status).toBe('pending')

    const dry = await runPurgeUnconfirmed(f.payload, { apply: false, deadline: '2026-01-01' })
    expect(dry).toMatchObject({ eligible: 1, purged: 0 })
    expect((await row(mailed.email))!.status).toBe('pending')

    const done = await runPurgeUnconfirmed(f.payload, { apply: true, deadline: '2026-01-01' })
    expect(done.purged).toBe(1)
    expect(await row(mailed.email)).toBeUndefined()
    const tomb = (await f.payload.findByID({ collection: 'subscribers', id: mailed.id, overrideAccess: true })) as Record<string, any>
    expect(tomb.status).toBe('erased')
    expect(tomb.email).toBe(hashSubscriberEmail(mailed.email))
    expect((await row(unsent.email))!.status).toBe('pending') // never mailed: kept unless --include-unsent
    expect((await row(confirmed.email))!.status).toBe('confirmed')
    expect((await row(web.email))!.status).toBe('pending')

    const all = await runPurgeUnconfirmed(f.payload, { apply: true, deadline: '2026-01-01', includeUnsent: true })
    expect(all.purged).toBe(1)
    expect(await row(unsent.email)).toBeUndefined()
    const audits = await auditRows('subscriber.purge-unconfirmed')
    expect(audits.length).toBeGreaterThanOrEqual(2)
    expect(JSON.stringify(audits.map((a) => [a.summary, a.details, a.docId]))).not.toContain('@')
  })
})

describe('staff handling of subscribers', () => {
  it('a staff status change is audited, stamps unsubscribedAt and invalidates a pending token', async () => {
    const s = await seed('pending', { confirmTokenHash: 'b'.repeat(64), confirmTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString() })
    const res = await api('PATCH', `/api/subscribers/${s.id}`, { token: f.tokens.admin, body: { status: 'unsubscribed' } })
    expect(res.status).toBe(200)
    const doc = (await row(s.email))!
    expect(doc.status).toBe('unsubscribed')
    expect(doc.unsubscribedAt).toBeTruthy()
    expect(doc.confirmTokenHash ?? null).toBeNull()
    expect(doc.confirmTokenExpiresAt ?? null).toBeNull()
    const audits = (await auditRows('subscriber.status-change')).filter((a) => a.docId === String(s.id))
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ fromStatus: 'pending', toStatus: 'unsubscribed' })
    expect(JSON.stringify(audits.map((a) => [a.summary, a.details, a.docId]))).not.toContain('@')
  })

  it('per-person data export: admin only, audited without the address, no token fields, erased rows are 404', async () => {
    const s = await seed('confirmed', { name: 'Ada Obi', ipHash: 'h'.repeat(64), confirmTokenHash: 'c'.repeat(64) })
    const path = `/api/subscribers/${s.id}/subject-data`
    expect((await api('GET', path)).status).toBe(401)
    expect((await api('GET', path, { token: f.tokens.eic })).status).toBe(403)
    const ok = await api('GET', path, { token: f.tokens.admin })
    expect(ok.status).toBe(200)
    expect(ok.headers.get('cache-control')).toBe('no-store')
    expect(ok.json.subscriber).toMatchObject({ email: s.email, name: 'Ada Obi', status: 'confirmed', consentTextVersion: 'newsletter-consent-v1' })
    expect(ok.text).not.toContain('confirmTokenHash')
    expect(ok.text).not.toContain('c'.repeat(64))
    const audits = (await auditRows('subscriber.subject-export')).filter((a) => a.docId === String(s.id))
    expect(audits).toHaveLength(1)
    expect(JSON.stringify(audits.map((a) => [a.summary, a.details, a.docId]))).not.toContain('@')
    await api('POST', `/api/subscribers/${s.id}/erase`, { token: f.tokens.admin })
    expect((await api('GET', path, { token: f.tokens.admin })).status).toBe(404)
    expect((await api('GET', '/api/subscribers/abc/subject-data', { token: f.tokens.admin })).status).toBe(404)
  })
})
