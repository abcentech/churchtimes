import type { Payload } from 'payload'

import { hashSubscriberEmail, MAILCHIMP_CONSENT_VERSION } from './newsletter'
import { cleanText, isValidEmail } from './sanitize'

/**
 * Mailchimp subscriber import (go-live contract C4.3). Pure planning (`planMailchimpImport`) plus the database step
 * (`applySubscriberImport`). Used only by the CLI `npm run import:subscribers`; there is no endpoint.
 *
 * Rules: only rows Mailchimp marks as subscribed become `confirmed` (importedFrom `mailchimp-import`); everything else
 * is skipped and counted; commenters, form senders and every other source are never imported. Output is COUNTS only:
 * no address is ever returned from here, printed or logged.
 */

/** Minimal RFC 4180 CSV reader: quoted cells, doubled quotes, CRLF or LF, a leading BOM, blank lines skipped. */
export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let touched = false
  const endCell = () => {
    row.push(cell)
    cell = ''
  }
  const endRow = () => {
    endCell()
    if (touched || row.length > 1 || row[0] !== '') rows.push(row)
    row = []
    touched = false
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i++
        } else quoted = false
      } else cell += ch
      continue
    }
    if (ch === '"') {
      quoted = true
      touched = true
    } else if (ch === ',') {
      endCell()
      touched = true
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      endRow()
    } else {
      cell += ch
      touched = true
    }
  }
  if (cell !== '' || row.length > 0 || touched) endRow()
  return rows
}

const norm = (header: string): string => header.toLowerCase().replace(/[^a-z0-9]/g, '')

const HEADERS = {
  email: ['emailaddress', 'email', 'emailaddr'],
  first: ['firstname', 'fname'],
  last: ['lastname', 'lname'],
  name: ['name', 'fullname'],
  status: ['status', 'memberstatus'],
  optin: ['optintime', 'optin'],
  confirm: ['confirmtime'],
} as const

const findColumn = (headers: string[], names: readonly string[]): number =>
  headers.findIndex((h) => names.includes(norm(h)))

/** Mailchimp writes `YYYY-MM-DD HH:MM:SS` (UTC). Anything else is parsed as a normal date. Unparseable or future: undefined. */
export function parseMailchimpTime(value: string | undefined, now: Date): string | undefined {
  const v = value?.trim()
  if (!v) return undefined
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/.exec(v)
  const d = new Date(m ? `${m[1]}T${m[2]}Z` : v)
  if (Number.isNaN(d.getTime()) || d.getTime() > now.getTime()) return undefined
  return d.toISOString()
}

export type ImportCandidate = { email: string; name?: string; consentAt: string; confirmedAt: string }

export type ImportCounts = {
  rowsRead: number
  /** Valid, subscribed, de-duplicated rows. */
  candidates: number
  skippedNotSubscribed: number
  skippedInvalidEmail: number
  skippedDuplicateInFile: number
  /** Whole file refused: no email column, or no status column without --assume-subscribed. */
  refused?: 'no-email-column' | 'no-status-column'
  // Filled by applySubscriberImport:
  skippedAlreadyPresent: number
  skippedErasedOrSuppressed: number
  wouldCreate: number
  created: number
}

const emptyCounts = (): ImportCounts => ({
  rowsRead: 0,
  candidates: 0,
  skippedNotSubscribed: 0,
  skippedInvalidEmail: 0,
  skippedDuplicateInFile: 0,
  skippedAlreadyPresent: 0,
  skippedErasedOrSuppressed: 0,
  wouldCreate: 0,
  created: 0,
})

export function planMailchimpImport(
  csvText: string,
  options: { assumeSubscribed?: boolean; now?: Date } = {},
): { counts: ImportCounts; candidates: ImportCandidate[] } {
  const now = options.now ?? new Date()
  const counts = emptyCounts()
  const rows = parseCsv(csvText)
  const header = rows.shift()
  if (!header) return { counts, candidates: [] }
  counts.rowsRead = rows.length

  const col = {
    email: findColumn(header, HEADERS.email),
    first: findColumn(header, HEADERS.first),
    last: findColumn(header, HEADERS.last),
    name: findColumn(header, HEADERS.name),
    status: findColumn(header, HEADERS.status),
    optin: findColumn(header, HEADERS.optin),
    confirm: findColumn(header, HEADERS.confirm),
  }
  if (col.email < 0) return { counts: { ...counts, refused: 'no-email-column' }, candidates: [] }
  // Without Mailchimp's own marker we cannot tell subscribed rows from the rest, so nothing is imported unless the
  // operator says the file is Mailchimp's "Subscribed" segment export (which carries no status column).
  if (col.status < 0 && !options.assumeSubscribed) {
    return { counts: { ...counts, refused: 'no-status-column' }, candidates: [] }
  }

  const seen = new Set<string>()
  const candidates: ImportCandidate[] = []
  for (const row of rows) {
    const cell = (i: number) => (i >= 0 ? (row[i] ?? '').trim() : '')
    if (col.status >= 0 && cell(col.status).toLowerCase() !== 'subscribed') {
      counts.skippedNotSubscribed++
      continue
    }
    const email = cell(col.email).toLowerCase()
    if (!isValidEmail(email)) {
      counts.skippedInvalidEmail++
      continue
    }
    if (seen.has(email)) {
      counts.skippedDuplicateInFile++
      continue
    }
    seen.add(email)

    const fullName = cleanText(
      col.first >= 0 || col.last >= 0 ? `${cell(col.first)} ${cell(col.last)}` : cell(col.name),
    )
    const optin = parseMailchimpTime(cell(col.optin), now)
    const confirm = parseMailchimpTime(cell(col.confirm), now)
    const consentAt = optin ?? confirm ?? now.toISOString()
    candidates.push({
      email,
      ...(fullName.length >= 2 && fullName.length <= 120 ? { name: fullName } : {}),
      consentAt,
      confirmedAt: confirm ?? consentAt,
    })
  }
  counts.candidates = candidates.length
  return { counts, candidates }
}

const chunk = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * Database step. Never overwrites an existing row (so an unsubscribed or bounced person is never re-subscribed by a stale
 * export) and never recreates an erased address (its suppression record matches). Dry run (`apply` false) only reads.
 */
export async function applySubscriberImport(
  payload: Payload,
  plan: { counts: ImportCounts; candidates: ImportCandidate[] },
  options: { apply: boolean },
): Promise<ImportCounts> {
  const counts = { ...plan.counts }
  const present = new Set<string>()
  const suppressed = new Set<string>()

  for (const batch of chunk(plan.candidates, 200)) {
    const byEmail = await payload.find({
      collection: 'subscribers',
      where: { email: { in: batch.map((c) => c.email) } },
      limit: batch.length,
      pagination: false,
      depth: 0,
      overrideAccess: true,
      select: { email: true },
    })
    for (const d of byEmail.docs) present.add((d as unknown as { email: string }).email)

    const hashes = new Map(batch.map((c) => [hashSubscriberEmail(c.email), c.email]))
    const byHash = await payload.find({
      collection: 'subscribers',
      where: { email: { in: [...hashes.keys()] } },
      limit: hashes.size,
      pagination: false,
      depth: 0,
      overrideAccess: true,
      select: { email: true },
    })
    for (const d of byHash.docs) {
      const email = hashes.get((d as unknown as { email: string }).email)
      if (email) suppressed.add(email)
    }
  }

  const toCreate = plan.candidates.filter((c) => {
    if (present.has(c.email)) {
      counts.skippedAlreadyPresent++
      return false
    }
    if (suppressed.has(c.email)) {
      counts.skippedErasedOrSuppressed++
      return false
    }
    return true
  })
  counts.wouldCreate = toCreate.length

  if (options.apply) {
    for (const c of toCreate) {
      await payload.create({
        collection: 'subscribers',
        data: {
          email: c.email,
          ...(c.name ? { name: c.name } : {}),
          status: 'confirmed',
          source: 'other',
          consentTextVersion: MAILCHIMP_CONSENT_VERSION,
          consentAt: c.consentAt,
          confirmedAt: c.confirmedAt,
          importedFrom: 'mailchimp-import',
        } as never,
        overrideAccess: true,
        context: { subscriberSystemWrite: true },
      })
      counts.created++
    }
  }
  return counts
}

export async function runSubscriberImport(
  payload: Payload,
  csvText: string,
  options: { apply: boolean; assumeSubscribed?: boolean; now?: Date },
): Promise<ImportCounts> {
  const plan = planMailchimpImport(csvText, options)
  if (plan.counts.refused) return plan.counts
  return applySubscriberImport(payload, plan, options)
}

/** One line per count, no addresses. */
export function formatImportReport(counts: ImportCounts, apply: boolean): string {
  const lines = [apply ? 'APPLY: subscribers were written.' : 'DRY RUN: nothing was written. Re-run with --apply to import.']
  if (counts.refused === 'no-email-column') lines.push('REFUSED: no email column (expected "Email Address" or "email").')
  if (counts.refused === 'no-status-column') {
    lines.push(
      'REFUSED: no Status column, so subscribed rows cannot be told apart. Use Mailchimp\'s full audience export, or pass ' +
        '--assume-subscribed ONLY for the "Subscribed" segment export.',
    )
  }
  lines.push(
    `rows read:                       ${counts.rowsRead}`,
    `importable (valid, subscribed):  ${counts.candidates}`,
    `skipped, not subscribed:         ${counts.skippedNotSubscribed}`,
    `skipped, invalid email:          ${counts.skippedInvalidEmail}`,
    `skipped, duplicate in file:      ${counts.skippedDuplicateInFile}`,
    `skipped, already in the CMS:     ${counts.skippedAlreadyPresent}`,
    `skipped, erased (suppressed):    ${counts.skippedErasedOrSuppressed}`,
    `would create:                    ${counts.wouldCreate}`,
    `created:                         ${counts.created}`,
  )
  return lines.join('\n')
}
