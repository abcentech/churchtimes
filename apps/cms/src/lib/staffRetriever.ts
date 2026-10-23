import { sql } from '@payloadcms/db-postgres'
import type { Payload } from 'payload'

import { cleanSearchText, cleanSnippet, SEARCH_CONFIG } from './articleSearch'
import { resolvePublicSiteUrl } from './newsletter'
import { articlePath, resolveArticlePathTemplate } from './redirectPaths'

/**
 * Staff-only related-article retriever (Codex E5.3). Read-only: derives a bounded OR query from a draft or free text and
 * finds related PUBLISHED articles in the `article_search` projection, with citations (canonical path and URL). It
 * generates nothing. The text is never logged and never reaches PostgreSQL as tsquery syntax: it is reduced to plain
 * alphanumeric terms, and the query is `to_tsquery` over those terms joined by `|` (built by `buildOrTsQuery`).
 */

export const RETRIEVER_INPUT_MAX = 20_000
export const RETRIEVER_DEFAULT_LIMIT = 10
export const RETRIEVER_MAX_LIMIT = 20
export const RETRIEVER_MAX_TERMS = 24
const TERM_MIN = 3
const TERM_MAX = 30
const TITLE_WEIGHT = 3
const LEAD_CHARS = 1_000

const STOPWORDS = new Set(
  (
    'a about above after again against all also am an and any are aren as at be because been before being below between both but by ' +
    'can cannot could couldn did didn do does doesn doing don down during each few for from further had hadn has hasn have haven having ' +
    'he her here hers herself him himself his how however i if in into is isn it its itself just let like me might more most must my ' +
    'myself no nor not now of off on once only or other ought our ours ourselves out over own per said say says same shall shan she ' +
    'should shouldn so some such than that the their theirs them themselves then there these they this those through to too under ' +
    'until up upon us very via was wasn we were weren what when where which while who whom whose why will with won would wouldn ' +
    'yet you your yours yourself yourselves one two three many much new old according told year years week day days time'
  ).split(' '),
)

/** Terms are letters and digits only (any script); nothing else survives, so no tsquery operator can be formed. */
const TERM_RE = /[\p{L}\p{N}]+/gu

/** Frequency-ranked, stopword-free terms of `title` (weighted) and `body`. Deterministic: ties break alphabetically. */
export function extractTerms(title: string, body: string, max = RETRIEVER_MAX_TERMS): string[] {
  const counts = new Map<string, number>()
  const add = (text: string, weight: number) => {
    for (const m of text.toLowerCase().matchAll(TERM_RE)) {
      const t = m[0]
      if (t.length < TERM_MIN || t.length > TERM_MAX || STOPWORDS.has(t) || /^\p{N}+$/u.test(t)) continue
      counts.set(t, (counts.get(t) ?? 0) + weight)
    }
  }
  add(title, TITLE_WEIGHT)
  add(body, 1)
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, Math.min(Math.max(max, 1), RETRIEVER_MAX_TERMS))
    .map(([t]) => t)
}

/**
 * The bounded query terms: the title (weighted), the first LEAD_CHARS of the body (the lead carries the story, counted
 * twice) and the rest of the body up to RETRIEVER_INPUT_MAX characters in total, ranked by frequency.
 */
export function deriveTerms(title: string, body: string): { terms: string[]; truncated: boolean } {
  const clean = cleanSearchText(body, Number.MAX_SAFE_INTEGER)
  const truncated = clean.length > RETRIEVER_INPUT_MAX
  const capped = clean.slice(0, RETRIEVER_INPUT_MAX)
  const t = cleanSearchText(title, 500)
  return { terms: extractTerms(t, `${capped.slice(0, LEAD_CHARS)} ${capped}`), truncated }
}

/**
 * Safe tsquery text: every term is re-validated (letters and digits only, bounded length), anything else is dropped, and
 * the survivors are joined with ` | `. Returns '' when nothing is left. Callers pass the result as a bound parameter.
 */
export function buildOrTsQuery(terms: readonly string[], max = RETRIEVER_MAX_TERMS): string {
  const safe: string[] = []
  for (const raw of terms) {
    if (typeof raw !== 'string') continue
    const t = raw.normalize('NFC').toLowerCase()
    if (t.length < 1 || t.length > TERM_MAX || !/^[\p{L}\p{N}]+$/u.test(t)) continue
    if (!safe.includes(t)) safe.push(t)
    if (safe.length >= max) break
  }
  return safe.join(' | ')
}

export type RelatedArticle = {
  id: number
  title: string
  slug: string
  canonicalPath: string
  canonicalUrl: string | null
  publishedAt: string
  snippet: string
  score: number
  matchedTerms: string[]
}

type Exec = { execute: (q: unknown) => Promise<{ rows?: unknown[] }> }

/** Related published articles for `terms`, best first, never including `excludeId`. */
export async function findRelatedArticles(
  payload: Payload,
  terms: readonly string[],
  opts: { limit: number; excludeId?: number | null },
): Promise<RelatedArticle[]> {
  const tsq = buildOrTsQuery(terms)
  if (tsq === '') return []
  const limit = Math.min(Math.max(Math.trunc(opts.limit) || RETRIEVER_DEFAULT_LIMIT, 1), RETRIEVER_MAX_LIMIT)
  const exclude = opts.excludeId ?? null
  const db = (payload.db as unknown as { drizzle: Exec }).drizzle
  const config = sql.raw(`'${SEARCH_CONFIG}'::regconfig`)

  const res = await db.execute(sql`
    with q as (select to_tsquery(${config}, ${tsq}) as tsq),
    hits as (
      select s."article_id", s."published_at", ts_rank(s."tsv", q.tsq) as rank
      from "article_search" s, q
      where numnode(q.tsq) > 0 and s."tsv" @@ q.tsq
        and s."published_at" <= now()
        and (${exclude}::integer is null or s."article_id" <> ${exclude}::integer)
      order by rank desc, s."published_at" desc, s."article_id" desc
      limit ${limit}
    )
    select h."article_id" as id, a."slug", s."title", s."excerpt", h."published_at", h.rank,
           ts_headline(${config}, s."body", q.tsq, 'StartSel="", StopSel="", MaxWords=32, MinWords=14, ShortWord=2, MaxFragments=0') as snippet,
           (select coalesce(array_agg(t order by t), '{}') from unnest(string_to_array(${tsq}, ' | ')) t
              where s."tsv" @@ to_tsquery(${config}, t)) as matched
    from hits h
    join "article_search" s on s."article_id" = h."article_id"
    join "articles" a on a."id" = h."article_id" and a."status"::text = 'published'
    cross join q
    order by h.rank desc, h."published_at" desc, h."article_id" desc`)

  const template = resolveArticlePathTemplate()
  const origin = resolvePublicSiteUrl() ?? originOf(process.env.CMS_PUBLIC_URL)
  return ((res.rows ?? []) as Array<Record<string, unknown>>).map((r) => {
    const slug = String(r.slug)
    const canonicalPath = articlePath(template, slug)
    return {
      id: Number(r.id),
      title: String(r.title),
      slug,
      canonicalPath,
      canonicalUrl: origin ? `${origin}${canonicalPath}` : null,
      publishedAt: new Date(r.published_at as string | Date).toISOString(),
      snippet: cleanSnippet(r.snippet, String(r.excerpt ?? '')),
      score: Math.round(Number(r.rank) * 10_000) / 10_000,
      matchedTerms: Array.isArray(r.matched) ? (r.matched as unknown[]).map(String) : [],
    }
  })
}

function originOf(raw: string | undefined): string | null {
  if (!raw?.trim()) return null
  try {
    const u = new URL(raw.trim())
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null
  } catch {
    return null
  }
}
