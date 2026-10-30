import { createLocalReq, type Payload, type PayloadRequest } from 'payload'

import { writeSystemAuditLog } from './audit'
import { advisoryTransactionLock } from './dbTransaction'
import { DailyMailCap, isMailConfigured, lagosDay, MailCapReachedError, processHtmlMailCap, sendHtmlMail } from './mailer'
import { buildUnsubscribeUrl, resolveNewsletterTokenSecret, resolvePublicSiteUrl, signUnsubscribeToken } from './newsletter'
import {
  digestSubject,
  digestWindowStart,
  lagosHour,
  normaliseDigestSettings,
  normaliseDigestStory,
  parseDevotional,
  renderDigestHtml,
  renderDigestText,
  selectDigestStories,
  type DigestContent,
  type DigestSettings,
  type Devotional,
} from './newsletterDigest'
import { resolveArticlePathTemplate } from './redirectPaths'
import { isValidEmail } from './sanitize'
import { safeErrorFields, safeErrorSummary } from './safeLog'

/**
 * Daily digest, the part that touches the database and the relay. Schema (owned by Agent B, see docs/w12/schema-contract.md):
 * global `newsletter-settings`, collection `newsletter-issues` { date, subject, status draft|sending|sent|failed, bodyText,
 * bodyHtml, sentCount, failedCount, capApplied, lastError }.
 *
 * Safety model (docs/w12/growth.md):
 * - nothing is scheduled unless `enabled` AND `dailyDigestEnabled` are on in the CMS (both default off);
 * - even then a scheduled run is a DRY RUN (draft issue, nothing sent) until NEWSLETTER_DIGEST_SEND=true;
 * - only `confirmed` subscribers are mailed, one recipient per message, each with a signed unsubscribe link and RFC 8058
 *   one-click List-Unsubscribe headers;
 * - `dailySendCap` is a hard stop per Lagos day (across issues), with the per-process MAIL_HTML_DAILY_CAP underneath;
 * - at most one live issue per Lagos day: claimed under a PostgreSQL advisory lock, and a `sending` or `failed` issue is
 *   never resumed automatically (no duplicate mail), staff decide.
 * Logs carry counts and ids only: never an address, a token or article text.
 */

export const ISSUES = 'newsletter-issues'
export const SETTINGS = 'newsletter-settings'
const LOCK_KEY = 'newsletter-digest'
const PAGE = 50
const MAX_CONSECUTIVE_FAILURES = 5

export type DigestRunOutcome =
  | 'disabled'
  | 'not-due'
  | 'already-done'
  | 'no-stories'
  | 'not-configured'
  | 'draft'
  | 'sent'
  | 'failed'

export type DigestRunResult = {
  outcome: DigestRunOutcome
  issueId?: number | string
  sent?: number
  failed?: number
  capApplied?: boolean
  stories?: number
  reason?: string
}

type IssueDoc = {
  id: number | string
  date?: string | null
  status?: string | null
  sentCount?: number | null
}

const sendLive = (env: NodeJS.ProcessEnv): boolean => env.NEWSLETTER_DIGEST_SEND === 'true'

const throttleMs = (env: NodeJS.ProcessEnv): number => {
  const raw = env.NEWSLETTER_DIGEST_THROTTLE_MS?.trim() ?? ''
  return /^[0-9]{1,5}$/.test(raw) ? Number(raw) : 250
}

/** CMS_PUBLIC_URL origin for the one-click link (the public host only serves GET). Null when unset or unsafe. */
export function resolveOneClickBase(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.CMS_PUBLIC_URL?.trim()
  if (!raw) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.username || url.password) return null
  if (url.protocol === 'https:') return url.origin
  const local = url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
  return local && env.NODE_ENV !== 'production' ? url.origin : null
}

export const buildOneClickUrl = (cmsOrigin: string, token: string): string =>
  `${cmsOrigin}/api/public/newsletter/one-click?token=${encodeURIComponent(token)}`

/** Start of the Lagos calendar day containing `now`, as a UTC instant. */
export const lagosDayStart = (now: Date): Date => new Date(`${lagosDay(now)}T00:00:00+01:00`)

export async function loadDigestSettings(payload: Payload): Promise<DigestSettings> {
  try {
    const raw = await payload.findGlobal({ slug: SETTINGS as never, depth: 0, overrideAccess: true })
    return normaliseDigestSettings(raw)
  } catch {
    // Global missing (schema not migrated yet) or unreadable: everything stays off.
    return normaliseDigestSettings(null)
  }
}

async function issuesSince(payload: Payload, from: Date, req?: PayloadRequest): Promise<IssueDoc[]> {
  const res = await payload.find({
    collection: ISSUES as never,
    where: { date: { greater_than_equal: from.toISOString() } },
    sort: '-date',
    limit: 100,
    depth: 0,
    overrideAccess: true,
    ...(req ? { req } : {}),
  })
  return res.docs as unknown as IssueDoc[]
}

async function previousSentAt(payload: Payload, before: Date): Promise<Date | null> {
  const res = await payload.find({
    collection: ISSUES as never,
    where: { and: [{ status: { in: ['sent', 'sending'] } }, { date: { less_than: before.toISOString() } }] },
    sort: '-date',
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  const date = (res.docs[0] as unknown as IssueDoc | undefined)?.date
  return date && Number.isFinite(Date.parse(date)) ? new Date(date) : null
}

async function loadStories(payload: Payload, since: Date, now: Date, max: number) {
  const res = await payload.find({
    collection: 'articles',
    where: {
      and: [
        { status: { equals: 'published' } },
        { publishedAt: { greater_than: since.toISOString() } },
        { publishedAt: { less_than_equal: now.toISOString() } },
      ],
    },
    sort: '-publishedAt',
    limit: Math.min(60, max * 4),
    depth: 1,
    overrideAccess: true,
  })
  const stories = res.docs.map(normaliseDigestStory).filter((s): s is NonNullable<typeof s> => Boolean(s))
  return selectDigestStories(stories, since, now, max)
}

export type DigestDeps = {
  now?: Date
  env?: NodeJS.ProcessEnv
  cap?: DailyMailCap
  /** Verse of the day override (tests); by default it is read from the public site when `includeDevotional` is on. */
  devotional?: Devotional | null
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}

/**
 * The site's own verse of the day (public host route `scripture/verse-of-the-day.json`, bundled public-domain KJV).
 * Our own static data, not an external API. Any failure (timeout 4 s) just leaves the verse out of the mail.
 */
export async function fetchDevotional(siteUrl: string, date: string, fetchImpl: typeof fetch = fetch): Promise<Devotional | null> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  try {
    const res = await fetchImpl(`${siteUrl}/scripture/verse-of-the-day.json?date=${date}`, {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(4000),
    })
    if (!res.ok) return null
    return parseDevotional(await res.json(), date)
  } catch {
    return null
  }
}

/** Builds the content of today's issue. Null when there is nothing new to send. */
export async function buildTodaysDigest(
  payload: Payload,
  settings: DigestSettings,
  { now = new Date(), env = process.env, devotional, fetchImpl }: DigestDeps = {},
): Promise<DigestContent | null> {
  const since = digestWindowStart(await previousSentAt(payload, lagosDayStart(now)), now)
  const stories = await loadStories(payload, since, now, settings.maxStoriesPerDigest)
  if (stories.length === 0) return null
  const date = lagosDay(now)
  const siteUrl = resolvePublicSiteUrl(env)
  let verse: Devotional | null = null
  if (settings.includeDevotional) {
    verse = devotional !== undefined ? devotional : siteUrl ? await fetchDevotional(siteUrl, date, fetchImpl) : null
  }
  return { date, stories, siteUrl, template: resolveArticlePathTemplate(env), devotional: verse }
}

/** Generic copy stored on the issue (no recipient token in it). */
function storedBodies(content: DigestContent) {
  const page = content.siteUrl ? `${content.siteUrl}/newsletter/unsubscribe` : 'https://example.invalid/newsletter/unsubscribe'
  return {
    subject: digestSubject(content),
    bodyText: renderDigestText(content, { unsubscribePageUrl: page }),
    bodyHtml: renderDigestHtml(content, { unsubscribePageUrl: page }) as string,
  }
}

/** Dry run: writes a `draft` issue with today's content and sends nothing. */
export async function createDigestDraft(payload: Payload, deps: DigestDeps = {}): Promise<DigestRunResult> {
  const now = deps.now ?? new Date()
  const settings = await loadDigestSettings(payload)
  const content = await buildTodaysDigest(payload, settings, { ...deps, now })
  if (!content) return { outcome: 'no-stories' }
  const doc = (await payload.create({
    collection: ISSUES as never,
    data: { date: now.toISOString(), status: 'draft', sentCount: 0, failedCount: 0, capApplied: false, ...storedBodies(content) } as never,
    overrideAccess: true,
  })) as unknown as IssueDoc
  await writeSystemAuditLog(payload, {
    action: 'newsletter.digest-draft',
    collection: ISSUES,
    docId: doc.id,
    actor: null,
    actorRole: 'system',
    summary: `Digest dry run: ${content.stories.length} stories, nothing sent`,
  }).catch(() => undefined)
  return { outcome: 'draft', issueId: doc.id, stories: content.stories.length }
}

type Claim = { issue: IssueDoc; alreadySentToday: number } | { outcome: DigestRunOutcome }

/** Under the advisory lock: refuse when today already has a live issue, else create it as `sending`. */
async function claimLiveIssue(payload: Payload, now: Date, content: DigestContent): Promise<Claim> {
  const req = await createLocalReq({ context: { newsletterDigest: true } }, payload)
  const tx = (await payload.db.beginTransaction()) as number | string | null
  if (tx === null) return { outcome: 'failed' }
  req.transactionID = tx
  try {
    await advisoryTransactionLock(req, LOCK_KEY)
    const today = await issuesSince(payload, lagosDayStart(now), req)
    if (today.some((i) => i.status === 'sending' || i.status === 'sent' || i.status === 'failed')) {
      await payload.db.commitTransaction(tx)
      return { outcome: 'already-done' }
    }
    const alreadySentToday = today.reduce((n, i) => n + Math.max(0, i.sentCount ?? 0), 0)
    const issue = (await payload.create({
      collection: ISSUES as never,
      data: { date: now.toISOString(), status: 'sending', sentCount: 0, failedCount: 0, capApplied: false, ...storedBodies(content) } as never,
      overrideAccess: true,
      req,
    })) as unknown as IssueDoc
    await payload.db.commitTransaction(tx)
    return { issue, alreadySentToday }
  } catch (err) {
    await payload.db.rollbackTransaction(tx).catch(() => undefined)
    throw err
  }
}

const updateIssue = (payload: Payload, id: number | string, data: Record<string, unknown>) =>
  payload.update({ collection: ISSUES as never, id, data: data as never, overrideAccess: true })

/** Sends today's issue to confirmed subscribers. Called by the scheduler only when every switch is on. */
export async function sendDigest(payload: Payload, settings: DigestSettings, deps: DigestDeps = {}): Promise<DigestRunResult> {
  const now = deps.now ?? new Date()
  const env = deps.env ?? process.env
  const cap = deps.cap ?? processHtmlMailCap
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

  const siteUrl = resolvePublicSiteUrl(env)
  const secret = resolveNewsletterTokenSecret(env)
  const oneClick = resolveOneClickBase(env)
  if (!isMailConfigured(env) || !siteUrl || !secret || !oneClick) {
    return { outcome: 'not-configured', reason: 'SMTP_HOST, PUBLIC_SITE_URL, NEWSLETTER_TOKEN_SECRET and CMS_PUBLIC_URL are all required to send.' }
  }

  const content = await buildTodaysDigest(payload, settings, { ...deps, now, env })
  if (!content) return { outcome: 'no-stories' }

  const claim = await claimLiveIssue(payload, now, content)
  if ('outcome' in claim) return { outcome: claim.outcome }
  const { issue } = claim

  const budget = Math.max(0, settings.dailySendCap - claim.alreadySentToday)
  const subject = digestSubject(content)
  const replyTo = isValidEmail(settings.replyTo) ? settings.replyTo : undefined
  const listId = `daily-digest.${new URL(siteUrl).hostname}`

  let sent = 0
  let failed = 0
  let consecutive = 0
  let capApplied = false
  let lastError = ''
  let afterId: number | null = null

  outer: for (;;) {
    const page = await payload.find({
      collection: 'subscribers',
      where: { and: [{ status: { equals: 'confirmed' } }, ...(afterId !== null ? [{ id: { greater_than: afterId } }] : [])] },
      sort: 'id',
      limit: PAGE,
      depth: 0,
      overrideAccess: true,
    })
    const rows = page.docs as unknown as Array<{ id: number; email?: string; status?: string }>
    if (rows.length === 0) break
    for (const row of rows) {
      afterId = row.id
      if (row.status !== 'confirmed' || !row.email) continue
      if (sent + failed >= budget) {
        capApplied = true
        break outer
      }
      const token = signUnsubscribeToken(row.id, secret)
      const links = { unsubscribePageUrl: buildUnsubscribeUrl(siteUrl, token) }
      try {
        await sendHtmlMail(
          payload,
          {
            to: row.email,
            subject,
            text: renderDigestText(content, links),
            html: renderDigestHtml(content, links),
            fromName: settings.fromName,
            replyTo,
            unsubscribeUrl: buildOneClickUrl(oneClick, token),
            listId,
          },
          { cap, now },
        )
        sent += 1
        consecutive = 0
      } catch (err) {
        if (err instanceof MailCapReachedError) {
          capApplied = true
          lastError = 'Per-process daily mail cap (MAIL_HTML_DAILY_CAP) reached.'
          break outer
        }
        failed += 1
        consecutive += 1
        lastError = `Relay error: ${safeErrorSummary(err)}`.slice(0, 500)
        if (consecutive >= MAX_CONSECUTIVE_FAILURES) {
          lastError = `Stopped after ${MAX_CONSECUTIVE_FAILURES} consecutive relay errors. ${lastError}`.slice(0, 500)
          break outer
        }
      }
      if ((sent + failed) % 25 === 0) await updateIssue(payload, issue.id, { sentCount: sent, failedCount: failed }).catch(() => undefined)
      const pause = throttleMs(env)
      if (pause > 0) await sleep(pause)
    }
    if (!page.hasNextPage) break
  }

  const status = sent === 0 && failed > 0 ? 'failed' : 'sent'
  await updateIssue(payload, issue.id, { status, sentCount: sent, failedCount: failed, capApplied, lastError: lastError || null })
  await writeSystemAuditLog(payload, {
    action: 'newsletter.digest-send',
    collection: ISSUES,
    docId: issue.id,
    actor: null,
    actorRole: 'system',
    toStatus: status,
    summary: `Digest ${status}: ${sent} sent, ${failed} failed${capApplied ? ', daily cap applied' : ''}`,
  }).catch(() => undefined)
  return { outcome: status, issueId: issue.id, sent, failed, capApplied, stories: content.stories.length }
}

// ---- Scheduled entry point (called every scheduler tick) ----

type MemoGlobal = typeof globalThis & { __ctDigestMemo?: { day: string; outcome: DigestRunOutcome } }

/**
 * Runs at most one digest action per Lagos day once `sendHourLagos` has passed. Dry run unless NEWSLETTER_DIGEST_SEND=true.
 * `no-stories`, `already-done` and `not-configured` are remembered for the rest of the day in this process so the tick
 * stays cheap.
 */
export async function runScheduledDigest(payload: Payload, deps: DigestDeps = {}): Promise<DigestRunResult> {
  const now = deps.now ?? new Date()
  const env = deps.env ?? process.env
  const g = globalThis as MemoGlobal
  const day = lagosDay(now)
  if (g.__ctDigestMemo?.day === day) return { outcome: g.__ctDigestMemo.outcome }

  const settings = await loadDigestSettings(payload)
  if (!settings.enabled || !settings.dailyDigestEnabled) return { outcome: 'disabled' }
  if (lagosHour(now) < settings.sendHourLagos) return { outcome: 'not-due' }

  let result: DigestRunResult
  if (sendLive(env)) {
    result = await sendDigest(payload, settings, { ...deps, now, env })
  } else {
    // Dry run: one draft per day at most.
    const today = await issuesSince(payload, lagosDayStart(now))
    result = today.length ? { outcome: 'already-done' } : await createDigestDraft(payload, { ...deps, now, env })
  }
  g.__ctDigestMemo = { day, outcome: result.outcome }
  return result
}

/** Test helper. */
export function resetDigestMemo(): void {
  delete (globalThis as MemoGlobal).__ctDigestMemo
}

/** Non-blocking wrapper for the scheduler: its own in-flight guard, never throws. */
let inFlight = false
export function tickDigest(payload: Payload): void {
  if (inFlight || process.env.NEWSLETTER_DIGEST_SCHEDULER === 'false') return
  inFlight = true
  void runScheduledDigest(payload)
    .then((r) => {
      if (r.outcome === 'sent' || r.outcome === 'failed' || r.outcome === 'draft' || r.outcome === 'not-configured') {
        payload.logger.info({ outcome: r.outcome, sent: r.sent, failed: r.failed, capApplied: r.capApplied }, 'newsletter digest')
      }
    })
    .catch((err: unknown) => payload.logger.error(safeErrorFields(err), 'newsletter digest run failed'))
    .finally(() => {
      inFlight = false
    })
}
