import { createHash } from 'node:crypto'

import {
  type ArticlePathTemplate,
  type TargetResult,
  articlePath,
  isInternalTarget,
  normalizePath,
  normalizeTarget,
} from './redirectPaths'

/**
 * Builds the exact-match redirect list (go-live contract C7.2 and C7.3). Pure: no database, no clock, no environment.
 * Callers load the stored rows and the published articles, pass them in with the already-resolved article path
 * template and allowed hosts, and get back either the finished map (with the exact bytes to serve) or a
 * {@link RedirectMapError} that names the offending rules. A bad map is never shipped and a big one is never truncated.
 */

export const MAX_RULES = 20_000
export const MAX_BYTES = 5 * 1024 * 1024

export const REDIRECT_STATUSES = [301, 302, 410] as const
export type RedirectStatus = (typeof REDIRECT_STATUSES)[number]
export const REDIRECT_SOURCES = ['manual', 'rank-math', 'legacy-url'] as const
export type RedirectSource = (typeof REDIRECT_SOURCES)[number]

export const isRedirectStatus = (value: unknown): value is RedirectStatus =>
  (REDIRECT_STATUSES as readonly unknown[]).includes(value)
export const isRedirectSource = (value: unknown): value is RedirectSource =>
  (REDIRECT_SOURCES as readonly unknown[]).includes(value)

/** A stored `redirects` row as loaded from the database. */
export type StoredRow = {
  id?: number | string
  from: string
  to?: string | null
  status: number
  source: string
}

/** The fields of an article the generator needs. */
export type ArticleInput = {
  id?: number | string
  slug: string
  status: string
  legacyUrl?: string | null
}

export type RedirectRule = { from: string; to: string | null; status: RedirectStatus; source: RedirectSource }

export type RedirectMapBody = {
  version: string
  generatedAt: string
  count: number
  rules: RedirectRule[]
}

export type BuildStats = {
  stored: number
  derived: number
  /** Rules whose `to` was replaced by the final target because it pointed at another rule. */
  flattened: number
  /** Rules that point at an address which a `410` rule answers (kept as they are; reported). */
  pointsToGone: number
  /** Articles with a `legacyUrl` that emitted nothing, by reason. */
  skipped: { sameAddress: number; invalidLegacyUrl: number; queryString: number; root: number; notPublished: number }
}

export type BuildLimits = { maxRules?: number; maxBytes?: number }

export type BuildInput = {
  articles: readonly ArticleInput[]
  rows: readonly StoredRow[]
  template: ArticlePathTemplate
  allowedHosts: readonly string[]
  now: Date
  limits?: BuildLimits
}

export type BuildResult = {
  map: RedirectMapBody
  /** The exact JSON text to serve or write. */
  body: string
  bytes: number
  stats: BuildStats
}

export class RedirectMapError extends Error {
  readonly problems: string[]
  constructor(problems: string[]) {
    const shown = problems.slice(0, 20)
    super(
      `Redirect map refused (${problems.length} problem${problems.length === 1 ? '' : 's'}): ${shown.join(' | ')}` +
        (problems.length > shown.length ? ` | ... and ${problems.length - shown.length} more` : ''),
    )
    this.name = 'RedirectMapError'
    this.problems = problems
  }
}

type Rule = RedirectRule & { label: string; derived: boolean }

const rowLabel = (row: StoredRow): string =>
  `rule ${row.id !== undefined ? `#${row.id}` : '(unsaved)'} [${row.source}] ${row.from} -> ${row.to ?? 'gone'} (${row.status})`

/**
 * The path part of an old WordPress address (`https://old.example.test/2019/05/slug/` or just a path).
 * `queryString` and `root` are reasons to emit nothing: a query string cannot be an exact-match key (the public host
 * strips it before the lookup, so a rule for `/index.php?p=5` would capture every `/index.php`), and `/` is never a source.
 */
export function legacyPathOf(
  legacyUrl: string,
): { ok: true; path: string } | { ok: false; reason: 'invalid' | 'queryString' | 'root' } {
  const trimmed = legacyUrl.trim()
  const match = /^(?:https?:\/\/[^/?#\s\\]+)?([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(trimmed)
  if (!match) return { ok: false, reason: 'invalid' }
  if (match[2] !== undefined) return { ok: false, reason: 'queryString' }
  const path = normalizePath(match[1] === '' ? '/' : match[1])
  if (!path.ok) return { ok: false, reason: 'invalid' }
  if (path.path === '/') return { ok: false, reason: 'root' }
  return { ok: true, path: path.path }
}

/** The rule a published article derives from its `legacyUrl`, or why it derives none. */
export function deriveRule(
  article: ArticleInput,
  template: ArticlePathTemplate,
): { rule: RedirectRule } | { skip: keyof BuildStats['skipped'] } {
  if (article.status !== 'published') return { skip: 'notPublished' }
  const legacy = typeof article.legacyUrl === 'string' ? article.legacyUrl : ''
  const from = legacyPathOf(legacy)
  if (!from.ok) return { skip: from.reason === 'invalid' ? 'invalidLegacyUrl' : from.reason }
  const to = articlePath(template, article.slug)
  if (from.path === to) return { skip: 'sameAddress' }
  return { rule: { from: from.path, to, status: 301, source: 'legacy-url' } }
}

/** Stable JSON: object keys sorted, arrays keep their order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const rec = value as Record<string, unknown>
    return `{${Object.keys(rec)
      .filter((k) => rec[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(rec[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

const compareFrom = (a: { from: string }, b: { from: string }): number => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0)

const isoSeconds = (now: Date): string => now.toISOString().replace(/\.\d{3}Z$/, 'Z')

export function buildRedirectMap(input: BuildInput): BuildResult {
  const maxRules = input.limits?.maxRules ?? MAX_RULES
  const maxBytes = input.limits?.maxBytes ?? MAX_BYTES
  const problems: string[] = []
  const stats: BuildStats = {
    stored: 0,
    derived: 0,
    flattened: 0,
    pointsToGone: 0,
    skipped: { sameAddress: 0, invalidLegacyUrl: 0, queryString: 0, root: 0, notPublished: 0 },
  }

  const rules: Rule[] = []

  // 1. stored rows must already be canonical (the collection hook stores them that way)
  for (const row of input.rows) {
    const label = rowLabel(row)
    const from = normalizePath(row.from)
    if (!from.ok || from.path !== row.from || row.from === '/') {
      problems.push(`${label}: "from" is not a canonical path`)
      continue
    }
    if (!isRedirectStatus(row.status)) {
      problems.push(`${label}: status must be 301, 302 or 410`)
      continue
    }
    if (!isRedirectSource(row.source)) {
      problems.push(`${label}: unknown source`)
      continue
    }
    let to: string | null = null
    if (row.status !== 410) {
      const target: TargetResult = normalizeTarget(row.to, input.allowedHosts)
      if (!target.ok || target.to !== row.to) {
        problems.push(`${label}: "to" is not a canonical path or an allowed https address`)
        continue
      }
      to = target.to
    }
    rules.push({ from: row.from, to, status: row.status, source: row.source, label, derived: false })
    stats.stored++
  }

  // 2. derived rules from published articles with a legacyUrl
  for (const article of input.articles) {
    if (typeof article.legacyUrl !== 'string' || article.legacyUrl.trim() === '') continue
    const derived = deriveRule(article, input.template)
    if ('skip' in derived) {
      stats.skipped[derived.skip]++
      continue
    }
    const { rule } = derived
    rules.push({
      ...rule,
      label: `derived rule from article "${article.slug}"${article.id !== undefined ? ` (#${article.id})` : ''} ${rule.from} -> ${rule.to}`,
      derived: true,
    })
    stats.derived++
  }

  // 3. one rule per address
  const byFrom = new Map<string, Rule>()
  for (const rule of rules) {
    const other = byFrom.get(rule.from)
    if (other) problems.push(`Two rules share the address ${rule.from}: ${other.label} and ${rule.label}`)
    else byFrom.set(rule.from, rule)
  }

  // 4. loops always fail; chains are flattened (a 410 is a terminal answer, not a hop)
  const seenCycles = new Set<string>()
  const final = new Map<Rule, { to: string | null; status: RedirectStatus }>()
  for (const rule of byFrom.values()) {
    let to = rule.to
    let status: RedirectStatus = rule.status
    const visited: Rule[] = [rule]
    let gone = false
    while (isInternalTarget(to)) {
      const next = byFrom.get(to)
      if (!next) break
      if (next.status === 410) {
        gone = true
        break
      }
      const at = visited.indexOf(next)
      if (at !== -1) {
        const cycle = visited.slice(at)
        const key = cycle
          .map((r) => r.from)
          .sort()
          .join('\n')
        if (!seenCycles.has(key)) {
          seenCycles.add(key)
          problems.push(`Redirect loop: ${cycle.map((r) => r.label).join(' ; ')}`)
        }
        to = null
        break
      }
      visited.push(next)
      if (next.status === 302) status = 302
      to = next.to
    }
    if (gone) stats.pointsToGone++
    if (to !== null && to !== rule.to) stats.flattened++
    final.set(rule, { to, status })
  }

  if (problems.length > 0) throw new RedirectMapError(problems)

  const out: RedirectRule[] = [...byFrom.values()]
    .map((rule) => {
      const f = final.get(rule)!
      return { from: rule.from, to: f.to, status: f.status, source: rule.source }
    })
    .sort(compareFrom)

  if (out.length > maxRules) {
    throw new RedirectMapError([`The list has ${out.length} rules; the limit is ${maxRules}. It is refused, never truncated.`])
  }

  const version = `sha256:${createHash('sha256').update(canonicalJson(out)).digest('hex')}`
  const map: RedirectMapBody = { version, generatedAt: isoSeconds(input.now), count: out.length, rules: out }
  const body = JSON.stringify(map)
  const bytes = Buffer.byteLength(body, 'utf8')
  if (bytes > maxBytes) {
    throw new RedirectMapError([`The list is ${bytes} bytes; the limit is ${maxBytes}. It is refused, never truncated.`])
  }
  return { map, body, bytes, stats }
}

// ---------------------------------------------------------------------------------------------------------------
// check:redirects (counts only, never the addresses)
// ---------------------------------------------------------------------------------------------------------------

export type CheckSummary = {
  total: number
  ignored: number
  resolved: number
  unresolved: number
  /** `live` = the address is the current path of a published article (needs no redirect). */
  byStatus: { '301': number; '302': number; '410': number; live: number }
  unresolvedBy: { invalid: number; queryOnly: number; noRule: number }
}

/**
 * Classify owner-supplied old addresses (one per line; `#` comments and blank lines ignored; absolute URLs or paths)
 * against the generated map. Returns counts only.
 */
export function checkAddresses(
  lines: readonly string[],
  rules: readonly RedirectRule[],
  livePaths: ReadonlySet<string>,
): CheckSummary {
  const byFrom = new Map(rules.map((r) => [r.from, r]))
  const out: CheckSummary = {
    total: 0,
    ignored: 0,
    resolved: 0,
    unresolved: 0,
    byStatus: { '301': 0, '302': 0, '410': 0, live: 0 },
    unresolvedBy: { invalid: 0, queryOnly: 0, noRule: 0 },
  }
  for (const line of lines) {
    const text = line.trim()
    if (text === '' || text.startsWith('#')) {
      out.ignored++
      continue
    }
    out.total++
    const match = /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#\s\\]+)?([^?#]*)(\?[^#]*)?(#.*)?$/.exec(text)
    const path = match ? normalizePath(match[1] === '' ? '/' : match[1]) : null
    if (!match || !path || !path.ok) {
      out.unresolved++
      out.unresolvedBy.invalid++
      continue
    }
    if (match[2] !== undefined && path.path === '/') {
      out.unresolved++
      out.unresolvedBy.queryOnly++
      continue
    }
    const rule = byFrom.get(path.path)
    if (rule) {
      out.resolved++
      out.byStatus[String(rule.status) as '301' | '302' | '410']++
    } else if (livePaths.has(path.path)) {
      out.resolved++
      out.byStatus.live++
    } else {
      out.unresolved++
      out.unresolvedBy.noRule++
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------
// Write-time conflicts (used by the `redirects` collection hook)
// ---------------------------------------------------------------------------------------------------------------

export type WriteCandidate = {
  id?: number | string
  from: string
  to: string | null
  status: RedirectStatus
  source: RedirectSource
}

/** Read-only view of the other rules, supplied by the caller (database queries in the CMS, fakes in unit tests). */
export type RuleLookup = {
  /** A stored row (other than the candidate) whose `from` is `path`. */
  storedFrom(path: string): Promise<StoredRow | null>
  /** Stored rows (other than the candidate) whose `to` is `path`. */
  storedTo(path: string): Promise<StoredRow[]>
  /** The rule a published article derives for the old address `path`. */
  derivedFrom(path: string): Promise<(RedirectRule & { label: string }) | null>
  /** Slug of the published article whose CURRENT public address is `path`. */
  articleAt(path: string): Promise<string | null>
}

export { rowLabel }

/**
 * The first reason a staff write must be refused, naming the conflicting rule, or null when it is fine.
 * Loops are always refused. A chain is refused when the first hop is a `manual` row (so an editor fixes it);
 * `rank-math` and `legacy-url` rows may chain, they are flattened when the list is generated.
 */
export async function findWriteConflict(c: WriteCandidate, lookup: RuleLookup): Promise<string | null> {
  const self = `${c.from} -> ${c.to ?? 'gone'}`
  if (c.to !== null && c.to === c.from) return `Loop: ${self} points at itself.`

  const same = await lookup.storedFrom(c.from)
  if (same) return `A rule for ${c.from} already exists: ${rowLabel(same)}.`
  const sameDerived = await lookup.derivedFrom(c.from)
  if (sameDerived) return `A rule for ${c.from} already exists: ${sameDerived.label}.`

  const article = await lookup.articleAt(c.from)
  if (article) {
    return `${c.from} is the current public address of the published article "${article}"; a rule here would hide it.`
  }

  if (c.to !== null && isInternalTarget(c.to)) {
    let at: string = c.to
    const seen = new Set<string>([c.from])
    for (let hop = 0; hop < 100; hop++) {
      if (seen.has(at)) break
      seen.add(at)
      const stored = await lookup.storedFrom(at)
      let next: { to: string | null; gone: boolean; label: string } | null = null
      if (stored) {
        next = { to: stored.status === 410 ? null : (stored.to ?? null), gone: stored.status === 410, label: rowLabel(stored) }
      } else {
        const derived = await lookup.derivedFrom(at)
        if (derived) next = { to: derived.to, gone: false, label: derived.label }
      }
      if (!next || next.gone) break
      if (next.to === c.from) return `Loop: ${self} and ${next.label} point at each other.`
      if (hop === 0 && c.source === 'manual') {
        return `Chain: ${self} points at ${next.label}. Manual rows must point at the final address (${next.to}).`
      }
      if (next.to === null || !isInternalTarget(next.to)) break
      at = next.to
    }
  }

  if (c.status !== 410) {
    for (const incoming of await lookup.storedTo(c.from)) {
      if (incoming.source === 'manual') {
        return `Chain: ${rowLabel(incoming)} would point through this rule (${self}). Change that row to point at ${c.to} first.`
      }
    }
  }
  return null
}
