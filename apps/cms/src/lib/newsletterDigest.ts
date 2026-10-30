import { escapeHtml, html, renderDocument, safeHref, type TrustedEmailHtml } from './emailTemplate'
import { lagosDay } from './mailer'
import type { ArticlePathTemplate } from './redirectPaths'
import { clampText, cleanCardText, formatLagosDate } from './shareCard'
import { briefArticleUrl } from './whatsappBrief'

/**
 * Daily digest, pure part (no database, no network). Deterministic: the same settings, stories and date always give the
 * same subject, text and HTML. No AI and no ranking signal other than recency: "top" = newest published since the
 * previous issue, ties broken by id. Every CMS string is treated as plain text (escaped in HTML, cleaned in text).
 */

export type DigestSettings = {
  enabled: boolean
  dailyDigestEnabled: boolean
  sendHourLagos: number
  dailySendCap: number
  fromName: string
  replyTo: string
  maxStoriesPerDigest: number
  includeDevotional: boolean
}

export const DIGEST_DEFAULTS: DigestSettings = {
  enabled: false,
  dailyDigestEnabled: false,
  sendHourLagos: 6,
  dailySendCap: 100,
  fromName: 'Church Times Nigeria',
  replyTo: '',
  maxStoriesPerDigest: 6,
  includeDevotional: false,
}

/** Hard ceilings that a settings value can never exceed, whatever is stored. */
export const DIGEST_LIMITS = { maxStories: 20, maxDailyCap: 10_000 } as const

const intIn = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback
}

/** Whitelist copy of the `newsletter-settings` global. Missing global or field => safe default (everything OFF). */
export function normaliseDigestSettings(raw: unknown): DigestSettings {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    enabled: r.enabled === true,
    dailyDigestEnabled: r.dailyDigestEnabled === true,
    sendHourLagos: intIn(r.sendHourLagos, 0, 23, DIGEST_DEFAULTS.sendHourLagos),
    // 0 is a valid cap (sends nothing); anything unreadable falls back to the default of 100.
    dailySendCap: intIn(r.dailySendCap, 0, DIGEST_LIMITS.maxDailyCap, DIGEST_DEFAULTS.dailySendCap),
    fromName: cleanCardText(r.fromName, 80).replace(/["<>\\]/g, '') || DIGEST_DEFAULTS.fromName,
    replyTo: typeof r.replyTo === 'string' ? r.replyTo.trim().slice(0, 254) : '',
    maxStoriesPerDigest: intIn(r.maxStoriesPerDigest, 1, DIGEST_LIMITS.maxStories, DIGEST_DEFAULTS.maxStoriesPerDigest),
    includeDevotional: r.includeDevotional === true,
  }
}

export type DigestStory = {
  id: string
  slug: string
  title: string
  excerpt: string
  publishedAt: string
  category: string
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Whitelist copy of an article row (depth 1 for the category title). Null when unusable. */
export function normaliseDigestStory(record: unknown): DigestStory | null {
  if (!record || typeof record !== 'object') return null
  const r = record as Record<string, unknown>
  const slug = typeof r.slug === 'string' ? r.slug.trim() : ''
  const title = cleanCardText(r.title, 240)
  const publishedAt = typeof r.publishedAt === 'string' && Number.isFinite(Date.parse(r.publishedAt)) ? new Date(r.publishedAt).toISOString() : ''
  if (!SLUG.test(slug) || !title || !publishedAt) return null
  const category =
    r.category && typeof r.category === 'object' ? (r.category as Record<string, unknown>).title : undefined
  return {
    id: String(r.id ?? slug),
    slug,
    title,
    excerpt: cleanCardText(r.excerpt, 600),
    publishedAt,
    // Paid placements stay labelled in the inbox too (schema-contract `contentType`).
    category: r.contentType === 'sponsored' ? 'Sponsored' : cleanCardText(category, 80),
  }
}

const idKey = (id: string) => (/^[0-9]{1,15}$/.test(id) ? id.padStart(15, '0') : id)
export const digestOrder = (a: DigestStory, b: DigestStory): number =>
  b.publishedAt.localeCompare(a.publishedAt) || idKey(b.id).localeCompare(idKey(a.id))

/**
 * Stories published after `since` (exclusive) and not after `now`, newest first, de-duplicated by slug, at most `max`.
 */
export function selectDigestStories(stories: DigestStory[], since: Date, now: Date, max: number): DigestStory[] {
  const from = since.toISOString()
  const to = now.toISOString()
  const seen = new Set<string>()
  return [...stories]
    .filter((s) => s.publishedAt > from && s.publishedAt <= to)
    .sort(digestOrder)
    .filter((s) => (seen.has(s.slug) ? false : (seen.add(s.slug), true)))
    .slice(0, Math.max(1, Math.min(DIGEST_LIMITS.maxStories, max)))
}

/**
 * Lower bound for the next issue: the previous issue's run time when there is one, else 24 hours before `now`, and
 * never more than 7 days back (a digest after a long pause is "this week", not the whole archive).
 */
export function digestWindowStart(previousIssueAt: Date | null, now: Date): Date {
  const floor = now.getTime() - 7 * 24 * 3600 * 1000
  const base = previousIssueAt ? previousIssueAt.getTime() : now.getTime() - 24 * 3600 * 1000
  return new Date(Math.max(base, floor))
}

/** Lagos wall-clock hour (0-23) of `now`. */
export const lagosHour = (now: Date): number => new Date(now.getTime() + 3600 * 1000).getUTCHours()

export type Devotional = { reference: string; text: string; version: 'KJV' | 'WEB' }

export type DigestContent = {
  date: string
  stories: DigestStory[]
  siteUrl: string | null
  template: ArticlePathTemplate
  devotional?: Devotional | null
}

export type DigestRecipientLinks = { unsubscribePageUrl: string }

const SITE_NAME = 'Church Times Nigeria'
const LEGAL_LINE = 'Churchtimes Agency Ltd, publisher of Church Times Nigeria.'
const WHY_LINE = 'You receive this because you confirmed a subscription to the Church Times Nigeria newsletter.'

export const digestDayLabel = (date: string): string => formatLagosDate(`${date}T12:00:00+01:00`) || date

/** Deterministic subject: the day plus the lead headline, clamped for inbox previews. */
export function digestSubject(content: Pick<DigestContent, 'date' | 'stories'>): string {
  const lead = content.stories[0]?.title
  const base = `${SITE_NAME} daily briefing, ${digestDayLabel(content.date)}`
  return lead ? clampText(`${base}: ${lead}`, 150) : base
}

const textLine = (value: string): string => value.replace(/\s+/g, ' ').trim()

export function renderDigestText(content: DigestContent, links: DigestRecipientLinks): string {
  const lines: string[] = [`${SITE_NAME}: daily briefing`, digestDayLabel(content.date), '']
  content.stories.forEach((story, i) => {
    lines.push(`${i + 1}. ${textLine(story.title)}${story.category ? ` [${textLine(story.category)}]` : ''}`)
    const excerpt = textLine(clampText(story.excerpt, 280))
    if (excerpt) lines.push(excerpt)
    const url = briefArticleUrl(story.slug, content.siteUrl, content.template)
    if (url) lines.push(url)
    lines.push('')
  })
  if (content.devotional) {
    lines.push(`Verse of the day (${content.devotional.version}, public domain)`)
    lines.push(`${textLine(content.devotional.text)} (${textLine(content.devotional.reference)})`, '')
  }
  lines.push('--', WHY_LINE, `Unsubscribe: ${links.unsubscribePageUrl}`, LEGAL_LINE)
  return `${lines.join('\n')}\n`
}

/** Email-safe HTML: one table, inline styles, system fonts, no images, no scripts, no tracking pixels. */
export function renderDigestHtml(content: DigestContent, links: DigestRecipientLinks): TrustedEmailHtml {
  const ink = '#1d1b18'
  const muted = '#5b554d'
  const accent = '#8a5a2b'
  const stories = content.stories.map((story) => {
    const url = briefArticleUrl(story.slug, content.siteUrl, content.template)
    const excerpt = clampText(story.excerpt, 280)
    const title = url
      ? html`<a href="${safeHref(url)}" style="color:${ink};text-decoration:underline">${story.title}</a>`
      : html`${story.title}`
    return html`<tr><td style="padding:16px 0;border-top:1px solid #e4ddd2">${
      story.category ? html`<p style="margin:0 0 4px;font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:${accent}">${story.category}</p>` : ''
    }<h2 style="margin:0 0 6px;font-family:Georgia,'Times New Roman',serif;font-size:21px;line-height:1.3;font-weight:600;color:${ink}">${title}</h2>${
      excerpt ? html`<p style="margin:0;font-size:16px;line-height:1.5;color:${muted}">${excerpt}</p>` : ''
    }</td></tr>`
  })
  const devotional = content.devotional
    ? html`<tr><td style="padding:16px 0;border-top:1px solid #e4ddd2"><p style="margin:0 0 4px;font-size:13px;letter-spacing:.04em;text-transform:uppercase;color:${accent}">Verse of the day</p><p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:18px;line-height:1.5;color:${ink}">${content.devotional.text}</p><p style="margin:6px 0 0;font-size:14px;color:${muted}">${content.devotional.reference} (${content.devotional.version}, public domain)</p></td></tr>`
    : ''
  const day = digestDayLabel(content.date)
  const doc = html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${SITE_NAME} daily briefing</title></head><body style="margin:0;padding:0;background:#f6f2ea"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f2ea"><tr><td align="center" style="padding:24px 12px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;font-family:Arial,Helvetica,sans-serif;color:${ink}"><tr><td style="padding:24px 24px 8px"><p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:26px;font-weight:700;color:${ink}">${SITE_NAME}</p><p style="margin:4px 0 0;font-size:15px;color:${muted}">Daily briefing, ${day}</p></td></tr><tr><td style="padding:0 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${stories}${devotional}</table></td></tr><tr><td style="padding:16px 24px 24px;border-top:1px solid #e4ddd2;font-size:13px;line-height:1.5;color:${muted}"><p style="margin:0 0 8px">${WHY_LINE}</p><p style="margin:0 0 8px"><a href="${safeHref(links.unsubscribePageUrl)}" style="color:${ink}">Unsubscribe</a> at any time; it takes effect immediately.</p><p style="margin:0">${LEGAL_LINE}</p></td></tr></table></td></tr></table></body></html>`
  return renderDocument(doc)
}

/** Lagos date key for `now` (re-exported for the runner and tests). */
export const digestDate = (now: Date): string => lagosDay(now)

export { escapeHtml }

/**
 * Whitelist copy of the public host's `scripture/verse-of-the-day.json` (tools/public-routes/verse-of-the-day.mjs).
 * Only the bundled public-domain KJV is accepted; anything else (or anything malformed) means no verse in the mail.
 */
export function parseDevotional(raw: unknown, date: string): Devotional | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.ok !== true || r.version !== 'KJV' || r.date !== date) return null
  const reference = cleanCardText(r.reference, 80)
  const text = cleanCardText(r.text, 1200)
  if (!/^[1-3]?\s?[A-Za-z][A-Za-z ]{1,40} \d{1,3}(?::\d{1,3})?(?:[–-]\d{1,3}(?::\d{1,3})?)?$/.test(reference) || text.length < 5) return null
  return { reference, text, version: 'KJV' }
}
