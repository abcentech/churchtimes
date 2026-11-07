import { createHash } from 'node:crypto'

import {
  type ArticlePathTemplate,
  type TargetResult,
  RedirectConfigError,
  articlePath,
  isInternalTarget,
  normalizePath,
  normalizeRequestPath,
  normalizeTarget,
  targetPathOf,
} from './redirectPaths'

/**
 * Builds the exact-match redirect list (go-live contract C7.2 and C7.3). Pure: no database, no clock, no environment.
 * Callers load the stored rows and the published articles, pass them in with the already-resolved article path
 * template, allowed hosts and legacy hosts, and get back the finished map with the exact bytes to serve.
 *
 * Data problems never stop the list: a row that is invalid, loops, or collides is DROPPED and counted, a staff row beats an
 * article-derived rule for the same address, the lowest article id wins a duplicate `legacyUrl`, and any chain (including a
 * chain into a gone address) is flattened. Only the size caps refuse (`RedirectMapError`, never truncating); a bad
 * configuration (template, hosts) throws `RedirectConfigError` before this function is called. The result satisfies the
 * public host's own rule: no emitted `to` equals another emitted `from`.
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
  /** Article-derived rules not emitted because a staff row owns the same address. */
  overriddenDerived: number
  /** Rules whose `to` was replaced by the final target because it pointed at another rule. */
  flattened: number
  /** Rules turned into a 410 because their target is a gone address. */
  flattenedToGone: number
  dropped: { invalid: number; duplicateStored: number; duplicateLegacy: number; loops: number; absoluteChain: number }
  /** Articles with a `legacyUrl` that emitted nothing, by reason. */
  skipped: {
    sameAddress: number
    invalidLegacyUrl: number
    queryString: number
    root: number
    notPublished: number
    foreignHost: number
    invalidSlug: number
  }
}

export type BuildLimits = { maxRules?: number; maxBytes?: number }

export type BuildInput = {
  articles: readonly ArticleInput[]
  rows: readonly StoredRow[]
  template: ArticlePathTemplate
  allowedHosts: readonly string[]
  /** Host names the old WordPress addresses may carry (`LEGACY_SITE_HOSTS`). */
  legacyHosts: readonly string[]
  now: Date
  limits?: BuildLimits
}

export type BuildResult = {
  map: RedirectMapBody
  /** The exact JSON text to serve or write. */
  body: string
  bytes: number
  stats: BuildStats
  /** One line per dropped, overridden or skipped item, with the rule labels (addresses!). Never log these. */
  details: string[]
}

export type RedirectMapErrorCode = 'too-many-rules' | 'too-large'

/** Only the size caps. The message names no address. */
export class RedirectMapError extends Error {
  readonly code: RedirectMapErrorCode
  constructor(code: RedirectMapErrorCode, message: string) {
    super(message)
    this.name = 'RedirectMapError'
    this.code = code
  }
}

/** A short, address-free code for any error (for logs and CI output). */
export function errorCode(err: unknown): string {
  if (err instanceof RedirectMapError) return err.code
  if (err instanceof RedirectConfigError) return 'config'
  return 'internal-error'
}

type Rule = RedirectRule & { label: string; derived: boolean; id?: number | string }

const rowLabel = (row: StoredRow): string =>
  `rule ${row.id !== undefined ? `#${row.id}` : '(unsaved)'} [${row.source}] ${row.from} -> ${row.to ?? 'gone'} (${row.status})`

const hostOf = (url: string): string | null => /^https?:\/\/([^/?#\s\\@]+)/i.exec(url)?.[1]?.toLowerCase().replace(/:\d+$/, '') ?? null

export type LegacyPathResult =
  | { ok: true; path: string }
  | { ok: false; reason: 'invalid' | 'queryString' | 'root' | 'foreignHost' }

/**
 * The path part of an old WordPress address (`https://www.example.test/2019/05/slug/` or just a path).
 * Skipped, with a reason: an address on a host that is not in `legacyHosts`; a query string (it cannot be an exact-match
 * key: the public host strips it before the lookup, so a rule for `/index.php?p=5` would capture every `/index.php`);
 * the root `/`; anything that is not a canonical-able path.
 */
export function legacyPathOf(legacyUrl: string, legacyHosts: readonly string[] | null = null): LegacyPathResult {
  const trimmed = legacyUrl.trim()
  const match = /^(?:https?:\/\/[^/?#\s\\]+)?([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(trimmed)
  if (!match) return { ok: false, reason: 'invalid' }
  if (legacyHosts !== null && /^https?:\/\//i.test(trimmed)) {
    const host = hostOf(trimmed)
    if (!host || !legacyHosts.map((h) => h.toLowerCase()).includes(host)) return { ok: false, reason: 'foreignHost' }
  }
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
  legacyHosts: readonly string[] | null = null,
): { rule: RedirectRule } | { skip: keyof BuildStats['skipped'] } {
  if (article.status !== 'published') return { skip: 'notPublished' }
  const legacy = typeof article.legacyUrl === 'string' ? article.legacyUrl : ''
  const from = legacyPathOf(legacy, legacyHosts)
  if (!from.ok) return { skip: from.reason === 'invalid' ? 'invalidLegacyUrl' : from.reason }
  let to: string
  try {
    to = articlePath(template, article.slug)
  } catch {
    return { skip: 'invalidSlug' }
  }
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

/** Numeric ids compare as numbers, anything else as text; missing ids sort last. */
const compareId = (a: number | string | undefined, b: number | string | undefined): number => {
  if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? 1 : -1
  const na = Number(a)
  const nb = Number(b)
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0
}

const isoSeconds = (now: Date): string => now.toISOString().replace(/\.\d{3}Z$/, 'Z')

export function buildRedirectMap(input: BuildInput): BuildResult {
  const maxRules = input.limits?.maxRules ?? MAX_RULES
  const maxBytes = input.limits?.maxBytes ?? MAX_BYTES
  const details: string[] = []
  const stats: BuildStats = {
    stored: 0,
    derived: 0,
    overriddenDerived: 0,
    flattened: 0,
    flattenedToGone: 0,
    dropped: { invalid: 0, duplicateStored: 0, duplicateLegacy: 0, loops: 0, absoluteChain: 0 },
    skipped: { sameAddress: 0, invalidLegacyUrl: 0, queryString: 0, root: 0, notPublished: 0, foreignHost: 0, invalidSlug: 0 },
  }
  const byFrom = new Map<string, Rule>()

  // 1. stored rows: invalid rows are dropped; for one address the lowest id wins
  const rows = [...input.rows].sort((a, b) => compareId(a.id, b.id))
  for (const row of rows) {
    const label = rowLabel(row)
    const from = normalizePath(row.from)
    let reason: string | null = null
    let to: string | null = null
    if (!from.ok || from.path !== row.from || row.from === '/') reason = '"from" is not a canonical path'
    else if (!isRedirectStatus(row.status)) reason = 'status must be 301, 302 or 410'
    else if (!isRedirectSource(row.source)) reason = 'unknown source'
    else if (row.status !== 410) {
      const target: TargetResult = normalizeTarget(row.to, input.allowedHosts)
      if (!target.ok || target.to !== row.to) reason = '"to" is not a canonical path or an allowed https address'
      else to = target.to
    }
    if (reason !== null) {
      stats.dropped.invalid++
      details.push(`dropped (invalid): ${label}: ${reason}`)
      continue
    }
    if (byFrom.has(row.from)) {
      stats.dropped.duplicateStored++
      details.push(`dropped (duplicate address): ${label}; kept ${byFrom.get(row.from)!.label}`)
      continue
    }
    byFrom.set(row.from, {
      from: row.from,
      to,
      status: row.status as RedirectStatus,
      source: row.source as RedirectSource,
      label,
      derived: false,
      id: row.id,
    })
    stats.stored++
  }

  // 2. derived rules: lowest article id wins a duplicate legacy address; a staff row beats a derived rule
  const articles = [...input.articles].sort((a, b) => compareId(a.id, b.id))
  const derivedFrom = new Map<string, Rule>()
  for (const article of articles) {
    if (typeof article.legacyUrl !== 'string' || article.legacyUrl.trim() === '') continue
    const derived = deriveRule(article, input.template, input.legacyHosts)
    if ('skip' in derived) {
      stats.skipped[derived.skip]++
      continue
    }
    const { rule } = derived
    const label = `derived rule from article "${article.slug}"${article.id !== undefined ? ` (#${article.id})` : ''} ${rule.from} -> ${rule.to}`
    const staff = byFrom.get(rule.from)
    if (staff) {
      stats.overriddenDerived++
      details.push(`overridden by a staff row: ${label}; kept ${staff.label}`)
      continue
    }
    const earlier = derivedFrom.get(rule.from)
    if (earlier) {
      stats.dropped.duplicateLegacy++
      details.push(`dropped (duplicate legacy address): ${label}; kept ${earlier.label}`)
      continue
    }
    derivedFrom.set(rule.from, { ...rule, label, derived: true, id: article.id })
    stats.derived++
  }
  for (const [from, rule] of derivedFrom) byFrom.set(from, rule)

  // 3. resolve every rule to its final answer: chains are flattened, a gone target makes the rule gone, loops are dropped
  type Final = { to: string | null; status: RedirectStatus; loop: boolean }
  const finals = new Map<Rule, Final>()
  for (const rule of byFrom.values()) {
    let to = rule.to
    let status: RedirectStatus = rule.status
    const visited: Rule[] = [rule]
    let loop = false
    let gone = false
    while (isInternalTarget(to)) {
      const next = byFrom.get(to)
      if (!next) break
      if (next.status === 410) {
        gone = true
        break
      }
      if (visited.includes(next)) {
        loop = true
        break
      }
      visited.push(next)
      if (next.status === 302) status = 302
      to = next.to
    }
    if (loop) {
      stats.dropped.loops++
      details.push(`dropped (loop): ${rule.label}`)
      finals.set(rule, { to: null, status, loop: true })
      continue
    }
    if (gone) {
      if (rule.status !== 410) stats.flattenedToGone++
      finals.set(rule, { to: null, status: 410, loop: false })
      continue
    }
    if (to !== rule.to) stats.flattened++
    finals.set(rule, { to, status, loop: false })
  }

  // 4. an absolute target whose path is itself an address the list answers would be a chain on the public host
  const survivors = [...byFrom.values()].filter((r) => !finals.get(r)!.loop)
  const answered = new Set(survivors.map((r) => r.from))
  const emitted: Array<{ rule: Rule; final: Final }> = []
  for (const rule of survivors) {
    const final = finals.get(rule)!
    if (final.to !== null && !isInternalTarget(final.to) && answered.has(targetPathOf(final.to))) {
      stats.dropped.absoluteChain++
      details.push(`dropped (absolute target is another rule's address): ${rule.label}`)
      continue
    }
    emitted.push({ rule, final })
  }

  const out: RedirectRule[] = emitted
    .map(({ rule, final }) => ({ from: rule.from, to: final.to, status: final.status, source: rule.source }))
    .sort(compareFrom)

  // Invariant (the public host rejects the whole list otherwise): no emitted `to` equals another emitted `from`.
  const emittedFrom = new Set(out.map((r) => r.from))
  for (const r of out) {
    if (r.to !== null && emittedFrom.has(targetPathOf(r.to))) {
      throw new Error('Internal error: the generated redirect list contains a chain.')
    }
  }

  if (out.length > maxRules) {
    throw new RedirectMapError('too-many-rules', `The list has ${out.length} rules; the limit is ${maxRules}. It is refused, never truncated.`)
  }

  const version = `sha256:${createHash('sha256').update(canonicalJson(out)).digest('hex')}`
  const map: RedirectMapBody = { version, generatedAt: isoSeconds(input.now), count: out.length, rules: out }
  const body = JSON.stringify(map)
  const bytes = Buffer.byteLength(body, 'utf8')
  if (bytes > maxBytes) {
    throw new RedirectMapError('too-large', `The list is ${bytes} bytes; the limit is ${maxBytes}. It is refused, never truncated.`)
  }
  return { map, body, bytes, stats, details }
}

/** True when anything was dropped, overridden or skipped (for a counts-only warning in the log). */
export function hasDataWarnings(stats: BuildStats): boolean {
  const d = stats.dropped
  return d.invalid + d.duplicateStored + d.duplicateLegacy + d.loops + d.absoluteChain + stats.overriddenDerived > 0
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
 * against the generated map, looking each one up exactly the way the public host does: `normalizeRequestPath` on the raw
 * request target (query string and fragment removed first), then an exact match. Returns counts only.
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
    // Reduce an absolute URL to the request target a server would receive.
    const target = text.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#\s\\]*/, '')
    const requestTarget = target === '' || target.startsWith('?') || target.startsWith('#') ? `/${target}` : target
    const path = normalizeRequestPath(requestTarget)
    if (path === null) {
      out.unresolved++
      out.unresolvedBy.invalid++
      continue
    }
    const cut = requestTarget.search(/[?#]/)
    if (path === '/' && cut !== -1 && requestTarget[cut] === '?') {
      out.unresolved++
      out.unresolvedBy.queryOnly++
      continue
    }
    const rule = byFrom.get(path)
    if (rule) {
      out.resolved++
      out.byStatus[String(rule.status) as '301' | '302' | '410']++
    } else if (livePaths.has(path)) {
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
  /** The rule a published article derives for the old address `path` (paths compared in canonical form). */
  derivedFrom(path: string): Promise<(RedirectRule & { label: string }) | null>
  /** Slug of the published article whose CURRENT public address is `path`. */
  articleAt(path: string): Promise<string | null>
}

export { rowLabel }

/**
 * The first reason a staff write must be refused, naming the conflicting rule, or null when it is fine.
 * Loops are always refused. A chain is refused when the first hop is a `manual` row (so an editor fixes it), and so is a
 * target that is a gone (410) address or a rule's address reached through an absolute URL. `rank-math` and `legacy-url`
 * rows may chain; they are flattened (or made gone) when the list is generated.
 */
export async function findWriteConflict(c: WriteCandidate, lookup: RuleLookup): Promise<string | null> {
  const self = `${c.from} -> ${c.to ?? 'gone'}`
  if (c.to !== null && c.to === c.from) return `Loop: ${self} points at itself.`

  const same = await lookup.storedFrom(c.from)
  if (same) return `A rule for ${c.from} already exists: ${rowLabel(same)}.`
  // A manual row OVERRIDES the rule an article derives for the same address (explicit beats automatic; the list reports
  // the override). Other sources never override it.
  const sameDerived = await lookup.derivedFrom(c.from)
  if (sameDerived && c.source !== 'manual') return `A rule for ${c.from} already exists: ${sameDerived.label}.`

  const article = await lookup.articleAt(c.from)
  if (article) {
    return `${c.from} is the current public address of the published article "${article}"; a rule here would hide it.`
  }

  if (c.to !== null && !isInternalTarget(c.to)) {
    // An absolute address on the public host's own origin is read as its path.
    const path = targetPathOf(c.to)
    const stored = await lookup.storedFrom(path)
    const derived = stored ? null : await lookup.derivedFrom(path)
    if ((stored || derived) && c.source === 'manual') {
      return `Chain: ${self} points at an address that is itself a rule: ${stored ? rowLabel(stored) : derived!.label}. Point it at that rule's final target.`
    }
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
      if (!next) break
      if (next.gone) {
        if (hop === 0 && c.source === 'manual') {
          return `Chain: ${self} points at ${next.label}, which is gone. Make this row a 410 as well.`
        }
        break
      }
      if (next.to === c.from) return `Loop: ${self} and ${next.label} point at each other.`
      if (hop === 0 && c.source === 'manual') {
        return `Chain: ${self} points at ${next.label}. Manual rows must point at the final address (${next.to}).`
      }
      if (next.to === null || !isInternalTarget(next.to)) break
      at = next.to
    }
  }

  for (const incoming of await lookup.storedTo(c.from)) {
    if (incoming.source === 'manual') {
      return c.status === 410
        ? `Chain: ${rowLabel(incoming)} would point at this gone address (${self}). Make that row a 410 as well.`
        : `Chain: ${rowLabel(incoming)} would point through this rule (${self}). Change that row to point at ${c.to} first.`
    }
  }
  return null
}
