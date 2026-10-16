import { createHash } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { resetContactLimiters } from '../../src/endpoints/publicContact'
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
const RECIPIENT_A = `desk-${runId}@example.test`
const RECIPIENT_B = `editor-${runId}@example.test`
let f: Fixtures
let mail: MailCapture
let ipCounter = 0
const nextIp = () => `10.${Math.floor(ipCounter / 250)}.${(ipCounter += 1) % 250}.${Math.floor(Math.random() * 200) + 1}`

const savedEnv = { ...process.env }

beforeAll(async () => {
  process.env.SMTP_HOST = 'smtp.stub.example.test' // only says "SMTP is configured"; sendEmail is stubbed below
  process.env.CONTACT_NOTIFY_TO = `${RECIPIENT_A}, ${RECIPIENT_B}`
  process.env.CONTACT_RATE_LIMIT = '5'
  process.env.CONTACT_RATE_WINDOW_SECONDS = '900'
  resetContactLimiters()
  installActionTurnstileStub()
  f = await setupFixtures(runId)
  mail = installMailCapture(f.payload)
})

afterAll(async () => {
  removeActionTurnstileStub()
  mail?.restore()
  await f?.payload
    .delete({ collection: 'contact-messages', where: { email: { like: runId } }, overrideAccess: true })
    .catch(() => undefined)
  await f?.payload
    .delete({ collection: 'audit-logs', where: { collection: { equals: 'contact-messages' } }, overrideAccess: true })
    .catch(() => undefined)
  await f?.cleanup()
  process.env.SMTP_HOST = savedEnv.SMTP_HOST
  process.env.CONTACT_NOTIFY_TO = savedEnv.CONTACT_NOTIFY_TO
  if (savedEnv.SMTP_HOST === undefined) delete process.env.SMTP_HOST
  if (savedEnv.CONTACT_NOTIFY_TO === undefined) delete process.env.CONTACT_NOTIFY_TO
})

let n = 0
const valid = (extra: Record<string, unknown> = {}) => ({
  name: 'Ada Obi',
  email: `ada${n}-${runId}@example.test`,
  topic: 'general',
  message: `${runId} Hello, we would like to ask about the harvest festival coverage ${++n}.`,
  turnstileToken: tsToken('contact-message'),
  ...extra,
})

const send = (
  body: unknown,
  opts: { ip?: string; origin?: string; contentType?: string; raw?: string; headers?: Record<string, string> } = {},
) =>
  api('POST', '/api/public/contact', {
    body: opts.raw ?? body,
    headers: {
      'x-forwarded-for': opts.ip ?? nextIp(),
      'user-agent': 'vitest-agent',
      ...(opts.contentType ? { 'content-type': opts.contentType } : {}),
      ...(opts.origin ? { origin: opts.origin } : {}),
      ...opts.headers,
    },
  })

const findByEmail = async (email: string) =>
  (
    await f.payload.find({
      collection: 'contact-messages',
      where: { email: { equals: email } },
      limit: 5,
      depth: 0,
      overrideAccess: true,
    })
  ).docs as Array<Record<string, any>>

describe('POST /api/public/contact', () => {
  it('stores a valid message, hashes the IP, notifies staff with Reply-To = sender and never leaks the recipients', async () => {
    const ip = '203.0.113.88'
    const payload = valid({ topic: 'corrections' })
    const before = mail.sent.length
    const res = await send(payload, { ip, origin: ALLOWED })
    expect(res.status).toBe(201)
    expect(res.json).toEqual({
      ok: true,
      reference: expect.stringMatching(/^MSG-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/),
      message: 'Received. We will reply by email.',
    })
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED)
    expect(res.headers.get('access-control-expose-headers')).toBe('Retry-After')

    const [doc] = await findByEmail(payload.email)
    expect(doc).toBeTruthy()
    expect(doc!.reference).toBe(res.json.reference)
    expect(doc!.status).toBe('new')
    expect(doc!.topic).toBe('corrections')
    expect(doc!.notifyStatus).toBe('sent')
    expect(doc!.userAgent).toBe('vitest-agent')
    expect(doc!.ipHash).toBe(createHash('sha256').update(process.env.IP_HASH_SALT + ip).digest('hex'))
    expect(doc!.contentHash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(doc)).not.toContain(ip)

    // STUB mail transport: what the CMS handed to the mailer.
    expect(mail.sent.length).toBe(before + 1)
    const m = mail.sent[mail.sent.length - 1]!
    expect(m.to).toBe(`${RECIPIENT_A}, ${RECIPIENT_B}`)
    expect(m.replyTo).toBe(payload.email)
    expect(m.subject).toContain(res.json.reference)
    expect(m.text).toContain(payload.message)

    expect(res.text).not.toContain(RECIPIENT_A)
    expect(res.text).not.toContain(RECIPIENT_B)
    expect(JSON.stringify([...res.headers])).not.toContain(runId)
  })

  it('validates every field with per-field errors', async () => {
    const empty = await send({ turnstileToken: tsToken('contact-message') })
    expect(empty.status).toBe(400)
    expect(empty.json.errors.map((e: any) => e.field).sort()).toEqual(['email', 'message', 'name', 'topic'])

    const cases: Array<[string, Record<string, unknown>]> = [
      ['name', { name: 'A' }],
      ['name', { name: 'N'.repeat(121) }],
      ['email', { email: 'not-an-email' }],
      ['topic', { topic: 'politics' }],
      ['topic', { topic: ['general'] }],
      ['message', { message: 'too short' }],
      ['message', { message: 'm'.repeat(5001) }],
      ['message', { message: '<script>alert(1)</script>short' }],
    ]
    for (const [field, patch] of cases) {
      const res = await send(valid(patch))
      expect(res.status, JSON.stringify(patch).slice(0, 60)).toBe(400)
      expect(res.json.errors).toEqual(expect.arrayContaining([expect.objectContaining({ field })]))
    }
    const notObject = await send(undefined, { contentType: 'application/json', raw: '[1,2]' })
    expect(notObject.status).toBe(400)
    const bad = await send(undefined, { contentType: 'application/json', raw: '{nope' })
    expect(bad.status).toBe(400)
  })

  it('accepts the boundary lengths (name 2 and 120, message 20 and 5000)', async () => {
    const min = await send(valid({ name: 'Al', message: `${runId} twenty chars xx`.slice(0, 20).padEnd(20, 'x') }))
    expect(min.status).toBe(201)
    const max = await send(valid({ name: 'N'.repeat(120), message: `${runId} `.padEnd(5000, 'm') }))
    expect(max.status).toBe(201)
  })

  it('ignores server-owned fields supplied by the client', async () => {
    const payload = valid({ status: 'replied', reference: 'MSG-AAAAAAAA', ipHash: 'x', contentHash: 'y', notifyStatus: 'failed' })
    const res = await send(payload)
    expect(res.status).toBe(201)
    const [doc] = await findByEmail(payload.email)
    expect(doc!.status).toBe('new')
    expect(doc!.reference).toBe(res.json.reference)
    expect(doc!.reference).not.toBe('MSG-AAAAAAAA')
    expect(doc!.ipHash).not.toBe('x')
    expect(doc!.contentHash).not.toBe('y')
  })

  it('strips CR/LF from every header-bound value and rejects injection through the address', async () => {
    const before = mail.sent.length
    const payload = valid({ name: 'Ada\r\nBcc: attacker@example.test\r\nX-Evil: 1' })
    const res = await send(payload)
    expect(res.status).toBe(201)
    const m = mail.sent[before]!
    expect(m.subject).not.toMatch(/[\r\n]/)
    expect(m.replyTo).not.toMatch(/[\r\n]/)
    expect(String(m.to)).not.toMatch(/[\r\n]/)
    expect(Object.keys(m)).not.toContain('bcc')
    expect(Object.keys(m)).not.toContain('cc')
    expect(Object.keys(m).sort()).toEqual(['replyTo', 'subject', 'text', 'to'])
    const stored = (await findByEmail(payload.email))[0]!
    expect(stored.name).not.toMatch(/[\r\n]/)

    for (const email of [
      `ada-${runId}@example.test\r\nBcc: attacker@example.test`,
      `ada-${runId}@example.test\nBcc: attacker@example.test`,
      `ada-${runId}@example.test,attacker@example.test`,
      `"Ada" <ada-${runId}@example.test>`,
    ]) {
      const bad = await send(valid({ email }))
      expect(bad.status, JSON.stringify(email)).toBe(400)
    }
    expect(mail.sent.length).toBe(before + 1)
  })

  it('a honeypot hit answers a normal 201, stores nothing, sends nothing and skips Siteverify', async () => {
    const payload = valid({ website: 'http://spam.example.test' })
    const before = { mail: mail.sent.length, calls: siteverifyCalls.length }
    const res = await send(payload)
    expect(res.status).toBe(201)
    expect(res.json.ok).toBe(true)
    expect(res.json.reference).toMatch(/^MSG-/)
    expect(await findByEmail(payload.email)).toHaveLength(0)
    const refs = await f.payload.find({
      collection: 'contact-messages',
      where: { reference: { equals: res.json.reference } },
      overrideAccess: true,
    })
    expect(refs.docs).toHaveLength(0)
    expect(mail.sent.length).toBe(before.mail)
    expect(siteverifyCalls.length).toBe(before.calls)
    // whitespace-only is not a honeypot hit
    const blank = await send(valid({ website: '   ' }))
    expect(blank.status).toBe(201)
    const stored = await f.payload.find({
      collection: 'contact-messages',
      where: { reference: { equals: blank.json.reference } },
      overrideAccess: true,
    })
    expect(stored.docs).toHaveLength(1)
  })

  it('requires a valid Turnstile token bound to the contact-message action', async () => {
    const before = mail.sent.length
    const missing = await send(valid({ turnstileToken: undefined }))
    expect(missing.status).toBe(400)
    expect(missing.json.errors[0].field).toBe('turnstileToken')

    const rejected = valid({ turnstileToken: TS_BAD })
    const bad = await send(rejected)
    expect(bad.status).toBe(403)
    expect(await findByEmail(rejected.email)).toHaveLength(0)

    // A token minted for another endpoint's widget is refused even if both actions are allowlisted.
    const replay = valid({ turnstileToken: tsToken('newsletter-subscribe') })
    const wrong = await send(replay)
    expect(wrong.status).toBe(403)
    expect(await findByEmail(replay.email)).toHaveLength(0)

    // cf-turnstile-response alias works
    const alias = valid({ turnstileToken: undefined, 'cf-turnstile-response': tsToken('contact-message') })
    expect((await send(alias)).status).toBe(201)
    expect(mail.sent.length).toBe(before + 1)
  })

  it('accepts the action when TURNSTILE_EXPECTED_ACTION lists it, and refuses it when it does not', async () => {
    const saved = process.env.TURNSTILE_EXPECTED_ACTION
    try {
      process.env.TURNSTILE_EXPECTED_ACTION = 'submit-story,contact-message,newsletter-subscribe'
      expect((await send(valid())).status).toBe(201)
      process.env.TURNSTILE_EXPECTED_ACTION = 'submit-story'
      expect((await send(valid())).status).toBe(403)
    } finally {
      if (saved === undefined) delete process.env.TURNSTILE_EXPECTED_ACTION
      else process.env.TURNSTILE_EXPECTED_ACTION = saved
    }
  })

  it('still stores the message and answers the normal 201 when sending the notification fails', async () => {
    const payload = valid()
    mail.failNext()
    const before = mail.sent.length
    const res = await send(payload)
    expect(res.status).toBe(201)
    expect(res.json.ok).toBe(true)
    expect(res.text).not.toContain(RECIPIENT_A)
    expect(res.text).not.toContain('stub SMTP failure')
    expect(mail.sent.length).toBe(before)
    const [doc] = await findByEmail(payload.email)
    expect(doc).toBeTruthy()
    expect(doc!.notifyStatus).toBe('failed')
    expect(doc!.status).toBe('new')
  })

  it('still stores the message when SMTP or CONTACT_NOTIFY_TO is missing', async () => {
    const smtp = process.env.SMTP_HOST
    const to = process.env.CONTACT_NOTIFY_TO
    const before = mail.sent.length
    try {
      delete process.env.SMTP_HOST
      const a = valid()
      expect((await send(a)).status).toBe(201)
      expect((await findByEmail(a.email))[0]!.notifyStatus).toBe('not-configured')

      process.env.SMTP_HOST = smtp
      process.env.CONTACT_NOTIFY_TO = ''
      const b = valid()
      expect((await send(b)).status).toBe(201)
      expect((await findByEmail(b.email))[0]!.notifyStatus).toBe('not-configured')
    } finally {
      process.env.SMTP_HOST = smtp
      process.env.CONTACT_NOTIFY_TO = to
    }
    expect(mail.sent.length).toBe(before)
  })

  it('rejects the same message from the same address within 72 hours with 409', async () => {
    const payload = valid()
    expect((await send(payload)).status).toBe(201)
    const again = await send({ ...payload, message: `  ${payload.message.toUpperCase()}  ` })
    expect(again.status).toBe(409)
    expect(again.json.ok).toBe(false)
    expect(await findByEmail(payload.email)).toHaveLength(1)
    // same address, different message: fine. Same message, other address: fine.
    expect((await send({ ...payload, message: `${payload.message} And one more thing.` })).status).toBe(201)
    expect((await send({ ...payload, email: `other-${runId}-${n++}@example.test` })).status).toBe(201)
  })

  it('limits each IP (CONTACT_RATE_LIMIT) with Retry-After exposed to the allowlisted origin', async () => {
    const ip = nextIp()
    for (let i = 0; i < 5; i++) expect((await send(valid(), { ip })).status).toBe(201)
    const res = await send(valid(), { ip, origin: ALLOWED })
    expect(res.status).toBe(429)
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
    expect(res.headers.get('access-control-expose-headers')).toBe('Retry-After')
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED)
    // a different client address is unaffected
    expect((await send(valid())).status).toBe(201)
  })

  it('limits each address to 3 per hour with Retry-After', async () => {
    const email = `busy-${runId}@example.test`
    for (let i = 0; i < 3; i++) {
      expect((await send(valid({ email }))).status).toBe(201)
    }
    const res = await send(valid({ email }))
    expect(res.status).toBe(429)
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
    expect(res.json.errors[0].message).toMatch(/email address/)
  })

  it('refuses a wrong content type (415), oversized bodies (413), unlisted origins (403) and answers the preflight', async () => {
    expect((await send(undefined, { contentType: 'text/plain', raw: JSON.stringify(valid()) })).status).toBe(415)
    expect((await send(valid({ message: 'x'.repeat(17 * 1024) }))).status).toBe(413)
    const declared = await api('POST', '/api/public/contact', {
      body: JSON.stringify(valid()),
      headers: { 'content-type': 'application/json', 'content-length': String(17 * 1024), 'x-forwarded-for': nextIp() },
    })
    expect(declared.status).toBe(413)

    const bad = await send(valid(), { origin: 'http://evil.test' })
    expect(bad.status).toBe(403)
    expect(bad.headers.get('access-control-allow-origin')).toBeNull()

    const pre = await api('OPTIONS', '/api/public/contact', { headers: { origin: ALLOWED } })
    expect(pre.status).toBe(204)
    expect(pre.headers.get('access-control-allow-origin')).toBe(ALLOWED)
    expect(pre.headers.get('access-control-expose-headers')).toBe('Retry-After')
    const preBad = await api('OPTIONS', '/api/public/contact', { headers: { origin: 'http://evil.test' } })
    expect(preBad.status).toBe(403)
  })
})

describe('contact-messages collection access', () => {
  it('is staff-only (admin and editor-in-chief), never anonymous, and not writable over REST', async () => {
    const payload = valid()
    const created = await send(payload)
    expect(created.status).toBe(201)
    const [doc] = await findByEmail(payload.email)

    const anon = await api('GET', '/api/contact-messages')
    expect([401, 403]).toContain(anon.status)
    expect(anon.text).not.toContain(payload.email)
    const anonOne = await api('GET', `/api/contact-messages/${doc!.id}`)
    expect([401, 403, 404]).toContain(anonOne.status)

    for (const role of ['reporter', 'trusted', 'sectionEditor'] as const) {
      const list = await api('GET', '/api/contact-messages', { token: f.tokens[role] })
      expect(list.status, role).toBe(403)
      const one = await api('GET', `/api/contact-messages/${doc!.id}`, { token: f.tokens[role] })
      expect([403, 404], role).toContain(one.status)
    }
    for (const role of ['eic', 'admin'] as const) {
      const one = await api('GET', `/api/contact-messages/${doc!.id}`, { token: f.tokens[role] })
      expect(one.status, role).toBe(200)
      expect(one.json.email).toBe(payload.email)
    }

    const direct = await api('POST', '/api/contact-messages', { token: f.tokens.admin, body: valid() })
    expect(direct.status).toBe(403)
  })

  it('lets the editor-in-chief triage the status but not rewrite the message', async () => {
    const payload = valid()
    await send(payload)
    const [doc] = await findByEmail(payload.email)
    const ok = await api('PATCH', `/api/contact-messages/${doc!.id}`, {
      token: f.tokens.eic,
      body: { status: 'replied', message: 'Rewritten by staff, which must not be possible.', reference: 'MSG-ZZZZZZZZ' },
    })
    expect(ok.status).toBe(200)
    const after = (await findByEmail(payload.email))[0]!
    expect(after.status).toBe('replied')
    expect(after.message).toBe(payload.message)
    expect(after.reference).toBe(doc!.reference)

    const sectionEditor = await api('PATCH', `/api/contact-messages/${doc!.id}`, {
      token: f.tokens.sectionEditor,
      body: { status: 'spam' },
    })
    expect(sectionEditor.status).toBe(403)
  })
})
