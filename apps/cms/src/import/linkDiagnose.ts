import { csvRow } from '../lib/csvSafe'
import { fixKey } from './linkFixes'
import type { Classified, LinkContext, LinkType } from './linkClassify'
import type { WxrRecord } from './wxr'

/**
 * Why a link could not be resolved, by heuristics (pure; no database). The result carries only fixed cause codes and, for
 * the PRIVATE review file, the best matching published post (id, slug, similarity). Nothing here goes to the screen except
 * counts per cause.
 */

export type Cause =
  | 'near-match-case-or-encoding'
  | 'near-match-numeric-suffix'
  | 'near-match-trailing-characters'
  | 'near-match-similar'
  | 'draft-or-private'
  | 'trashed'
  | 'password-protected'
  | 'non-post-page'
  | 'non-post-attachment'
  | 'non-post-other-type'
  | 'not-in-export'
  | 'odd-path-contains-known-slug'
  | 'odd-path'
  | 'external-style-path'
  | 'post-id-not-in-export'
  | 'other'

/** Link types that are problems to work on (an unresolved link of any other type is a known, counted gap such as a tag archive). */
export const PROBLEM_TYPES: ReadonlySet<LinkType> = new Set<LinkType>(['article-unknown', 'article-draft', 'other-path', 'dated-permalink', 'post-id'])

type SlugEntry = { kind: string; status: string; hasPassword: boolean; wpId: number | null }

const norm = (slug: string): string => {
  let s = slug
  try {
    s = decodeURIComponent(slug)
  } catch {
    // keep as written
  }
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
}
const stripNumeric = (s: string): string => s.replace(/-\d{1,3}$/, '')

/** Collects every slug in the export by post type and status (one pass over the records). */
export class SlugIndex {
  private bySlug = new Map<string, SlugEntry[]>()
  private list: { slug: string; norm: string; id: number | null }[] = []

  add(rec: WxrRecord): void {
    if (rec.record !== 'item' || !rec.item.slug) return
    const it = rec.item
    const e: SlugEntry = { kind: it.kind, status: it.status, hasPassword: it.hasPassword, wpId: it.wpId }
    const k = it.slug.toLowerCase()
    const had = this.bySlug.get(k)
    if (had) had.push(e)
    else this.bySlug.set(k, [e])
    if (it.kind === 'post' && it.status === 'publish' && !it.hasPassword) this.list.push({ slug: it.slug, norm: norm(it.slug), id: it.wpId })
  }

  entries(slug: string): readonly SlugEntry[] {
    return this.bySlug.get(slug.toLowerCase()) ?? []
  }

  published(): readonly { slug: string; norm: string; id: number | null }[] {
    return this.list
  }
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[b.length]
}

export const similarity = (a: string, b: string): number => {
  const m = Math.max(a.length, b.length)
  return m === 0 ? 1 : 1 - levenshtein(a, b) / m
}

export type Candidate = { slug: string; id: number | null; score: number; relation: 'case-or-encoding' | 'numeric-suffix' | 'trailing-characters' | 'similar' }

/** The published posts closest to a slug, best first (only those with a similarity of at least 0.6). */
export function nearestSlugs(slug: string, idx: SlugIndex, limit = 3): Candidate[] {
  const n = norm(slug)
  const base = stripNumeric(n)
  const out: Candidate[] = []
  for (const p of idx.published()) {
    let score: number
    let relation: Candidate['relation']
    if (p.norm === n) {
      score = 1
      relation = 'case-or-encoding'
    } else if (stripNumeric(p.norm) === base && base !== '') {
      score = 0.96
      relation = 'numeric-suffix'
    } else {
      score = similarity(n, p.norm)
      relation = p.norm.startsWith(n) || n.startsWith(p.norm) ? 'trailing-characters' : 'similar'
    }
    if (score >= 0.6) out.push({ slug: p.slug, id: p.id, score, relation })
  }
  return out.sort((a, b) => b.score - a.score || (a.slug < b.slug ? -1 : 1)).slice(0, limit)
}

export type Diagnosis = { cause: Cause; candidate: Candidate | null; candidatePath: string | null; unique: boolean }

const pathSegments = (href: string): string[] => {
  try {
    return new URL(href.trim(), 'https://site.invalid').pathname.split('/').filter(Boolean).map((s) => {
      try {
        return decodeURIComponent(s)
      } catch {
        return s
      }
    })
  } catch {
    return []
  }
}

export function diagnoseLink(c: Classified, href: string, ctx: LinkContext, idx: SlugIndex): Diagnosis {
  const none = (cause: Cause, candidate: Candidate | null = null, unique = false): Diagnosis => ({
    cause,
    candidate,
    candidatePath: candidate ? safePath(ctx, candidate.slug) : null,
    unique,
  })
  if (c.type === 'post-id') return none('post-id-not-in-export')
  const segs = pathSegments(href)
  if (segs.length === 0) return none('other')
  if (segs.length >= 2) {
    if (/^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(segs[0])) return none('external-style-path')
    for (const s of segs) {
      const hit = idx.published().find((p) => p.norm === norm(s))
      if (hit) return none('odd-path-contains-known-slug', { slug: hit.slug, id: hit.id, score: 1, relation: 'case-or-encoding' })
    }
    return none('odd-path')
  }
  const slug = segs[0]
  const entries = idx.entries(slug)
  const post = entries.filter((e) => e.kind === 'post')
  if (post.some((e) => e.hasPassword)) return none('password-protected')
  if (post.some((e) => e.status === 'trash')) return none('trashed')
  if (post.some((e) => e.status !== 'publish')) return none('draft-or-private')
  if (entries.some((e) => e.kind === 'page')) return none('non-post-page')
  if (entries.some((e) => e.kind === 'attachment')) return none('non-post-attachment')
  if (entries.length > 0) return none('non-post-other-type')
  const near = nearestSlugs(slug, idx, 2)
  const best = near[0]
  if (!best || best.score < 0.8) return none('not-in-export', best ?? null)
  const unique = near.length === 1 || near[1].score < 0.95
  const cause: Cause =
    best.relation === 'case-or-encoding'
      ? 'near-match-case-or-encoding'
      : best.relation === 'numeric-suffix'
        ? 'near-match-numeric-suffix'
        : best.relation === 'trailing-characters'
          ? 'near-match-trailing-characters'
          : 'near-match-similar'
  return none(cause, best, unique)
}

function safePath(ctx: LinkContext, slug: string): string | null {
  const final = ctx.published.get(slug) ?? ctx.published.get(slug.toLowerCase())
  if (final === undefined) return null
  try {
    return ctx.articlePath(final)
  } catch {
    return null
  }
}

/** High confidence: similarity >= 0.95 and the only candidate that high. */
export const isHighConfidence = (d: Diagnosis): boolean => d.candidate !== null && d.candidatePath !== null && d.candidate.score >= 0.95 && d.unique && d.cause.startsWith('near-match')

export type ProblemRow = {
  postId: number
  index: number
  type: LinkType
  href: string
  diagnosis: Diagnosis
  key: string | null
}

export const REVIEW_HEADER = ['legacy_post_id', 'link_index', 'kind', 'raw_target', 'cause', 'best_candidate_wp_id', 'best_candidate_slug', 'similarity', 'suggested_new_path', 'from', 'decision']

/** The private review file: one row per problem link; `from` + `decision` (new path | remove-link | keep-text) are what the owner fills in. */
export function reviewCsv(rows: readonly ProblemRow[]): string {
  const lines = rows.map((r) =>
    csvRow([
      r.postId,
      r.index,
      r.type,
      r.href,
      r.diagnosis.cause,
      r.diagnosis.candidate?.id ?? '',
      r.diagnosis.candidate?.slug ?? '',
      r.diagnosis.candidate ? r.diagnosis.candidate.score.toFixed(3) : '',
      r.diagnosis.candidatePath ?? '',
      r.key ? `/${r.key}/` : '',
      '',
    ]),
  )
  return `${REVIEW_HEADER.join(',')}\n${lines.join('\n')}${lines.length ? '\n' : ''}`
}

/** Suggested fixes (private, never applied automatically): only high-confidence unique matches of one-segment addresses. */
export function suggestedFixesCsv(rows: readonly ProblemRow[]): { csv: string; count: number } {
  const seen = new Map<string, string>()
  for (const r of rows) {
    if (!r.key || r.key.includes('/') || !isHighConfidence(r.diagnosis)) continue
    seen.set(r.key, r.diagnosis.candidatePath as string)
  }
  const lines = [...seen.entries()].map(([k, to]) => csvRow([`/${k}/`, to]))
  return { csv: `from,to\n${lines.join('\n')}${lines.length ? '\n' : ''}`, count: lines.length }
}

export function countByCause(rows: readonly ProblemRow[]): Record<string, number> {
  const t: Record<string, number> = {}
  for (const r of rows) t[r.diagnosis.cause] = (t[r.diagnosis.cause] ?? 0) + 1
  return t
}

export const keyOf = (href: string): string | null => fixKey(href, undefined)
