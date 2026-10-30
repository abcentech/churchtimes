import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { header, startSmtpSink, type SmtpSink } from './smtpSink'

/**
 * Daily digest end to end on the real schema (newsletter-settings, newsletter-issues, subscribers, articles) and the
 * REAL nodemailer adapter talking SMTP to a local sink (tests/integration/smtpSink.ts). The sink must be listening and
 * SMTP_* set before payload.config.ts is imported, because the config builds the mail adapter at import time.
 */
const sink: SmtpSink = await startSmtpSink()
const env = process.env as Record<string, string | undefined>
const saved = { ...process.env }
env.SMTP_HOST = '127.0.0.1'
env.SMTP_PORT = String(sink.port)
env.SMTP_SECURE = 'false'
env.EMAIL_FROM_ADDRESS = 'news@churchtimes.test'

const { api, newRunId, setupFixtures } = await import('./helpers')
const { resetDigestMemo, runScheduledDigest, sendDigest } = await import('../../src/lib/newsletterDigestRunner')
const { normaliseDigestSettings } = await import('../../src/lib/newsletterDigest')
const { DailyMailCap } = await import('../../src/lib/mailer')
const { resetOneClickLimiter } = await import('../../src/endpoints/newsletterOneClick')
const { resetDigestStaffLimiter } = await import('../../src/endpoints/newsletterDigestStaff')

type F = Awaited<ReturnType<typeof setupFixtures>>
const runId = newRunId()
const SECRET = 'digest-test-only-secret-0123456789abcdef'
let f: F
const subs: Record<string, number> = {}
const ON = { enabled: true, dailyDigestEnabled: true, sendHourLagos: 0, dailySendCap: 100, fromName: 'Church Times Nigeria', maxStoriesPerDigest: 6, includeDevotional: false }

const email = (key: string) => `${key}-${runId}@example.test`
const wipeIssues = () => f.payload.delete({ collection: 'newsletter-issues' as never, where: { id: { exists: true } }, overrideAccess: true })

beforeAll(async () => {
  f = await setupFixtures(runId)
  env.PUBLIC_SITE_URL = 'https://www.churchtimes.test'
  env.CMS_PUBLIC_URL = 'http://localhost:3200' // read at send time only (after the config import), loopback http is allowed outside production
  env.NEWSLETTER_TOKEN_SECRET = SECRET
  env.NEWSLETTER_DIGEST_THROTTLE_MS = '0'
  resetOneClickLimiter()
  resetDigestStaffLimiter()
  await wipeIssues()
  for (const [key, status] of [['alice', 'confirmed'], ['bola', 'confirmed'], ['chidi', 'pending'], ['dayo', 'unsubscribed'], ['efe', 'bounced']] as const) {
    const doc = (await f.payload.create({
      collection: 'subscribers',
      data: { email: email(key), status, source: 'home', consentTextVersion: 'newsletter-consent-v1', consentAt: new Date().toISOString(), importedFrom: 'web' } as never,
      overrideAccess: true,
      context: { subscriberSystemWrite: true },
    })) as { id: number }
    subs[key] = doc.id
  }
  const hourAgo = new Date(Date.now() - 3600_000).toISOString()
  await f.seedArticle({ status: 'published', publishedAt: hourAgo, title: `${runId} Synod opens <b>in</b> Ibadan`, excerpt: 'Delegates gather & pray.' })
  await f.seedArticle({ status: 'published', publishedAt: hourAgo, title: `${runId} Sponsored notice`, contentType: 'sponsored' })
  await f.seedArticle({ status: 'draft', title: `${runId} Not ready` })
})

afterAll(async () => {
  await wipeIssues().catch(() => undefined)
  await f?.payload.updateGlobal({ slug: 'newsletter-settings' as never, data: { enabled: false, dailyDigestEnabled: false } as never, overrideAccess: true }).catch(() => undefined)
  await f?.payload.delete({ collection: 'subscribers', where: { email: { like: runId } }, overrideAccess: true }).catch(() => undefined)
  await f?.payload.delete({ collection: 'audit-logs', where: { collection: { in: ['subscribers', 'newsletter-issues'] } }, overrideAccess: true }).catch(() => undefined)
  await f?.cleanup()
  await sink.close()
  for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'EMAIL_FROM_ADDRESS', 'PUBLIC_SITE_URL', 'CMS_PUBLIC_URL', 'NEWSLETTER_TOKEN_SECRET', 'NEWSLETTER_DIGEST_THROTTLE_MS', 'NEWSLETTER_DIGEST_SEND']) {
    if (saved[k] === undefined) delete env[k]
    else env[k] = saved[k]
  }
})

describe('daily digest on the real schema through SMTP', () => {
  it('stays off with the default settings', async () => {
    resetDigestMemo()
    expect((await runScheduledDigest(f.payload)).outcome).toBe('disabled')
    expect(sink.messages).toHaveLength(0)
  })

  it('a scheduled run is a dry run until NEWSLETTER_DIGEST_SEND=true: one draft, nothing on the wire', async () => {
    await f.payload.updateGlobal({ slug: 'newsletter-settings' as never, data: ON as never, overrideAccess: true })
    resetDigestMemo()
    const r = await runScheduledDigest(f.payload)
    expect(r.outcome).toBe('draft')
    expect(sink.messages).toHaveLength(0)
    const issues = await f.payload.find({ collection: 'newsletter-issues' as never, overrideAccess: true, depth: 0 })
    expect(issues.docs).toHaveLength(1)
    const issue = issues.docs[0] as unknown as Record<string, unknown>
    expect(issue.status).toBe('draft')
    expect(String(issue.bodyHtml)).toContain('Synod opens &lt;b&gt;in&lt;/b&gt; Ibadan')
    expect(String(issue.bodyText)).toContain('[Sponsored]')
    expect(String(issue.bodyText)).not.toContain('Not ready')
  })

  it('sends one multipart mail per confirmed subscriber with RFC 8058 headers, exactly once per day', async () => {
    env.NEWSLETTER_DIGEST_SEND = 'true'
    resetDigestMemo()
    const r = await runScheduledDigest(f.payload, { cap: new DailyMailCap(() => 50) })
    expect(r).toMatchObject({ outcome: 'sent', sent: 2, failed: 0, capApplied: false })
    const mine = sink.messages.filter((m) => m.to.some((t) => t.includes(runId)))
    expect(mine.map((m) => m.to).sort()).toEqual([[email('alice')], [email('bola')]])
    for (const m of mine) {
      expect(header(m.raw, 'Content-Type')).toMatch(/^multipart\/alternative/)
      expect(header(m.raw, 'List-Unsubscribe')).toMatch(/^<http:\/\/localhost:3200\/api\/public\/newsletter\/one-click\?token=u1\.\d+\.[A-Za-z0-9_-]{43}>$/)
      expect(header(m.raw, 'List-Unsubscribe-Post')).toBe('List-Unsubscribe=One-Click')
      expect(header(m.raw, 'List-Id')).toBe('<daily-digest.www.churchtimes.test>')
      expect(header(m.raw, 'From')).toMatch(/Church Times Nigeria.*news@churchtimes\.test/)
      expect(header(m.raw, 'To')).toBe(m.to[0])
      expect(m.raw).not.toMatch(/<script|<img/i)
    }
    const issues = (await f.payload.find({ collection: 'newsletter-issues' as never, where: { status: { equals: 'sent' } }, overrideAccess: true, depth: 0 })).docs as unknown as Array<Record<string, unknown>>
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ sentCount: 2, failedCount: 0, capApplied: false })
    resetDigestMemo()
    expect((await runScheduledDigest(f.payload)).outcome).toBe('already-done')
    expect(sink.messages.filter((m) => m.to.some((t) => t.includes(runId)))).toHaveLength(2)
  })

  it('two concurrent senders produce one issue (advisory lock), and the cap is a hard stop', async () => {
    await wipeIssues()
    const before = sink.messages.length
    const settings = normaliseDigestSettings({ ...ON, dailySendCap: 1 })
    const [a, b] = await Promise.all([
      sendDigest(f.payload, settings, { cap: new DailyMailCap(() => 50) }),
      sendDigest(f.payload, settings, { cap: new DailyMailCap(() => 50) }),
    ])
    expect([a.outcome, b.outcome].sort()).toEqual(['already-done', 'sent'])
    const sent = a.outcome === 'sent' ? a : b
    expect(sent).toMatchObject({ sent: 1, capApplied: true })
    expect(sink.messages.length - before).toBe(1)
  })

  it('relay rejections are counted without addresses in the issue', async () => {
    await wipeIssues()
    sink.rejectNext(2)
    const r = await sendDigest(f.payload, normaliseDigestSettings(ON), { cap: new DailyMailCap(() => 50) })
    expect(r).toMatchObject({ outcome: 'failed', sent: 0, failed: 2 })
    const issue = (await f.payload.find({ collection: 'newsletter-issues' as never, overrideAccess: true, depth: 0 })).docs[0] as unknown as Record<string, unknown>
    expect(issue.status).toBe('failed')
    expect(String(issue.lastError)).not.toContain('@')
  })

  it('the one-click POST from the List-Unsubscribe header unsubscribes at once', async () => {
    const m = sink.messages.find((x) => x.to[0] === email('alice'))!
    const url = new URL(/<([^>]+)>/.exec(header(m.raw, 'List-Unsubscribe')!)![1]!)
    const res = await api('POST', `${url.pathname}${url.search}`, {
      body: 'List-Unsubscribe=One-Click',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '10.99.0.1' },
    })
    expect(res.status).toBe(200)
    const row = (await f.payload.findByID({ collection: 'subscribers', id: subs.alice!, overrideAccess: true, depth: 0 })) as unknown as Record<string, unknown>
    expect(row.status).toBe('unsubscribed')
    expect(row.unsubscribedAt).toBeTruthy()
    // the next digest leaves her out
    await wipeIssues()
    const before = sink.messages.length
    await sendDigest(f.payload, normaliseDigestSettings(ON), { cap: new DailyMailCap(() => 50) })
    expect(sink.messages.slice(before).map((x) => x.to[0])).toEqual([email('bola')])
  })

  it('staff tools: dry run for editors, test send only to the signed-in staff address', async () => {
    await wipeIssues()
    expect((await api('POST', '/api/newsletter/digest/dry-run', { token: f.tokens.reporter })).status).toBe(403)
    const dry = await api('POST', '/api/newsletter/digest/dry-run', { token: f.tokens.eic })
    expect(dry.status).toBe(200)
    expect(dry.json).toMatchObject({ ok: true, outcome: 'draft' })
    const before = sink.messages.length
    const test = await api('POST', '/api/newsletter/digest/test-send', { token: f.tokens.admin, body: { to: 'victim@example.test' } })
    expect(test.status).toBe(200)
    const sent = sink.messages.slice(before)
    expect(sent).toHaveLength(1)
    expect(sent[0]!.to).toEqual([f.users.admin.email])
    expect(header(sent[0]!.raw, 'Subject')).toMatch(/^\[TEST\] /)
    expect(header(sent[0]!.raw, 'List-Unsubscribe')).toBeUndefined()
  })
})
