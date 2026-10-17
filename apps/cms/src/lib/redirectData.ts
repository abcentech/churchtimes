import type { Payload, PayloadRequest } from 'payload'

import {
  type ArticleInput,
  type BuildResult,
  type RedirectRule,
  type RuleLookup,
  type StoredRow,
  buildRedirectMap,
  deriveRule,
} from './redirectMap'
import {
  type ArticlePathTemplate,
  type EnvLike,
  articlePath,
  parseAllowedHosts,
  parseLegacyHosts,
  resolveArticlePathTemplate,
  slugFromArticlePath,
} from './redirectPaths'

/**
 * Database side of redirects: loads the stored rows and the published articles, and runs the pure builder.
 * Always local-API calls with `overrideAccess: true` and an explicit `status = published` filter, so the result never
 * depends on who is asking and never includes unpublished articles.
 */

const PAGE = 1000

async function pages<T>(fetchPage: (page: number) => Promise<{ docs: T[]; hasNextPage: boolean }>): Promise<T[]> {
  const out: T[] = []
  for (let page = 1; page < 10_000; page++) {
    const res = await fetchPage(page)
    out.push(...res.docs)
    if (!res.hasNextPage) break
  }
  return out
}

export async function loadStoredRows(payload: Payload, req?: PayloadRequest): Promise<StoredRow[]> {
  const docs = await pages((page) =>
    payload.find({
      collection: 'redirects',
      limit: PAGE,
      page,
      sort: 'id',
      depth: 0,
      overrideAccess: true,
      select: { from: true, to: true, status: true, source: true },
      ...(req ? { req } : {}),
    }) as Promise<{ docs: Record<string, unknown>[]; hasNextPage: boolean }>,
  )
  return docs.map((d) => ({
    id: d.id as number,
    from: String(d.from ?? ''),
    to: typeof d.to === 'string' ? d.to : null,
    status: Number(d.status),
    source: String(d.source ?? ''),
  }))
}

/** Published articles that have a `legacyUrl` (the only articles that can derive a rule). */
export async function loadPublishedLegacyArticles(payload: Payload, req?: PayloadRequest): Promise<ArticleInput[]> {
  const docs = await pages((page) =>
    payload.find({
      collection: 'articles',
      where: { and: [{ status: { equals: 'published' } }, { legacyUrl: { exists: true } }] },
      limit: PAGE,
      page,
      sort: 'id',
      depth: 0,
      overrideAccess: true,
      select: { slug: true, status: true, legacyUrl: true },
      ...(req ? { req } : {}),
    }) as Promise<{ docs: Record<string, unknown>[]; hasNextPage: boolean }>,
  )
  return docs.map((d) => ({
    id: d.id as number,
    slug: String(d.slug ?? ''),
    status: String(d.status ?? ''),
    legacyUrl: typeof d.legacyUrl === 'string' ? d.legacyUrl : null,
  }))
}

/** Slugs of every published article (for `check:redirects`: an address that is a live article needs no redirect). */
export async function loadPublishedSlugs(payload: Payload): Promise<string[]> {
  const docs = await pages((page) =>
    payload.find({
      collection: 'articles',
      where: { status: { equals: 'published' } },
      limit: PAGE,
      page,
      sort: 'id',
      depth: 0,
      overrideAccess: true,
      select: { slug: true },
    }) as Promise<{ docs: Record<string, unknown>[]; hasNextPage: boolean }>,
  )
  return docs.map((d) => String(d.slug ?? '')).filter(Boolean)
}

/** Builds the redirect map from the database. Throws `RedirectMapError` / `RedirectConfigError` (never partial). */
export async function generateRedirectMap(
  payload: Payload,
  options: { now?: Date; env?: EnvLike } = {},
): Promise<BuildResult> {
  const env = options.env ?? process.env
  const template = resolveArticlePathTemplate(env)
  const allowedHosts = parseAllowedHosts(env)
  const legacyHosts = parseLegacyHosts(env)
  const [rows, articles] = await Promise.all([loadStoredRows(payload), loadPublishedLegacyArticles(payload)])
  return buildRedirectMap({ articles, rows, template, allowedHosts, legacyHosts, now: options.now ?? new Date() })
}

/** Current public paths of all published articles (plus the home page), for `check:redirects`. */
export async function loadLivePaths(payload: Payload, template: ArticlePathTemplate): Promise<Set<string>> {
  const paths = new Set<string>(['/'])
  for (const slug of await loadPublishedSlugs(payload)) {
    try {
      paths.add(articlePath(template, slug))
    } catch {
      // a slug that makes no valid path cannot be a live address
    }
  }
  return paths
}

/** `RuleLookup` over the database for the collection write hook. `excludeId` is the row being written. */
export function databaseRuleLookup(
  payload: Payload,
  req: PayloadRequest | undefined,
  template: ArticlePathTemplate,
  excludeId?: number | string,
  legacyHosts: readonly string[] = parseLegacyHosts(),
): RuleLookup {
  let derived: Map<string, RedirectRule & { label: string }> | undefined
  const reqOpt = req ? { req } : {}
  const notSelf = excludeId !== undefined ? [{ id: { not_equals: excludeId } }] : []
  const toRow = (d: Record<string, unknown>): StoredRow => ({
    id: d.id as number,
    from: String(d.from ?? ''),
    to: typeof d.to === 'string' ? d.to : null,
    status: Number(d.status),
    source: String(d.source ?? ''),
  })
  return {
    async storedFrom(path) {
      const res = await payload.find({
        collection: 'redirects',
        where: { and: [{ from: { equals: path } }, ...notSelf] },
        limit: 1,
        depth: 0,
        overrideAccess: true,
        ...reqOpt,
      })
      return res.docs[0] ? toRow(res.docs[0] as unknown as Record<string, unknown>) : null
    },
    async storedTo(path) {
      const res = await payload.find({
        collection: 'redirects',
        where: { and: [{ to: { equals: path } }, { source: { equals: 'manual' } }, ...notSelf] },
        limit: 1,
        depth: 0,
        overrideAccess: true,
        ...reqOpt,
      })
      return (res.docs as unknown as Record<string, unknown>[]).map(toRow)
    },
    async derivedFrom(path) {
      // Compare CANONICAL paths over every published article with a legacyUrl (no substring search and no truncating
      // limit: raw Unicode, a missing slash and upper/lower-case percent-encoding all reach the same key). Loaded once.
      if (!derived) {
        derived = new Map()
        const articles = (await loadPublishedLegacyArticles(payload, req)).sort((a, b) => Number(a.id) - Number(b.id))
        for (const article of articles) {
          const d = deriveRule(article, template, legacyHosts)
          if ('rule' in d && !derived.has(d.rule.from)) {
            derived.set(d.rule.from, {
              ...d.rule,
              label: `derived rule from article "${article.slug}" ${d.rule.from} -> ${d.rule.to}`,
            })
          }
        }
      }
      return derived.get(path) ?? null
    },
    async articleAt(path) {
      const slug = slugFromArticlePath(template, path)
      if (!slug) return null
      const res = await payload.find({
        collection: 'articles',
        where: { and: [{ slug: { equals: slug } }, { status: { equals: 'published' } }] },
        limit: 1,
        depth: 0,
        overrideAccess: true,
        select: { slug: true },
        ...reqOpt,
      })
      return res.docs[0] ? slug : null
    },
  }
}
