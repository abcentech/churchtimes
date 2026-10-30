import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('payload', async (importOriginal) => {
  const actual = await importOriginal<typeof import('payload')>()
  return { ...actual, createLocalReq: vi.fn(async (opts: { context?: unknown }, payload: unknown) => ({ payload, context: opts.context })) }
})
const lockCalls: string[] = []
vi.mock('../../src/lib/dbTransaction', () => ({
  advisoryTransactionLock: vi.fn(async (_req: unknown, key: string) => {
    lockCalls.push(key)
    return true
  }),
}))

const { DailyMailCap } = await import('../../src/lib/mailer')
const { signUnsubscribeToken, verifyUnsubscribeToken } = await import('../../src/lib/newsletter')
const { buildOneClickUrl, buildTodaysDigest, createDigestDraft, fetchDevotional, resetDigestMemo, resolveOneClickBase, runScheduledDigest, sendDigest } = await import(
  '../../src/lib/newsletterDigestRunner'
)
const { normaliseDigestSettings } = await import('../../src/lib/newsletterDigest')

type Row = Record<string, unknown> & { id: number }
type Where = Record<string, unknown>

function matches(row: Row, where: Where | undefined): boolean {
  if (!where) return true
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'and') return (cond as Where[]).every((w) => matches(row, w))
    const c = cond as Record<string, unknown>
    const v = row[key] as string | number
    if ('equals' in c) return v === c.equals
    if ('in' in c) return (c.in as unknown[]).includes(v)
    if ('greater_than' in c) return v > (c.greater_than as string | number)
    if ('greater_than_equal' in c) return v >= (c.greater_than_equal as string | number)
    if ('less_than' in c) return v < (c.less_than as string | number)
    if ('less_than_equal' in c) return v <= (c.less_than_equal as string | number)
    throw new Error(`unsupported where ${JSON.stringify(c)}`)
  })
}

function fakePayload(init: { settings?: Record<string, unknown> | null; articles?: Row[]; subscribers?: Row[]; issues?: Row[] }) {
  const db: Record<string, Row[]> = {
    articles: init.articles ?? [],
    subscribers: init.subscribers ?? [],
    'newsletter-issues': init.issues ?? [],
    'audit-logs': [],
  }
  let nextId = 1000
  const sent: Array<Record<string, unknown>> = []
  const payload = {
    sendFails: 0,
    sent,
    db: Object.assign(db, {
      beginTransaction: vi.fn(async () => 'tx1'),
      commitTransaction: vi.fn(async () => undefined),
      rollbackTransaction: vi.fn(async () => undefined),
    }),
    logger: { info: vi.fn(), error: vi.fn() },
    findGlobal: vi.fn(async () => {
      if (init.settings === null) throw new Error('global not found')
      return init.settings ?? {}
    }),
    find: vi.fn(async (args: { collection: string; where?: Where; sort?: string; limit?: number }) => {
      let rows = db[args.collection]!.filter((r) => matches(r, args.where))
      if (args.sort) {
        const desc = args.sort.startsWith('-')
        const field = args.sort.replace(/^-/, '')
        rows = [...rows].sort((a, b) => ((a[field] as number) > (b[field] as number) ? 1 : -1) * (desc ? -1 : 1))
      }
      const limit = args.limit ?? 10
      return { docs: rows.slice(0, limit), hasNextPage: rows.length > limit }
    }),
    create: vi.fn(async (args: { collection: string; data: Record<string, unknown> }) => {
      const row = { id: nextId++, ...args.data }
      db[args.collection]!.push(row)
      return row
    }),
    update: vi.fn(async (args: { collection: string; id: number; data: Record<string, unknown> }) => {
      const row = db[args.collection]!.find((r) => r.id === args.id)!
      Object.assign(row, args.data)
      return row
    }),
    sendEmail: vi.fn(async (message: Record<string, unknown>) => {
      if (payload.sendFails > 0) {
        payload.sendFails -= 1
        throw Object.assign(new Error('relay said no to reader@example.org'), { code: 'EAUTH' })
      }
      sent.push(message)
    }),
  }
  return payload
}

const NOW = new Date('2026-10-30T06:30:00Z') // 07:30 in Lagos
const articles: Row[] = [
  { id: 1, slug: 'synod-opens', title: 'Synod opens in Ibadan', excerpt: 'Delegates gather.', status: 'published', publishedAt: '2026-10-30T05:00:00.000Z', category: { title: 'Church' } },
  { id: 2, slug: 'school-fees', title: 'Mission schools review fees', excerpt: 'Parents respond.', status: 'published', publishedAt: '2026-10-29T15:00:00.000Z', category: { title: 'Education' } },
  { id: 3, slug: 'draft-only', title: 'Draft', status: 'draft', publishedAt: '2026-10-30T05:30:00.000Z' },
  { id: 4, slug: 'old-news', title: 'Old', status: 'published', publishedAt: '2026-10-20T05:00:00.000Z' },
]
const subscribers: Row[] = [
  { id: 11, email: 'a@example.org', status: 'confirmed' },
  { id: 12, email: 'b@example.org', status: 'pending' },
  { id: 13, email: 'c@example.org', status: 'unsubscribed' },
  { id: 14, email: 'd@example.org', status: 'confirmed' },
  { id: 15, email: 'e@example.org', status: 'bounced' },
  { id: 16, email: 'f@example.org', status: 'confirmed' },
]
const on = { enabled: true, dailyDigestEnabled: true, sendHourLagos: 7, dailySendCap: 100 }
const env = {
  NODE_ENV: 'test',
  SMTP_HOST: 'smtp.example.org',
  PUBLIC_SITE_URL: 'https://churchtimesnigeria.net',
  CMS_PUBLIC_URL: 'https://cms.churchtimesnigeria.net',
  NEWSLETTER_TOKEN_SECRET: 's'.repeat(40),
  NEWSLETTER_DIGEST_THROTTLE_MS: '0',
} as unknown as NodeJS.ProcessEnv
const noSleep = async () => undefined

beforeEach(() => {
  resetDigestMemo()
  lockCalls.length = 0
})
afterEach(() => resetDigestMemo())

describe('one-click URL base', () => {
  it('requires https (loopback http only outside production)', () => {
    expect(resolveOneClickBase({ CMS_PUBLIC_URL: 'https://cms.example.org/admin' } as never)).toBe('https://cms.example.org')
    expect(resolveOneClickBase({ CMS_PUBLIC_URL: 'http://cms.example.org' } as never)).toBeNull()
    expect(resolveOneClickBase({ CMS_PUBLIC_URL: 'http://localhost:3200', NODE_ENV: 'development' } as never)).toBe('http://localhost:3200')
    expect(resolveOneClickBase({ CMS_PUBLIC_URL: 'http://localhost:3200', NODE_ENV: 'production' } as never)).toBeNull()
    expect(resolveOneClickBase({ CMS_PUBLIC_URL: 'https://u:p@cms.example.org' } as never)).toBeNull()
    expect(resolveOneClickBase({} as never)).toBeNull()
    expect(buildOneClickUrl('https://c.test', 'u1.5.a/b')).toBe('https://c.test/api/public/newsletter/one-click?token=u1.5.a%2Fb')
  })
})

describe('scheduled digest', () => {
  it('does nothing while the CMS settings are off or missing (default)', async () => {
    for (const settings of [null, {}, { enabled: true }, { dailyDigestEnabled: true }]) {
      resetDigestMemo()
      const p = fakePayload({ settings, articles, subscribers })
      expect((await runScheduledDigest(p as never, { now: NOW, env })).outcome).toBe('disabled')
      expect(p.create).not.toHaveBeenCalled()
      expect(p.sendEmail).not.toHaveBeenCalled()
    }
  })

  it('waits for sendHourLagos', async () => {
    const p = fakePayload({ settings: { ...on, sendHourLagos: 8 }, articles, subscribers })
    expect((await runScheduledDigest(p as never, { now: NOW, env })).outcome).toBe('not-due')
  })

  it('is a dry run (draft, nothing sent) until NEWSLETTER_DIGEST_SEND=true, once per day', async () => {
    const p = fakePayload({ settings: on, articles, subscribers })
    const first = await runScheduledDigest(p as never, { now: NOW, env })
    expect(first).toMatchObject({ outcome: 'draft', stories: 2 })
    expect(p.sendEmail).not.toHaveBeenCalled()
    const issue = p.db['newsletter-issues'][0]!
    expect(issue).toMatchObject({ status: 'draft', sentCount: 0, capApplied: false })
    expect(String(issue.bodyText)).toContain('Synod opens in Ibadan')
    expect(String(issue.bodyText)).not.toContain('token=')
    resetDigestMemo() // even in a fresh process the stored draft prevents a second one today
    expect((await runScheduledDigest(p as never, { now: new Date(NOW.getTime() + 60_000), env })).outcome).toBe('already-done')
    expect(p.db['newsletter-issues']).toHaveLength(1)
  })

  it('sends to confirmed subscribers only, one per message, with signed links and one-click headers', async () => {
    const p = fakePayload({ settings: on, articles, subscribers })
    const result = await runScheduledDigest(p as never, { now: NOW, env: { ...env, NEWSLETTER_DIGEST_SEND: 'true' }, cap: new DailyMailCap(() => 50), sleep: noSleep })
    expect(result).toMatchObject({ outcome: 'sent', sent: 3, failed: 0, capApplied: false, stories: 2 })
    expect(lockCalls).toEqual(['newsletter-digest'])
    expect(p.sent.map((m) => m.to)).toEqual(['a@example.org', 'd@example.org', 'f@example.org'])
    const first = p.sent[0]!
    const headers = first.headers as Record<string, string>
    const token = /token=([^>&\s]+)/.exec(headers['List-Unsubscribe']!)![1]!
    expect(verifyUnsubscribeToken(decodeURIComponent(token), 's'.repeat(40))).toBe('11')
    expect(headers['List-Unsubscribe']).toBe(`<${buildOneClickUrl('https://cms.churchtimesnigeria.net', signUnsubscribeToken(11, 's'.repeat(40)))}>`)
    expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
    expect(headers['List-Id']).toBe('<daily-digest.churchtimesnigeria.net>')
    expect(String(first.text)).toContain(`https://churchtimesnigeria.net/newsletter/unsubscribe?token=${encodeURIComponent(signUnsubscribeToken(11, 's'.repeat(40)))}`)
    expect(String(first.html)).toContain('Synod opens in Ibadan')
    // each reader gets only their own token
    expect(String(p.sent[1]!.text)).not.toContain(encodeURIComponent(signUnsubscribeToken(11, 's'.repeat(40))))
    expect(p.db['newsletter-issues'][0]).toMatchObject({ status: 'sent', sentCount: 3, failedCount: 0, capApplied: false, lastError: null })
    // second tick the same day: nothing more
    resetDigestMemo()
    expect((await runScheduledDigest(p as never, { now: NOW, env: { ...env, NEWSLETTER_DIGEST_SEND: 'true' }, sleep: noSleep })).outcome).toBe('already-done')
    expect(p.sent).toHaveLength(3)
  })

  it('applies dailySendCap as a hard stop and records it', async () => {
    const p = fakePayload({ settings: { ...on, dailySendCap: 2 }, articles, subscribers })
    const r = await sendDigest(p as never, normaliseDigestSettings({ ...on, dailySendCap: 2 }), { now: NOW, env, cap: new DailyMailCap(() => 50), sleep: noSleep })
    expect(r).toMatchObject({ outcome: 'sent', sent: 2, capApplied: true })
    expect(p.sent.map((m) => m.to)).toEqual(['a@example.org', 'd@example.org'])
    expect(p.db['newsletter-issues'][0]).toMatchObject({ capApplied: true, sentCount: 2 })
  })

  it('a cap of 0 sends nothing; the per-process cap also stops the run', async () => {
    const zero = fakePayload({ settings: on, articles, subscribers })
    expect(await sendDigest(zero as never, normaliseDigestSettings({ ...on, dailySendCap: 0 }), { now: NOW, env, sleep: noSleep })).toMatchObject({ sent: 0, capApplied: true })
    expect(zero.sendEmail).not.toHaveBeenCalled()
    const proc = fakePayload({ settings: on, articles, subscribers })
    const r = await sendDigest(proc as never, normaliseDigestSettings(on), { now: NOW, env, cap: new DailyMailCap(() => 1), sleep: noSleep })
    expect(r).toMatchObject({ sent: 1, capApplied: true })
    expect(proc.db['newsletter-issues'][0]!.lastError).toMatch(/MAIL_HTML_DAILY_CAP/)
  })

  it('records relay failures without addresses and stops after 5 consecutive errors', async () => {
    const many: Row[] = Array.from({ length: 8 }, (_, i) => ({ id: 100 + i, email: `r${i}@example.org`, status: 'confirmed' }))
    const p = fakePayload({ settings: on, articles, subscribers: many })
    p.sendFails = 99
    const r = await sendDigest(p as never, normaliseDigestSettings(on), { now: NOW, env, cap: new DailyMailCap(() => 50), sleep: noSleep })
    expect(r).toMatchObject({ outcome: 'failed', sent: 0, failed: 5 })
    const issue = p.db['newsletter-issues'][0]!
    expect(issue.status).toBe('failed')
    expect(String(issue.lastError)).toMatch(/consecutive relay errors.*EAUTH/)
    expect(String(issue.lastError)).not.toContain('@')
    // a failed issue is never resumed automatically (no duplicates for readers already mailed)
    resetDigestMemo()
    p.sendFails = 0
    expect((await runScheduledDigest(p as never, { now: NOW, env: { ...env, NEWSLETTER_DIGEST_SEND: 'true' }, sleep: noSleep })).outcome).toBe('already-done')
  })

  it('refuses to send without SMTP, public site URL, token secret or CMS URL', async () => {
    for (const missing of ['SMTP_HOST', 'PUBLIC_SITE_URL', 'CMS_PUBLIC_URL']) {
      const p = fakePayload({ settings: on, articles, subscribers })
      const partial = { ...env, [missing]: '' } as NodeJS.ProcessEnv
      expect((await sendDigest(p as never, normaliseDigestSettings(on), { now: NOW, env: partial, sleep: noSleep })).outcome).toBe('not-configured')
      expect(p.create).not.toHaveBeenCalled()
    }
  })

  it('skips the day when nothing new was published since the previous issue', async () => {
    const p = fakePayload({
      settings: on,
      articles,
      subscribers,
      issues: [{ id: 1, date: '2026-10-29T16:00:00.000Z', status: 'sent', sentCount: 3 }],
    })
    // previous issue (yesterday) ran after story 2; only story 1 is new
    const draft = await createDigestDraft(p as never, { now: NOW, env })
    expect(draft).toMatchObject({ outcome: 'draft', stories: 1 })
    const none = fakePayload({ settings: on, articles: [articles[3]!], subscribers })
    expect((await createDigestDraft(none as never, { now: NOW, env })).outcome).toBe('no-stories')
  })
})

describe('verse of the day in the digest', () => {
  const verse = { ok: true, date: '2026-10-30', reference: 'Luke 2:10–11', text: 'And the angel said unto them, Fear not', version: 'KJV' }
  const respond = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

  it('reads the public site route and accepts only matching KJV data', async () => {
    const f = respond(verse)
    expect(await fetchDevotional('https://churchtimesnigeria.net', '2026-10-30', f)).toEqual({ reference: 'Luke 2:10–11', text: 'And the angel said unto them, Fear not', version: 'KJV' })
    expect((f as unknown as { mock: { calls: string[][] } }).mock.calls[0]![0]).toBe('https://churchtimesnigeria.net/scripture/verse-of-the-day.json?date=2026-10-30')
    expect(await fetchDevotional('https://x.test', '2026-10-30', respond({ ...verse, version: 'NIV' }))).toBeNull()
    expect(await fetchDevotional('https://x.test', '2026-10-30', respond({ ...verse, date: '2026-10-29' }))).toBeNull()
    expect(await fetchDevotional('https://x.test', '2026-10-30', respond({ ...verse, reference: '<script>' }))).toBeNull()
    expect(await fetchDevotional('https://x.test', '2026-10-30', respond(verse, 503))).toBeNull()
    expect(await fetchDevotional('https://x.test', '2026-10-30', vi.fn(async () => Promise.reject(new Error('down'))) as never)).toBeNull()
  })

  it('is fetched only when includeDevotional is on, and its failure never blocks the digest', async () => {
    const p = fakePayload({ settings: on, articles, subscribers })
    const f = respond(verse)
    const off = await buildTodaysDigest(p as never, normaliseDigestSettings(on), { now: NOW, env, fetchImpl: f })
    expect(off?.devotional).toBeNull()
    expect(f).not.toHaveBeenCalled()
    const withVerse = await buildTodaysDigest(p as never, normaliseDigestSettings({ ...on, includeDevotional: true }), { now: NOW, env, fetchImpl: f })
    expect(withVerse?.devotional?.reference).toBe('Luke 2:10–11')
    const failing = await buildTodaysDigest(p as never, normaliseDigestSettings({ ...on, includeDevotional: true }), { now: NOW, env, fetchImpl: respond({}, 500) })
    expect(failing?.devotional).toBeNull()
    expect(failing?.stories).toHaveLength(2)
  })
})
