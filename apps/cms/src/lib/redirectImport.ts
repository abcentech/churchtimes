import { type RedirectRule, type RedirectStatus, type StoredRow, isRedirectStatus } from './redirectMap'
import { isInternalTarget, normalizePath, normalizeTarget } from './redirectPaths'

/**
 * Import of a Rank Math redirects export (go-live contract C7.1), pure part: CSV parsing and the plan.
 *
 * CSV format (UTF-8, comma separated, first row is the header, quotes follow RFC 4180):
 *
 *     from,to,status
 *     /old-slug,/new-slug/,301
 *     /retired-page,,410
 *
 * `status` is optional (default 301). Only exact-match rows are imported: a `from` with `*` (a pattern) is skipped.
 * Imported rows get `source = rank-math`, are flattened to their final target when the list is generated (chains are
 * allowed), but a loop, a duplicate address, an address a derived rule already owns, or an address that is the live
 * address of a published article is skipped. The plan only ever carries counts and the rows to write, never a message
 * that quotes an address, so it is safe to print.
 */

export const IMPORT_MAX_BYTES = 5 * 1024 * 1024
export const IMPORT_MAX_ROWS = 50_000

export type CsvRow = Record<string, string>

/** Minimal RFC 4180 reader. Returns `null` for a malformed file (unterminated quote or missing required column). */
export function parseRedirectCsv(text: string): { rows: CsvRow[] } | { error: string } {
  const src = text.replace(/^﻿/, '')
  const records: string[][] = []
  let field = ''
  let record: string[] = []
  let quoted = false
  let afterQuote = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i++
        } else {
          quoted = false
          afterQuote = true
        }
      } else field += ch
      continue
    }
    if (ch === '"' && field === '' && !afterQuote) {
      quoted = true
    } else if (ch === ',') {
      record.push(field)
      field = ''
      afterQuote = false
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      record.push(field)
      field = ''
      afterQuote = false
      if (record.length > 1 || record[0] !== '') records.push(record)
      record = []
    } else {
      field += ch
    }
  }
  if (quoted) return { error: 'The file ends inside a quoted field.' }
  if (field !== '' || record.length > 0) {
    record.push(field)
    if (record.length > 1 || record[0] !== '') records.push(record)
  }
  if (records.length === 0) return { error: 'The file is empty.' }

  const header = records[0].map((h) => h.trim().toLowerCase())
  const col = (name: string) => header.indexOf(name)
  if (col('from') === -1 || col('to') === -1) return { error: 'The header row must contain "from" and "to" (and optionally "status").' }
  const rows = records.slice(1).map((r) => {
    const row: CsvRow = {}
    header.forEach((h, idx) => {
      row[h] = r[idx] ?? ''
    })
    return row
  })
  return { rows }
}

export type ImportCounts = {
  rows: number
  accepted: number
  invalid: { from: number; to: number; status: number; pattern: number }
  duplicateInFile: number
  alreadyStored: number
  conflictsWithDerived: number
  shadowsArticle: number
  loops: number
}

export type ImportRow = { from: string; to: string | null; status: RedirectStatus }
export type ImportPlan = { accepted: ImportRow[]; counts: ImportCounts }

export function planRedirectImport(input: {
  rows: readonly CsvRow[]
  existing: readonly StoredRow[]
  derived: readonly RedirectRule[]
  livePaths: ReadonlySet<string>
  allowedHosts: readonly string[]
}): ImportPlan {
  const counts: ImportCounts = {
    rows: input.rows.length,
    accepted: 0,
    invalid: { from: 0, to: 0, status: 0, pattern: 0 },
    duplicateInFile: 0,
    alreadyStored: 0,
    conflictsWithDerived: 0,
    shadowsArticle: 0,
    loops: 0,
  }
  // Working map of every address that already answers, for loop detection (410 answers are terminal).
  const working = new Map<string, string | null>()
  for (const r of input.existing) working.set(r.from, r.status === 410 ? null : (r.to ?? null))
  const derivedFrom = new Set<string>()
  for (const r of input.derived) {
    derivedFrom.add(r.from)
    working.set(r.from, r.to)
  }
  const existingFrom = new Set(input.existing.map((r) => r.from))
  const seenInFile = new Set<string>()
  const accepted: ImportRow[] = []

  for (const row of input.rows) {
    const rawFrom = (row.from ?? '').trim()
    if (rawFrom.includes('*')) {
      counts.invalid.pattern++
      continue
    }
    const from = normalizePath(rawFrom)
    if (!from.ok || from.path === '/') {
      counts.invalid.from++
      continue
    }
    const rawStatus = (row.status ?? '').trim()
    const status = rawStatus === '' ? 301 : Number(rawStatus)
    if (!isRedirectStatus(status)) {
      counts.invalid.status++
      continue
    }
    let to: string | null = null
    if (status !== 410) {
      const target = normalizeTarget(row.to ?? '', input.allowedHosts)
      if (!target.ok) {
        counts.invalid.to++
        continue
      }
      to = target.to
    }
    if (seenInFile.has(from.path)) {
      counts.duplicateInFile++
      continue
    }
    seenInFile.add(from.path)
    if (existingFrom.has(from.path)) {
      counts.alreadyStored++
      continue
    }
    if (derivedFrom.has(from.path)) {
      counts.conflictsWithDerived++
      continue
    }
    if (input.livePaths.has(from.path)) {
      counts.shadowsArticle++
      continue
    }
    if (to !== null && isInternalTarget(to)) {
      let at: string | null = to
      let loop = to === from.path
      for (let hop = 0; !loop && at !== null && isInternalTarget(at) && hop < 1000; hop++) {
        if (!working.has(at)) break
        const next: string | null = working.get(at) ?? null
        if (next === from.path) loop = true
        at = next
      }
      if (loop) {
        counts.loops++
        continue
      }
    }
    working.set(from.path, to)
    accepted.push({ from: from.path, to, status })
    counts.accepted++
  }
  return { accepted, counts }
}
