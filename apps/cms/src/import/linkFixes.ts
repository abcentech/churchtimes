import fs from 'node:fs'

import { normalizePath } from '../lib/redirectPaths'
import { hostKey } from './linkSiteHosts'
import { classifyHref, NON_SITE_TYPES, type Classified, type LinkContext } from './linkClassify'
import { isInsideRepo } from './safePaths'

/**
 * Link fixes: a plain file (CSV or JSON, kept OUTSIDE every repository) in which the owner or an editor decides, link by
 * link, what happens to a link the importer could not resolve: `old path or slug -> new path | remove-link | keep-text`.
 * Entries are validated (a new path must be a root-relative article path under the configured article path template; no
 * host, no `javascript:`), applied only to links that are still unresolved (a fix never overrides a link that works), and
 * reported as COUNTS only. Applying twice gives the same result: the fix is read from the source text every time.
 *
 * CSV: a header row is optional; with one, the columns are found by name (`from` / `old` / `path` / `slug` and
 * `to` / `new` / `decision` / `fix`), so the private review file the link audit writes can be saved as it is. Without one,
 * column 1 is the old path or slug and column 2 the decision. JSON: `{"old-slug": "/new-slug/"}` or `[{"from": "...", "to": "..."}]`.
 * A blank decision means "not decided yet" and is skipped (counted as undecided).
 */

export type LinkFixAction = { kind: 'path'; to: string } | { kind: 'remove' }

export type LinkFixes = {
  entries: ReadonlyMap<string, LinkFixAction>
  /** Rows with a decision that failed validation. */
  invalid: number
  /** Rows without a decision (still to be decided). */
  undecided: number
}

export class LinkFixesError extends Error {
  constructor(readonly code: 'LINK_FIXES_UNREADABLE' | 'LINK_FIXES_TOO_LARGE' | 'LINK_FIXES_BAD_FORMAT' | 'LINK_FIXES_INSIDE_REPO') {
    super(code)
    this.name = 'LinkFixesError'
  }
}

const MAX_BYTES = 4 * 1024 * 1024
const MAX_ENTRIES = 50_000
const REMOVE_WORDS = new Set(['remove-link', 'keep-text'])
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f]')

/** The text of one CSV row set (RFC 4180: quotes, doubled quotes, commas and line breaks inside quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  const src = text.replace(/^﻿/, '')
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"'
          i++
        } else quoted = false
      } else cell += ch
    } else if (ch === '"' && cell === '') quoted = true
    else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(cell)
      cell = ''
      if (row.some((c) => c.trim() !== '')) rows.push(row)
      row = []
    } else cell += ch
  }
  row.push(cell)
  if (row.some((c) => c.trim() !== '')) rows.push(row)
  return rows
}

/** Undo the leading `'` a spreadsheet-safe CSV writer adds before a cell that starts with a formula character. */
const unquoteFormula = (s: string): string => (/^'[=+\-@\t\r]/.test(s) ? s.slice(1) : s)

const safeDecode = (s: string): string => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/**
 * The matching key of an old address: its path segments, decoded, lower-case, joined by `/` (so `/Old-Slug/`, `old-slug`
 * and `https://x.test/old-slug/?a=1#b` are the same key). Null when it is not an address of this site.
 */
export function fixKey(input: string, siteHosts?: ReadonlySet<string>): string | null {
  let s = input.trim()
  if (s === '' || CONTROL.test(s) || s.includes('\\')) return null
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s)
      if (siteHosts && !siteHosts.has(hostKey(u.hostname))) return null
      s = u.pathname
    } catch {
      return null
    }
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(s) || s.startsWith('//')) return null
  s = s.split(/[?#]/)[0]
  const segs = s.split('/').filter((x) => x !== '').map((x) => safeDecode(x).toLowerCase())
  if (segs.length === 0 || segs.length > 8 || segs.some((x) => x === '.' || x === '..' || x.includes('/') || CONTROL.test(x))) return null
  return segs.join('/')
}

/** The part of an article path template before `{slug}` (`/` or `/reports/`). */
export const templatePrefix = (template: string): string => template.slice(0, Math.max(0, template.indexOf('{slug}'))) || '/'

/** Validate a decision's target: `remove-link`, `keep-text`, or a root-relative path under the article path template. */
export function parseTarget(raw: string, opts: { articleTemplate: string; siteHosts?: ReadonlySet<string> }): LinkFixAction | null {
  let t = unquoteFormula(raw).trim()
  if (REMOVE_WORDS.has(t.toLowerCase())) return { kind: 'remove' }
  if (/^https?:\/\//i.test(t)) {
    // An address on this site (any of its hosts) is the same as its path; any other host is refused.
    try {
      const u = new URL(t)
      if (!opts.siteHosts || !opts.siteHosts.has(hostKey(u.hostname)) || u.username || u.password) return null
      t = u.pathname
    } catch {
      return null
    }
  }
  if (!t.startsWith('/') || t.startsWith('//') || /^\/*[a-z][a-z0-9+.-]*:/i.test(t)) return null
  const n = normalizePath(t)
  if (!n.ok) return null
  if (!n.path.startsWith(templatePrefix(opts.articleTemplate))) return null
  return { kind: 'path', to: n.path }
}

const HEADER_FROM = new Set(['from', 'old', 'path', 'slug', 'old_path', 'old-path', 'old_slug'])
const HEADER_TO = new Set(['to', 'new', 'decision', 'fix', 'new_path', 'new-path'])

export type ParseOptions = { articleTemplate: string; siteHosts?: ReadonlySet<string> }

/** Parse the text of a fixes file. `format` is chosen by the caller from the file name. Never throws for a bad row (it is counted). */
export function parseLinkFixes(text: string, format: 'csv' | 'json', opts: ParseOptions): LinkFixes {
  const pairs: [string, string][] = []
  if (format === 'json') {
    let data: unknown
    try {
      data = JSON.parse(text.replace(/^﻿/, ''))
    } catch {
      throw new LinkFixesError('LINK_FIXES_BAD_FORMAT')
    }
    if (Array.isArray(data)) {
      for (const e of data) {
        const o = e as Record<string, unknown> | null
        const from = o && typeof o === 'object' ? (o.from ?? o.old ?? o.path ?? o.slug) : undefined
        const to = o && typeof o === 'object' ? (o.to ?? o.new ?? o.decision ?? o.fix) : undefined
        pairs.push([typeof from === 'string' ? from : '', typeof to === 'string' ? to : ''])
      }
    } else if (data && typeof data === 'object') {
      for (const [k, v] of Object.entries(data)) pairs.push([k, typeof v === 'string' ? v : ''])
    } else throw new LinkFixesError('LINK_FIXES_BAD_FORMAT')
  } else {
    const rows = parseCsv(text)
    let fromAt = 0
    let toAt = 1
    let start = 0
    const head = rows[0]?.map((c) => c.trim().toLowerCase())
    if (head && head.some((c) => HEADER_FROM.has(c)) && head.some((c) => HEADER_TO.has(c))) {
      fromAt = head.findIndex((c) => HEADER_FROM.has(c))
      toAt = head.findIndex((c) => HEADER_TO.has(c))
      start = 1
    }
    for (const r of rows.slice(start)) pairs.push([r[fromAt] ?? '', r[toAt] ?? ''])
  }
  if (pairs.length > MAX_ENTRIES) throw new LinkFixesError('LINK_FIXES_TOO_LARGE')
  const entries = new Map<string, LinkFixAction>()
  let invalid = 0
  let undecided = 0
  const conflicted = new Set<string>()
  for (const [fromRaw, toRaw] of pairs) {
    if (toRaw.trim() === '') {
      undecided++
      continue
    }
    const key = fixKey(unquoteFormula(fromRaw), opts.siteHosts)
    const action = key === null ? null : parseTarget(toRaw, opts)
    if (key === null || action === null) {
      invalid++
      continue
    }
    const had = entries.get(key)
    if (conflicted.has(key)) {
      invalid++
      continue
    }
    if (had && JSON.stringify(had) !== JSON.stringify(action)) {
      // Two different decisions for one address: neither is applied.
      entries.delete(key)
      conflicted.add(key)
      invalid += 2
      continue
    }
    entries.set(key, action)
  }
  return { entries, invalid, undecided }
}

/** Read a fixes file (outside every repository, at most 4 MB). `.json` is JSON, anything else CSV. */
export function readLinkFixesFile(file: string, opts: ParseOptions): LinkFixes {
  if (isInsideRepo(file)) throw new LinkFixesError('LINK_FIXES_INSIDE_REPO')
  let text: string
  try {
    if (fs.statSync(file).size > MAX_BYTES) throw new LinkFixesError('LINK_FIXES_TOO_LARGE')
    text = fs.readFileSync(file, 'utf8')
  } catch (e) {
    throw e instanceof LinkFixesError ? e : new LinkFixesError('LINK_FIXES_UNREADABLE')
  }
  return parseLinkFixes(text, /\.json$/i.test(file) ? 'json' : 'csv', opts)
}

export type LinkFixSummary = {
  /** Valid entries in the file. */
  entries: number
  invalid: number
  undecided: number
  /** Link occurrences changed (counted each time a link was resolved through a fix). */
  appliedLinks: number
  /** Entries that matched at least one link. */
  entriesUsed: number
  /** Valid entries that matched no unresolved link in this run. */
  unmatchedEntries: number
  /** Entries whose new path does not lead to an article (or category or home page) that will exist; they are never applied. */
  targetNotFound: number
}

export type LinkFixer = {
  /** The decision for an unresolved site link, or null when no fix applies. */
  find: (url: string) => { to: string | null; remove: boolean; reason: string } | null
  /** Turn counting of applied links off (a conversion pass whose output is thrown away) or on. */
  counting: (on: boolean) => void
  summary: () => LinkFixSummary
}

export const FIX_REASON_PATH = 'resolved by a link fix'
export const FIX_REASON_REMOVE = 'link removed by a link fix'

/** Bind fixes to the classification context of a run (the new path is checked against what will exist). */
export function createLinkFixer(fixes: LinkFixes, ctx: LinkContext): LinkFixer {
  const used = new Set<string>()
  const badTarget = new Set<string>()
  let applied = 0
  let count = true
  const valid = (key: string, a: LinkFixAction): boolean => {
    if (a.kind === 'remove') return true
    if (badTarget.has(key)) return false
    if (classifyHref(a.to, ctx).resolved) return true
    badTarget.add(key)
    return false
  }
  return {
    find(url) {
      let parsed: URL
      try {
        parsed = new URL(url.trim(), 'https://site.invalid')
      } catch {
        return null
      }
      const keys: string[] = []
      const k = fixKey(parsed.pathname)
      if (k !== null) {
        keys.push(k)
        const last = k.split('/').pop() as string
        if (last !== k) keys.push(last)
      }
      for (const key of keys) {
        const a = fixes.entries.get(key)
        if (!a || !valid(key, a)) continue
        used.add(key)
        if (count) applied++
        if (a.kind === 'remove') return { to: null, remove: true, reason: FIX_REASON_REMOVE }
        const hash = parsed.hash && !CONTROL.test(parsed.hash) && !/[\\\s]/.test(parsed.hash) && !a.to.includes('#') ? parsed.hash : ''
        return { to: `${a.to}${hash}`, remove: false, reason: FIX_REASON_PATH }
      }
      return null
    },
    counting(on) {
      count = on
    },
    summary() {
      // A target that was never looked up (no link used the entry) is still checked, so a typo shows up even when unmatched.
      for (const [key, a] of fixes.entries) if (a.kind === 'path') valid(key, a)
      return {
        entries: fixes.entries.size,
        invalid: fixes.invalid,
        undecided: fixes.undecided,
        appliedLinks: applied,
        entriesUsed: used.size,
        unmatchedEntries: [...fixes.entries.keys()].filter((key) => !used.has(key) && !badTarget.has(key)).length,
        targetNotFound: badTarget.size,
      }
    },
  }
}

/** A classified link with the fix (if any) applied; only an unresolved site link is ever changed. */
export function applyFixToClassified(c: Classified, href: string, fixer: LinkFixer | undefined): Classified {
  if (!fixer || c.resolved || NON_SITE_TYPES.has(c.type)) return c
  const f = fixer.find(href)
  return f ? { ...c, resolved: true, to: f.to, reason: f.reason } : c
}

export function formatLinkFixes(s: LinkFixSummary): string {
  return [
    'Link fixes (counts only)',
    `  entries in the file: ${s.entries} valid, ${s.invalid} invalid, ${s.undecided} not decided yet`,
    `  links changed by a fix: ${s.appliedLinks} (entries used: ${s.entriesUsed})`,
    `  unmatched entries (no unresolved link in this run): ${s.unmatchedEntries}`,
    `  entries whose new path does not exist (not applied): ${s.targetNotFound}`,
  ].join('\n')
}
