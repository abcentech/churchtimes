import { resolvePublicSiteUrl } from './newsletter'
import { articlePath, resolveArticlePathTemplate, type ArticlePathTemplate, type EnvLike } from './redirectPaths'
import { isReservedSlug } from './reservedSlugs'
import { SLUG_RE } from './sanitize'
import { clampText, cleanCardText, formatLagosDate } from './shareCard'

/**
 * WhatsApp daily brief (`npm run whatsapp:brief`): pure, deterministic builders. No AI, no ranking model: the stories are
 * the published articles of one Africa/Lagos calendar day, newest first (ties by id), read from the CMS's own public API.
 */

export type BriefArticle = { id: string; slug: string; title: string; excerpt: string; publishedAt: string }

export const BRIEF_DEFAULT_LIMIT = 5
export const BRIEF_MAX_LIMIT = 10
/** Fewer stories than this on the day: the brief falls back to the latest published stories and says so. */
export const BRIEF_MINIMUM = 3
export const EXCERPT_MAX = 140

/** `YYYY-MM-DD` of an instant in Africa/Lagos. Empty for an invalid date. */
export function lagosDateKey(value: string | Date): string {
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(d)
    .reduce<Record<string, string>>((acc, p) => ({ ...acc, [p.type]: p.value }), {})
  return `${parts.year}-${parts.month}-${parts.day}`
}

/** A real calendar date in `YYYY-MM-DD` form. */
export function isDateKey(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const d = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value
}

/** Shape check of one record from `GET /api/articles` (published only; anything odd is dropped). */
export function normaliseBriefArticle(record: unknown): BriefArticle | null {
  if (!record || typeof record !== 'object') return null
  const r = record as Record<string, unknown>
  if (r.status !== 'published') return null
  const slug = typeof r.slug === 'string' ? r.slug : ''
  const title = cleanCardText(r.title, 240)
  const publishedAt = typeof r.publishedAt === 'string' && !Number.isNaN(Date.parse(r.publishedAt)) ? new Date(r.publishedAt).toISOString() : ''
  if (!SLUG_RE.test(slug) || slug.length > 160 || !title || !publishedAt) return null
  return { id: String(r.id ?? slug), slug, title, excerpt: cleanCardText(r.excerpt, 600), publishedAt }
}

const compareIds = (a: string, b: string): number =>
  /^\d+$/.test(a) && /^\d+$/.test(b) ? Number(a) - Number(b) : a < b ? -1 : a > b ? 1 : 0

/** Newest first; equal times by ascending id, so the order never depends on API order. */
export const briefOrder = (a: BriefArticle, b: BriefArticle): number =>
  b.publishedAt.localeCompare(a.publishedAt) || compareIds(a.id, b.id)

export type BriefSelection = { stories: BriefArticle[]; fallback: boolean }

/**
 * The stories of `date` (Lagos). When the day has fewer than BRIEF_MINIMUM, the latest published stories up to the end of
 * that day are used instead and `fallback` is true (the text says so). Duplicates (same slug) are dropped.
 */
export function selectBriefStories(articles: BriefArticle[], date: string, limit = BRIEF_DEFAULT_LIMIT): BriefSelection {
  const max = Math.max(1, Math.min(BRIEF_MAX_LIMIT, Math.floor(limit) || BRIEF_DEFAULT_LIMIT))
  const seen = new Set<string>()
  const unique = [...articles].sort(briefOrder).filter((a) => (seen.has(a.slug) ? false : (seen.add(a.slug), true)))
  const onDay = unique.filter((a) => lagosDateKey(a.publishedAt) === date)
  if (onDay.length >= Math.min(BRIEF_MINIMUM, max)) return { stories: onDay.slice(0, max), fallback: false }
  const upToDay = unique.filter((a) => lagosDateKey(a.publishedAt) <= date)
  return { stories: upToDay.slice(0, max), fallback: true }
}

/** Public URL of an article, with the same template rules as the public host. Empty when it cannot be built safely. */
export function briefArticleUrl(slug: string, siteUrl: string | null, template: ArticlePathTemplate): string {
  if (!siteUrl || !SLUG_RE.test(slug)) return ''
  if (template === '/{slug}/' && isReservedSlug(slug)) return ''
  try {
    return new URL(articlePath(template, slug), siteUrl).href
  } catch {
    return ''
  }
}

/** WhatsApp formatting characters are removed from CMS text so a headline cannot switch bold/italic on or off. */
export const whatsappPlain = (value: string): string => value.replace(/[*_~`]/g, '').replace(/\s+/g, ' ').trim()

export type BriefTextOptions = {
  date: string
  selection: BriefSelection
  siteUrl: string | null
  template: ArticlePathTemplate
  whatsappUrl?: string | null
}

/** Ready-to-paste WhatsApp text. */
export function buildBriefText({ date, selection, siteUrl, template, whatsappUrl }: BriefTextOptions): string {
  const day = formatLagosDate(`${date}T12:00:00+01:00`) || date
  const lines: string[] = [`*Church Times Nigeria: Daily Brief*`, `_${day}_`, '']
  if (selection.fallback) lines.push(`Fewer than three new stories were published on ${day}, so here are our latest reports.`, '')
  if (selection.stories.length === 0) lines.push('No published stories yet.', '')
  selection.stories.forEach((story, i) => {
    lines.push(`*${i + 1}. ${whatsappPlain(story.title)}*`)
    const excerpt = whatsappPlain(clampText(story.excerpt, EXCERPT_MAX))
    if (excerpt) lines.push(excerpt)
    const url = briefArticleUrl(story.slug, siteUrl, template)
    if (url) lines.push(url)
    lines.push('')
  })
  if (whatsappUrl) lines.push(`Join our WhatsApp group: ${whatsappUrl}`)
  if (siteUrl) lines.push(`Read more and get our free email newsletter: ${siteUrl}/`)
  return `${lines.join('\n').trim()}\n`
}

export type BriefConfig = { siteUrl: string | null; template: ArticlePathTemplate }

/** PUBLIC_SITE_URL (same rules as newsletter links) and PUBLIC_ARTICLE_PATH_TEMPLATE. */
export function resolveBriefConfig(env: EnvLike = process.env): BriefConfig {
  return {
    siteUrl: resolvePublicSiteUrl(env as NodeJS.ProcessEnv),
    template: resolveArticlePathTemplate(env),
  }
}

// ---- Reading the CMS public API ----

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/** Page size and page cap when walking back from the newest story to the requested day. */
export const BRIEF_PAGE_SIZE = 50
export const BRIEF_MAX_PAGES = 10

/** The CMS origin to read from: https, or http on a loopback host. */
export function parseCmsUrl(value: string | undefined): string | null {
  const raw = value?.trim()
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.username || url.password) return null
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) return url.origin
    return null
  } catch {
    return null
  }
}

/**
 * Published articles, newest first, from `GET /api/articles` (the same anonymous read the public site uses), until the
 * page reaches stories older than `date` or BRIEF_MAX_PAGES pages were read.
 */
export async function fetchBriefArticles(cmsUrl: string, date: string, fetchImpl: FetchLike = fetch, timeoutMs = 10_000): Promise<BriefArticle[]> {
  const out: BriefArticle[] = []
  for (let page = 1; page <= BRIEF_MAX_PAGES; page += 1) {
    const url = new URL('/api/articles', cmsUrl)
    url.searchParams.set('where[status][equals]', 'published')
    url.searchParams.set('limit', String(BRIEF_PAGE_SIZE))
    url.searchParams.set('depth', '0')
    url.searchParams.set('sort', '-publishedAt')
    url.searchParams.set('page', String(page))
    const response = await fetchImpl(url.toString(), {
      headers: { Accept: 'application/json' },
      credentials: 'omit',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) throw new Error(`CMS request failed (${response.status})`)
    const body = (await response.json()) as { docs?: unknown[]; hasNextPage?: boolean }
    if (!Array.isArray(body?.docs)) throw new Error('Unexpected CMS response')
    const docs = body.docs.map(normaliseBriefArticle).filter((a): a is BriefArticle => a !== null)
    out.push(...docs)
    const oldest = docs.at(-1)
    if (body.hasNextPage !== true || !oldest || lagosDateKey(oldest.publishedAt) < date) break
  }
  return out
}

export type BriefArgs = { date: string; out: string; limit: number; cmsUrl: string | null }

/** `--date YYYY-MM-DD --out dir --limit N --cms-url URL`; throws a readable message on bad input. */
export function parseBriefArgs(argv: string[], now: Date, env: EnvLike, defaultOut: string): BriefArgs {
  const args: BriefArgs = { date: lagosDateKey(now), out: defaultOut, limit: BRIEF_DEFAULT_LIMIT, cmsUrl: parseCmsUrl(env.CMS_PUBLIC_URL) }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (flag === '--') continue
    if (!['--date', '--out', '--limit', '--cms-url'].includes(flag ?? '')) throw new Error(`Unknown option: ${String(flag).slice(0, 40)}`)
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`)
    i += 1
    if (flag === '--date') {
      if (!isDateKey(value)) throw new Error('--date must be YYYY-MM-DD')
      args.date = value
    } else if (flag === '--out') args.out = value
    else if (flag === '--limit') {
      const n = Number(value)
      if (!Number.isInteger(n) || n < 1 || n > BRIEF_MAX_LIMIT) throw new Error(`--limit must be 1-${BRIEF_MAX_LIMIT}`)
      args.limit = n
    } else {
      const url = parseCmsUrl(value)
      if (!url) throw new Error('--cms-url must be an https URL (or http on localhost)')
      args.cmsUrl = url
    }
  }
  return args
}
