import { sql } from '@payloadcms/db-postgres'
import type { Payload, PayloadRequest } from 'payload'

import { executor } from './dbTransaction'

/**
 * Public article search (go-live contract C8).
 *
 * Projection: table `article_search`, one row per PUBLISHED article (title, excerpt, plain body text, a GENERATED weighted
 * `tsv` column with a GIN index). It is kept in step by Articles hooks (afterChange upserts or deletes, afterDelete deletes,
 * the FK cascades as a safety net) and rebuilt by `npm run search:reindex`. The importer goes through the same Local API
 * `payload.create`, so the hooks fire for it as well; reindex is the belt-and-braces / repair path.
 *
 * Text search configuration: 'english', chosen deliberately. The corpus is Nigerian English news; stemming makes
 * "elections" find "election" and stop-words never dominate a query. Names are stemmed the same way at index and at query
 * time, so they still match themselves. 'simple' would miss plurals; unaccent is NOT used (extension not guaranteed in the
 * embedded test cluster or every production image).
 */

export const SEARCH_CONFIG = 'english'
export const SEARCH_Q_MAX = 200
export const SEARCH_DEFAULT_LIMIT = 10
export const SEARCH_MAX_LIMIT = 50
export const SEARCH_MAX_PAGE = 100
export const SEARCH_BODY_MAX = 200_000
export const SNIPPET_MAX = 240

type Node = { type?: unknown; text?: unknown; children?: unknown }
const BLOCK_TYPES = new Set(['paragraph', 'heading', 'listitem', 'quote', 'linebreak', 'tab', 'block', 'upload'])

/** Plain text of a Lexical document (text nodes only; blocks separated by a space). Bounded in size and depth. */
export function lexicalToPlainText(content: unknown, max = SEARCH_BODY_MAX): string {
  const parts: string[] = []
  let size = 0
  const walk = (node: unknown, depth: number): void => {
    if (size >= max || depth > 40 || node === null || typeof node !== 'object') return
    const n = node as Node
    if (typeof n.text === 'string') {
      parts.push(n.text)
      size += n.text.length
    }
    if (Array.isArray(n.children)) for (const c of n.children) walk(c, depth + 1)
    if (typeof n.type === 'string' && BLOCK_TYPES.has(n.type)) {
      parts.push(' ')
      size += 1
    }
  }
  const root = (content as { root?: unknown } | null)?.root ?? content
  walk(root, 0)
  return cleanSearchText(parts.join(''), max)
}

const wellFormed = (value: string): string => {
  const v = value as string & { toWellFormed?: () => string }
  return typeof v.toWellFormed === 'function' ? v.toWellFormed() : value
}

/** No markup, no control characters, no lone surrogates, collapsed whitespace, capped. */
export function cleanSearchText(value: string, max: number): string {
  return (
    wellFormed(value)
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1F\x7F-\x9F\u2028\u2029]/g, ' ')
      .replace(/[<>]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max)
  )
}

type ArticleLike = {
  id: number
  title?: unknown
  excerpt?: unknown
  content?: unknown
  status?: unknown
  publishedAt?: unknown
  category?: unknown
}

const idOf = (v: unknown): number | null => {
  const raw = v && typeof v === 'object' ? (v as { id?: unknown }).id : v
  return typeof raw === 'number' && Number.isInteger(raw) ? raw : null
}

type Exec = Awaited<ReturnType<typeof executor>>['db']

async function syncWith(db: Exec, doc: ArticleLike): Promise<void> {
  const categoryId = idOf(doc.category)
  if (doc.status !== 'published' || typeof doc.publishedAt !== 'string' || categoryId === null) {
    await db.execute(sql`delete from "article_search" where "article_id" = ${doc.id}`)
    return
  }
  const title = cleanSearchText(String(doc.title ?? ''), 500)
  const excerpt = cleanSearchText(String(doc.excerpt ?? ''), 1000)
  const body = lexicalToPlainText(doc.content)
  await db.execute(sql`
    insert into "article_search" ("article_id", "category_id", "published_at", "title", "excerpt", "body", "indexed_at")
    values (${doc.id}, ${categoryId}, ${doc.publishedAt}::timestamptz, ${title}, ${excerpt}, ${body}, now())
    on conflict ("article_id") do update set
      "category_id" = excluded."category_id", "published_at" = excluded."published_at", "title" = excluded."title",
      "excerpt" = excluded."excerpt", "body" = excluded."body", "indexed_at" = now()`)
}

/** Upsert (published) or delete (anything else) the projection row of one article, inside the request's transaction. */
export async function syncArticleSearch(req: PayloadRequest, doc: ArticleLike): Promise<void> {
  const { db } = await executor(req)
  await syncWith(db, doc)
}

export async function removeArticleSearch(req: PayloadRequest, id: number): Promise<void> {
  const { db } = await executor(req)
  await db.execute(sql`delete from "article_search" where "article_id" = ${id}`)
}

export type ReindexResult = { scanned: number; indexed: number; removedStale: number }

/**
 * Rebuild the projection from the articles table. Idempotent (upserts), batched by id (keyset), and removes rows whose
 * article is no longer published. Safe to run while the site is live.
 */
export async function reindexArticleSearch(
  payload: Payload,
  options: { batchSize?: number; onBatch?: (r: ReindexResult) => void } = {},
): Promise<ReindexResult> {
  const batchSize = Math.min(Math.max(options.batchSize ?? 200, 1), 1000)
  const db = (payload.db as unknown as { drizzle: Exec }).drizzle
  const result: ReindexResult = { scanned: 0, indexed: 0, removedStale: 0 }
  let lastId = 0
  for (;;) {
    const page = await payload.find({
      collection: 'articles',
      where: { and: [{ status: { equals: 'published' } }, { id: { greater_than: lastId } }] },
      sort: 'id',
      limit: batchSize,
      depth: 0,
      pagination: false,
      overrideAccess: true,
    })
    if (page.docs.length === 0) break
    for (const doc of page.docs) {
      await syncWith(db, doc as unknown as ArticleLike)
      result.indexed++
    }
    result.scanned += page.docs.length
    lastId = (page.docs[page.docs.length - 1] as { id: number }).id
    options.onBatch?.({ ...result })
  }
  const stale = await db.execute(sql`
    delete from "article_search" s
    where not exists (select 1 from "articles" a where a."id" = s."article_id" and a."status"::text = 'published')
    returning s."article_id"`)
  result.removedStale = stale.rowCount ?? stale.rows?.length ?? 0
  return result
}

// ---------------------------------------------------------------------------------------------------------------------
// Query side

export type SearchParams = { q: string; page: number; limit: number; category?: string; year?: number }
export type ParseResult = { ok: true; params: SearchParams } | { ok: false; message: string }

const strictInt = (raw: string | null): number | undefined =>
  raw !== null && /^\d{1,9}$/.test(raw.trim()) ? Number(raw) : undefined

/** Sanitise the user's query text: well-formed, no control characters, collapsed whitespace. Never trusted as tsquery syntax. */
export function sanitizeQuery(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return wellFormed(raw).replace(/[\x00-\x1F\x7F-\x9F\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim()
}

export function parseSearchParams(params: URLSearchParams): ParseResult {
  const tooLong = { ok: false, message: `Query parameter "q" must be at most ${SEARCH_Q_MAX} characters.` } as const
  const rawQ = params.get('q')
  if (rawQ === null) return { ok: false, message: 'Query parameter "q" is required.' }
  if (rawQ.length > SEARCH_Q_MAX * 4) return tooLong
  const q = sanitizeQuery(rawQ)
  if (q === '') return { ok: false, message: 'Query parameter "q" is required.' }
  if ([...q].length > SEARCH_Q_MAX) return tooLong

  const limit = Math.min(strictInt(params.get('limit')) || SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT)
  const page = Math.min(strictInt(params.get('page')) || 1, SEARCH_MAX_PAGE)

  let category: string | undefined
  const rawCat = params.get('category')
  if (rawCat !== null && rawCat.trim() !== '') {
    category = sanitizeQuery(rawCat)
    if (category.length > 100) return { ok: false, message: 'Query parameter "category" is too long.' }
  }
  let year: number | undefined
  const rawYear = params.get('year')
  if (rawYear !== null && rawYear.trim() !== '') {
    year = strictInt(rawYear)
    if (year === undefined || year < 1900 || year > 2100) return { ok: false, message: 'Query parameter "year" must be a four-digit year.' }
  }
  return { ok: true, params: { q, page, limit, category, year } }
}

export type SearchHit = {
  id: number
  slug: string
  title: string
  excerpt: string
  snippet: string
  publishedAt: string
  category: { id: number; slug: string; title: string }
  rank: number
}
export type SearchResult = { docs: SearchHit[]; totalDocs: number }

/** ts_headline output is already plain text (the body has no markup); still strip angle brackets and cap the length. */
export function cleanSnippet(raw: unknown, fallback: string): string {
  const text = cleanSearchText(typeof raw === 'string' ? raw : '', 10_000)
  const out = text === '' ? cleanSearchText(fallback, 10_000) : text
  return out.length > SNIPPET_MAX ? `${out.slice(0, SNIPPET_MAX - 1).trimEnd()}\u2026` : out
}

export async function searchArticles(payload: Payload, p: SearchParams): Promise<SearchResult> {
  const db = (payload.db as unknown as { drizzle: Exec }).drizzle
  const offset = (p.page - 1) * p.limit
  const yearFrom = p.year === undefined ? null : `${String(p.year).padStart(4, '0')}-01-01T00:00:00Z`
  const yearTo = p.year === undefined ? null : `${String(p.year + 1).padStart(4, '0')}-01-01T00:00:00Z`
  const catSlug = p.category ?? null
  const catId = p.category !== undefined && /^\d{1,9}$/.test(p.category) ? Number(p.category) : null
  const config = sql.raw(`'${SEARCH_CONFIG}'::regconfig`)

  const res = await db.execute(sql`
    with q as (select websearch_to_tsquery(${config}, ${p.q}) as tsq),
    matching as (
      select s."article_id", s."published_at", s."category_id", ts_rank(s."tsv", q.tsq) as rank
      from "article_search" s, q
      where numnode(q.tsq) > 0 and s."tsv" @@ q.tsq
        and s."published_at" <= now()
        and (${yearFrom}::timestamptz is null or (s."published_at" >= ${yearFrom}::timestamptz and s."published_at" < ${yearTo}::timestamptz))
        and (${catSlug}::text is null or s."category_id" in (
              select c."id" from "categories" c where c."slug" = ${catSlug}::text or c."id" = ${catId}::integer))
    ),
    hits as (
      select * from matching order by rank desc, "published_at" desc, "article_id" desc limit ${p.limit} offset ${offset}
    )
    select h."article_id" as id, a."slug", s."title", s."excerpt", h."published_at", h."category_id", h.rank,
           (select count(*) from matching) as total,
           c."slug" as category_slug, c."title" as category_title,
           ts_headline(${config}, s."body", q.tsq, 'StartSel="", StopSel="", MaxWords=32, MinWords=14, ShortWord=2, MaxFragments=0') as snippet
    from hits h
    join "article_search" s on s."article_id" = h."article_id"
    join "articles" a on a."id" = h."article_id" and a."status"::text = 'published'
    join "categories" c on c."id" = h."category_id"
    cross join q
    order by h.rank desc, h."published_at" desc, h."article_id" desc`)

  const rows = (res.rows ?? []) as Array<Record<string, unknown>>
  const docs = rows.map((r) => ({
    id: Number(r.id),
    slug: String(r.slug),
    title: String(r.title),
    excerpt: String(r.excerpt ?? ''),
    snippet: cleanSnippet(r.snippet, String(r.excerpt ?? '')),
    publishedAt: new Date(r.published_at as string | Date).toISOString(),
    category: { id: Number(r.category_id), slug: String(r.category_slug), title: String(r.category_title) },
    rank: Math.round(Number(r.rank) * 10_000) / 10_000,
  }))
  let totalDocs = rows.length > 0 ? Number(rows[0]!.total) : 0
  if (rows.length === 0 && offset > 0) {
    // Page past the end: report the real total so a client can tell "no more pages" from "no results".
    const c = await db.execute(sql`
      select count(*)::int as n from "article_search" s
      where s."tsv" @@ websearch_to_tsquery(${config}, ${p.q}) and s."published_at" <= now()
        and (${yearFrom}::timestamptz is null or (s."published_at" >= ${yearFrom}::timestamptz and s."published_at" < ${yearTo}::timestamptz))
        and (${catSlug}::text is null or s."category_id" in (
              select c."id" from "categories" c where c."slug" = ${catSlug}::text or c."id" = ${catId}::integer))`)
    totalDocs = Number((c.rows?.[0] as { n?: number } | undefined)?.n ?? 0)
  }
  return { docs, totalDocs }
}
