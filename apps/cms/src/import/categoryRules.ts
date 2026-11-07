import { decodeEntities } from './mapping'

/**
 * Rule-based category classifier for posts the WordPress categories and the Yoast primary category could not place.
 *
 * Deterministic and offline. Two kinds of evidence are added up per category:
 *  - phrase rules: phrases matched on normalised text (lowercase letters and digits, one space between words), scored by
 *    where they occur (title, excerpt, body);
 *  - neighbour evidence: the categories of the posts published around the same time that already have one (the archive's
 *    categories follow editorial eras far more than topics; see docs/import.md for the measurement).
 * The winner must clear an absolute score AND a margin over the runner-up. Anything less confident goes to the fallback
 * category and is listed for review. No randomness, no network, no model: same input and same rules, same answer.
 *
 * A phrase is one or more words. A trailing `*` on the last word matches any word starting with it (`interview*`).
 * Rules are data: replace them with `--category-rules <rules.json outside the repo>` (see parseCategoryRules).
 * Unit tested in tests/unit/importCategoryRules.test.ts.
 */

export type CategoryPattern = { phrase: string; weight: number }
export type CategoryRule = {
  /** Stable identifier shown in the provenance (the log and the review file). */
  id: string
  /** Target category slug. It is used only if the category exists (exported by WordPress or already in the database). */
  category: string
  patterns: CategoryPattern[]
}
export type CategoryRuleSet = {
  rules: CategoryRule[]
  /** Winner's total must be at least this. */
  minScore: number
  /** Winner's total must beat the runner-up by at least this. */
  minMargin: number
  /**
   * Neighbour evidence (optional): each category scores `weight` times n / (total + smoothing) (its share of the categorised posts, shrunk when there are few) within
   * `windowMonths` months either side of the post, when there are at least `minPosts` of them. A sparse period widens the
   * window (doubling) up to `maxWindowMonths` until there are enough.
   */
  neighbours?: { windowMonths: number; minPosts: number; weight: number; maxWindowMonths: number; smoothing: number }
}

export type ClassifyInput = {
  title: string
  excerpt: string
  body: string
  /** ISO publication date (UTC), when known. */
  dateGmt?: string | null
  /** Evaluation only: one vote of this category is removed from the neighbours (the post's own label). */
  leaveOut?: string
}

export type Classification = {
  /** Winning category (also given when not confident, as a suggestion). Undefined: nothing matched. */
  category: string | undefined
  /** The highest scoring rule of the winning category (`era-neighbours` for the neighbour evidence). */
  ruleId: string | undefined
  score: number
  runnerUp: string | undefined
  runnerUpScore: number
  confident: boolean
}

/** A phrase counts once in the title, once in the excerpt, and up to BODY_CAP times in the body. */
const BODY_CAP = 2
const FIELD_WEIGHT = { title: 3, excerpt: 2, body: 0.5 } as const
/** Only the start of a long article is read. */
const MAX_BODY_CHARS = 8000

export const ERA_RULE_ID = 'era-neighbours'

type Compiled = { rule: CategoryRule; patterns: { needle: string; weight: number }[] }
export type CompiledRules = { set: CategoryRuleSet; compiled: Compiled[]; order: Map<string, number> }

/** Lowercase letters and digits, single spaces, padded: " word word ". Apostrophes are dropped ("publisher's" is "publishers"). */
export function normalise(text: string): string {
  const t = text
    .toLowerCase()
    .replace(/['’‘`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  return t ? ` ${t} ` : ' '
}

/** HTML to plain text for classification only: tags and shortcodes dropped, entities decoded, truncated. */
export function textForClassification(html: string): string {
  const noTags = html.slice(0, MAX_BODY_CHARS * 4).replace(/<[^>]{0,2000}>/g, ' ').replace(/\[[^\]]{0,200}\]/g, ' ')
  return decodeEntities(noTags).slice(0, MAX_BODY_CHARS)
}

export function compileRules(set: CategoryRuleSet): CompiledRules {
  const order = new Map<string, number>()
  const compiled = set.rules.map((rule, i) => {
    if (!order.has(rule.category)) order.set(rule.category, i)
    const patterns = rule.patterns.map((p) => {
      const prefix = p.phrase.trim().endsWith('*')
      const needle = normalise(p.phrase.replace(/\*+$/, '')).trimEnd()
      // A whole-word phrase ends at a word boundary (trailing space); a `*` phrase may continue the last word.
      return { needle: prefix ? needle : `${needle} `, weight: p.weight }
    })
    return { rule, patterns: patterns.filter((p) => p.needle.trim() !== '') }
  })
  return { set, compiled, order }
}

function countOccurrences(haystack: string, needle: string, cap: number): number {
  let n = 0
  let from = 0
  while (n < cap) {
    const at = haystack.indexOf(needle, from)
    if (at < 0) break
    n++
    from = at + 1
  }
  return n
}

function scoreRule(c: Compiled, fields: { title: string; excerpt: string; body: string }): number {
  let total = 0
  for (const p of c.patterns) {
    if (countOccurrences(fields.title, p.needle, 1)) total += p.weight * FIELD_WEIGHT.title
    if (countOccurrences(fields.excerpt, p.needle, 1)) total += p.weight * FIELD_WEIGHT.excerpt
    total += p.weight * FIELD_WEIGHT.body * countOccurrences(fields.body, p.needle, BODY_CAP)
  }
  return total
}

/** Months since year 0 of an ISO date, or undefined. */
export function monthIndex(dateGmt: string | null | undefined): number | undefined {
  const m = /^(\d{4})-(\d{2})-/.exec(dateGmt ?? '')
  return m ? Number(m[1]) * 12 + Number(m[2]) - 1 : undefined
}

/** Counts of the categories of already categorised posts by publication month (the neighbour evidence). */
export class EraIndex {
  private readonly byMonth = new Map<number, Map<string, number>>()

  add(dateGmt: string | null | undefined, category: string): void {
    const mi = monthIndex(dateGmt)
    if (mi === undefined) return
    const m = this.byMonth.get(mi) ?? new Map<string, number>()
    m.set(category, (m.get(category) ?? 0) + 1)
    this.byMonth.set(mi, m)
  }

  /** Category counts within `windowMonths` either side of the post's month, optionally without one vote for `leaveOut`. */
  votes(dateGmt: string | null | undefined, windowMonths: number, leaveOut?: string): { counts: Map<string, number>; total: number } {
    const counts = new Map<string, number>()
    let total = 0
    const mi = monthIndex(dateGmt)
    if (mi === undefined) return { counts, total }
    for (let k = mi - windowMonths; k <= mi + windowMonths; k++) {
      for (const [c, n] of this.byMonth.get(k) ?? []) {
        counts.set(c, (counts.get(c) ?? 0) + n)
        total += n
      }
    }
    if (leaveOut !== undefined && (counts.get(leaveOut) ?? 0) > 0) {
      counts.set(leaveOut, (counts.get(leaveOut) as number) - 1)
      total -= 1
    }
    return { counts, total }
  }
}

const round = (n: number): number => Math.round(n * 100) / 100

export function classify(input: ClassifyInput, rules: CompiledRules, era?: EraIndex): Classification {
  const fields = { title: normalise(input.title), excerpt: normalise(input.excerpt), body: normalise(input.body) }
  const perCategory = new Map<string, { total: number; best: string; bestScore: number }>()
  const credit = (category: string, ruleId: string, s: number) => {
    const cur = perCategory.get(category)
    if (!cur) perCategory.set(category, { total: s, best: ruleId, bestScore: s })
    else {
      cur.total += s
      if (s > cur.bestScore) {
        cur.best = ruleId
        cur.bestScore = s
      }
    }
  }
  for (const c of rules.compiled) {
    const s = scoreRule(c, fields)
    if (s > 0) credit(c.rule.category, c.rule.id, s)
  }
  const nb = rules.set.neighbours
  if (era && nb) {
    let { counts, total } = era.votes(input.dateGmt, nb.windowMonths, input.leaveOut)
    for (let w = nb.windowMonths * 2; total < nb.minPosts && w <= nb.maxWindowMonths && w > 0; w *= 2) ({ counts, total } = era.votes(input.dateGmt, w, input.leaveOut))
    if (total >= nb.minPosts) for (const [cat, n] of counts) if (n > 0) credit(cat, ERA_RULE_ID, (nb.weight * n) / (total + nb.smoothing))
  }
  // Highest total first; equal totals fall to the order of the rules file, then the slug (fully deterministic).
  const rank = (c: string) => rules.order.get(c) ?? Number.MAX_SAFE_INTEGER
  const ranked = [...perCategory.entries()].sort((a, b) => b[1].total - a[1].total || rank(a[0]) - rank(b[0]) || (a[0] < b[0] ? -1 : 1))
  const top = ranked[0]
  const second = ranked[1]
  const score = round(top?.[1].total ?? 0)
  const runnerUpScore = round(second?.[1].total ?? 0)
  return {
    category: top?.[0],
    ruleId: top?.[1].best,
    score,
    runnerUp: second?.[0],
    runnerUpScore,
    confident: !!top && score >= rules.set.minScore && score - runnerUpScore >= rules.set.minMargin,
  }
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/

/**
 * `--category-rules` content (JSON): `{ "minScore": 6, "minMargin": 3, "rules": [{ "id": "x", "category": "slug",
 * "patterns": [{ "phrase": "word or phrase*", "weight": 2 }] }], "neighbours": { "windowMonths": 2, "minPosts": 8,
 * "weight": 10, "maxWindowMonths": 16, "smoothing": 4 } }` (`neighbours` optional). Anything malformed is refused (undefined).
 */
export function parseCategoryRules(text: string): CategoryRuleSet | undefined {
  if (text.length > 1_000_000) return undefined
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined
  const { minScore, minMargin, rules, neighbours: rawNb } = data as Record<string, unknown>
  if (typeof minScore !== 'number' || typeof minMargin !== 'number' || !Number.isFinite(minScore) || !Number.isFinite(minMargin) || minScore < 0 || minMargin < 0) return undefined
  if (!Array.isArray(rules) || rules.length > 500) return undefined
  const ids = new Set<string>()
  const out: CategoryRule[] = []
  for (const r of rules) {
    if (typeof r !== 'object' || r === null) return undefined
    const { id, category, patterns } = r as Record<string, unknown>
    if (typeof id !== 'string' || !ID_RE.test(id) || id === ERA_RULE_ID || ids.has(id)) return undefined
    if (typeof category !== 'string' || category.length > 100 || !SLUG_RE.test(category)) return undefined
    if (!Array.isArray(patterns) || patterns.length === 0 || patterns.length > 2000) return undefined
    ids.add(id)
    const ps: CategoryPattern[] = []
    for (const p of patterns) {
      if (typeof p !== 'object' || p === null) return undefined
      const { phrase, weight } = p as Record<string, unknown>
      if (typeof phrase !== 'string' || phrase.length === 0 || phrase.length > 100) return undefined
      if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0 || weight > 100) return undefined
      if (normalise(phrase.replace(/\*+$/, '')).trim() === '') return undefined
      ps.push({ phrase, weight })
    }
    out.push({ id, category, patterns: ps })
  }
  let neighbours: CategoryRuleSet['neighbours']
  if (rawNb !== undefined) {
    if (typeof rawNb !== 'object' || rawNb === null) return undefined
    const { windowMonths, minPosts, weight, maxWindowMonths, smoothing } = rawNb as Record<string, unknown>
    if (typeof windowMonths !== 'number' || !Number.isInteger(windowMonths) || windowMonths < 0 || windowMonths > 24) return undefined
    if (typeof minPosts !== 'number' || !Number.isInteger(minPosts) || minPosts < 1 || minPosts > 100_000) return undefined
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0 || weight > 100) return undefined
    if (typeof maxWindowMonths !== 'number' || !Number.isInteger(maxWindowMonths) || maxWindowMonths < windowMonths || maxWindowMonths > 60) return undefined
    if (typeof smoothing !== 'number' || !Number.isFinite(smoothing) || smoothing < 0 || smoothing > 1000) return undefined
    neighbours = { windowMonths, minPosts, weight, maxWindowMonths, smoothing }
  }
  if (out.length === 0 && !neighbours) return undefined
  return { minScore, minMargin, rules: out, ...(neighbours ? { neighbours } : {}) }
}
