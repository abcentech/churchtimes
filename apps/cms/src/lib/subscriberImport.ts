import { createHash } from 'node:crypto'

import type { Payload } from 'payload'

import { writeSystemAuditLog } from './audit'
import { hashSubscriberEmail, IMPORT_NO_OPTIN_MARKER, MAILCHIMP_CONSENT_VERSION } from './newsletter'
import { cleanText, isValidEmail } from './sanitize'

/**
 * Mailchimp subscriber import (go-live contract C4.3). Pure planning (`planMailchimpImport`) plus the database step
 * (`applySubscriberImport`). Used only by the CLI `npm run import:subscribers`; there is no endpoint.
 *
 * Rules: subscribed rows with an OPTIN_TIME become `confirmed`, those without become `pending` (re-confirmation required);
 * unsubscribed and cleaned rows become blocking rows; everything else is skipped and counted; commenters, form senders and every other source are never imported. Output is COUNTS only:
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
  // Present only in Mailchimp's unsubscribed / cleaned exports: their rows become BLOCKING rows.
  unsub: ['unsubtime', 'unsubscribetime'],
  clean: ['cleantime', 'cleanedtime'],
} as const

const findColumn = (headers: string[], names: readonly string[]): number =>
  headers.findIndex((h) => names.includes(norm(h)))

/**
 * Mailchimp writes EXACTLY `YYYY-MM-DD HH:MM:SS` (UTC). Anything else (other formats, `T` separators, offsets, impossible
 * dates, the future) is NOT a time: undefined, so the row is treated as having no opt-in time.
 */
export function parseMailchimpTime(value: string | undefined, now: Date): string | undefined {
  const v = value?.trim()
  if (!v) return undefined
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(v)
  if (!m) return undefined
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number]
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s))
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== mo - 1 ||
    date.getUTCDate() !== d ||
    date.getUTCHours() !== h ||
    date.getUTCMinutes() !== mi ||
    date.getUTCSeconds() !== s
  ) {
    return undefined
  }
  if (date.getTime() > now.getTime()) return undefined
  return date.toISOString()
}

/**
 * `subscribed` rows become confirmed (with a real OPTIN_TIME) or pending (without one).
 * `unsubscribed` and `bounced` rows are BLOCKING rows: they keep an address out of every send.
 */
export type ImportKind = 'subscribed' | 'unsubscribed' | 'bounced'

/** consentAt is the Mailchimp OPTIN_TIME only; confirmedAt is the CONFIRM_TIME only. Missing means unknown: stored as null. */
export type ImportCandidate = {
  email: string
  kind: ImportKind
  name?: string
  consentAt?: string
  confirmedAt?: string
  blockedAt?: string
}

export type ImportCounts = {
  rowsRead: number
  /** Valid, de-duplicated rows to import (subscribed plus blocking). */
  candidates: number
  skippedNotSubscribed: number
  skippedInvalidEmail: number
  skippedDuplicateInFile: number
  /** Whole file refused: no email column, or no status column without --assume-subscribed. */
  refused?: 'no-email-column' | 'no-status-column'
  /** Subscribed candidates with no OPTIN_TIME: stored `pending` (never sent to), importedFrom "mailchimp-import-no-optin-time". */
  importedWithoutOptinTime: number
  /** Unsubscribed or cleaned rows in the file. */
  blockingCandidates: number
  // Filled by applySubscriberImport:
  skippedAlreadyPresent: number
  skippedErasedOrSuppressed: number
  wouldCreate: number
  created: number
  /** Existing confirmed or pending rows moved to unsubscribed or bounced because the export says so. */
  blockedExisting: number
  fileSha256?: string
}

const emptyCounts = (): ImportCounts => ({
  rowsRead: 0,
  candidates: 0,
  skippedNotSubscribed: 0,
  skippedInvalidEmail: 0,
  skippedDuplicateInFile: 0,
  importedWithoutOptinTime: 0,
  blockingCandidates: 0,
  skippedAlreadyPresent: 0,
  skippedErasedOrSuppressed: 0,
  wouldCreate: 0,
  created: 0,
  blockedExisting: 0,
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
    unsub: findColumn(header, HEADERS.unsub),
    clean: findColumn(header, HEADERS.clean),
  }
  if (col.email < 0) return { counts: { ...counts, refused: 'no-email-column' }, candidates: [] }
  // Without Mailchimp's own marker we cannot tell subscribed rows from the rest, so nothing is imported unless the
  // operator says the file is Mailchimp's "Subscribed" segment export (which carries no status column). An unsubscribed
  // or cleaned export (UNSUB_TIME / CLEAN_TIME) needs no declaration: every row in it is a blocking row.
  const fileKind: ImportKind | undefined =
    col.status >= 0
      ? undefined
      : col.clean >= 0
        ? 'bounced'
        : col.unsub >= 0
          ? 'unsubscribed'
          : options.assumeSubscribed
            ? 'subscribed'
            : undefined
  if (col.status < 0 && !fileKind) {
    return { counts: { ...counts, refused: 'no-status-column' }, candidates: [] }
  }

  const seen = new Set<string>()
  const candidates: ImportCandidate[] = []
  for (const row of rows) {
    const cell = (i: number) => (i >= 0 ? (row[i] ?? '').trim() : '')
    let kind: ImportKind | undefined = fileKind
    if (col.status >= 0) {
      const s = cell(col.status).toLowerCase()
      kind = s === 'subscribed' ? 'subscribed' : s === 'unsubscribed' ? 'unsubscribed' : s === 'cleaned' ? 'bounced' : undefined
      // A "subscribed" row that also carries an unsubscribe or clean time contradicts itself: the safe reading wins.
      if (kind === 'subscribed' && cell(col.clean)) kind = 'bounced'
      else if (kind === 'subscribed' && cell(col.unsub)) kind = 'unsubscribed'
    }
    if (!kind) {
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
    // CONFIRM_TIME only: never `confirm ?? optin`, so a confirmation time is never invented.
    const confirm = parseMailchimpTime(cell(col.confirm), now)
    const blockedAt =
      kind === 'subscribed' ? undefined : parseMailchimpTime(cell(kind === 'bounced' ? col.clean : col.unsub), now)
    candidates.push({
      email,
      kind,
      ...(fullName.length >= 2 && fullName.length <= 120 ? { name: fullName } : {}),
      ...(optin ? { consentAt: optin } : {}),
      ...(confirm ? { confirmedAt: confirm } : {}),
      ...(blockedAt ? { blockedAt } : {}),
    })
  }
  counts.candidates = candidates.length
  counts.blockingCandidates = candidates.filter((c) => c.kind !== 'subscribed').length
  counts.importedWithoutOptinTime = candidates.filter((c) => c.kind === 'subscribed' && !c.consentAt).length
  return { counts, candidates }
}

const chunk = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

type PresentRow = { id: number; email: string; status: string }

/**
 * Database step. Never overwrites an existing row's consent and never recreates an erased address (its suppression record
 * matches). The one change to an existing row is the SAFE direction: a confirmed or pending row that the export lists as
 * unsubscribed or cleaned is moved to unsubscribed or bounced. Dry run (`apply` false) only reads.
 */
export async function applySubscriberImport(
  payload: Payload,
  plan: { counts: ImportCounts; candidates: ImportCandidate[] },
  options: { apply: boolean; operator?: string },
): Promise<ImportCounts> {
  const counts = { ...plan.counts }
  const present = new Map<string, PresentRow>()
  const suppressed = new Set<string>()

  for (const batch of chunk(plan.candidates, 200)) {
    const byEmail = await payload.find({
      collection: 'subscribers',
      where: { email: { in: batch.map((c) => c.email) } },
      limit: batch.length,
      pagination: false,
      depth: 0,
      overrideAccess: true,
      select: { email: true, status: true },
    })
    for (const d of byEmail.docs) {
      const r = d as unknown as PresentRow
      present.set(r.email, r)
    }

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

  const toBlock: Array<{ row: PresentRow; c: ImportCandidate }> = []
  const toCreate = plan.candidates.filter((c) => {
    const existing = present.get(c.email)
    if (existing) {
      counts.skippedAlreadyPresent++
      if (c.kind !== 'subscribed' && (existing.status === 'confirmed' || existing.status === 'pending')) {
        toBlock.push({ row: existing, c })
      }
      return false
    }
    if (suppressed.has(c.email)) {
      counts.skippedErasedOrSuppressed++
      return false
    }
    return true
  })
  counts.wouldCreate = toCreate.length
  counts.importedWithoutOptinTime = toCreate.filter((c) => c.kind === 'subscribed' && !c.consentAt).length
  counts.blockedExisting = toBlock.length

  if (options.apply) {
    const now = new Date().toISOString()
    for (const { row, c } of toBlock) {
      await payload.update({
        collection: 'subscribers',
        id: row.id,
        data: {
          status: c.kind,
          unsubscribedAt: c.blockedAt ?? now,
          confirmTokenHash: null,
          confirmTokenExpiresAt: null,
        } as never,
        overrideAccess: true,
        context: { subscriberSystemWrite: true },
      })
    }
    for (const c of toCreate) {
      const subscribed = c.kind === 'subscribed'
      // No OPTIN_TIME: there is no proof of consent, so the row is `pending` (excluded from every send and from the
      // confirmed export) until the person confirms through the re-permission mail or the sign-up form.
      const confirmed = subscribed && Boolean(c.consentAt)
      await payload.create({
        collection: 'subscribers',
        data: {
          email: c.email,
          ...(c.name ? { name: c.name } : {}),
          status: subscribed ? (confirmed ? 'confirmed' : 'pending') : c.kind,
          source: 'other',
          consentTextVersion: MAILCHIMP_CONSENT_VERSION,
          ...(c.consentAt ? { consentAt: c.consentAt } : {}),
          ...(confirmed && c.confirmedAt ? { confirmedAt: c.confirmedAt } : {}),
          ...(subscribed ? {} : { unsubscribedAt: c.blockedAt ?? now }),
          importedFrom: subscribed && !c.consentAt ? IMPORT_NO_OPTIN_MARKER : 'mailchimp-import',
        } as never,
        overrideAccess: true,
        context: { subscriberSystemWrite: true },
      })
      counts.created++
    }
    await writeSystemAuditLog(payload, {
      action: 'subscriber.import',
      collection: 'subscribers',
      docId: 'import',
      summary: `Mailchimp import applied: ${counts.created} created, ${counts.blockedExisting} blocked`,
      details: { ...counts, operator: options.operator ?? null },
    })
  }
  return counts
}

export async function runSubscriberImport(
  payload: Payload,
  csvText: string,
  options: { apply: boolean; assumeSubscribed?: boolean; now?: Date; operator?: string },
): Promise<ImportCounts> {
  const plan = planMailchimpImport(csvText, options)
  plan.counts.fileSha256 = createHash('sha256').update(csvText).digest('hex')
  if (plan.counts.refused) return plan.counts
  return applySubscriberImport(payload, plan, options)
}

/** One line per count, no addresses. */
export function formatImportReport(counts: ImportCounts, apply: boolean): string {
  const lines = [apply ? 'APPLY: subscribers were written.' : 'DRY RUN: nothing was written. Re-run with --apply to import.']
  if (counts.refused === 'no-email-column') lines.push('REFUSED: no email column (expected "Email Address" or "email").')
  if (counts.refused === 'no-status-column') {
    lines.push(
      'REFUSED: no Status column, so subscribed rows cannot be told apart. Use the full Mailchimp audience export, or pass ' +
        '--assume-subscribed ONLY for the "Subscribed" segment export.',
    )
  }
  lines.push(
    `rows read:                       ${counts.rowsRead}`,
    `importable (valid rows):         ${counts.candidates}`,
    `  of which unsubscribed/cleaned: ${counts.blockingCandidates} (imported as blocking rows)`,
    `skipped, other status:           ${counts.skippedNotSubscribed}`,
    `skipped, invalid email:          ${counts.skippedInvalidEmail}`,
    `skipped, duplicate in file:      ${counts.skippedDuplicateInFile}`,
    `skipped, already in the CMS:     ${counts.skippedAlreadyPresent}`,
    `skipped, erased (suppressed):    ${counts.skippedErasedOrSuppressed}`,
    `existing rows set to blocked:    ${counts.blockedExisting}`,
    `would create:                    ${counts.wouldCreate}`,
    `created:                         ${counts.created}`,
    `of which without an opt-in time:  ${counts.importedWithoutOptinTime} (stored pending: they receive nothing until they re-confirm; see npm run newsletter:reconfirm)`,
  )
  if (counts.fileSha256) lines.push(`file sha256:                     ${counts.fileSha256}`)
  return lines.join('\n')
}
