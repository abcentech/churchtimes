import type { Payload, Where } from 'payload'

import { writeSystemAuditLog } from './audit'
import { sendPlainMail } from './mailer'
import {
  buildConfirmUrl,
  buildUnsubscribeUrl,
  generateConfirmToken,
  hashSubscriberEmail,
  hashToken,
  IMPORT_NO_OPTIN_MARKER,
  RECONFIRM_CONSENT_VERSION,
  resolveNewsletterTokenSecret,
  resolvePublicSiteUrl,
  signUnsubscribeToken,
} from './newsletter'
import { CliUsageError, safeErrorSummary } from './safeLog'

/**
 * Re-permission for imported subscribers that carry NO proof of opt-in (stored `pending`, importedFrom
 * `mailchimp-import-no-optin-time`). Only those rows are ever touched. Output and audit rows are COUNTS only: no address
 * and no token is printed, logged or audited.
 */

const DAY_MS = 24 * 3600 * 1000

/** Rows this module may touch: imported without an opt-in time and still unconfirmed. */
const unconfirmedImported: Where[] = [
  { status: { equals: 'pending' } },
  { importedFrom: { equals: IMPORT_NO_OPTIN_MARKER } },
]

export type ReconfirmCounts = {
  eligible: number
  attempted: number
  sent: number
  failed: number
  stoppedEarly: boolean
}

/** `YYYY-MM-DD` to the END of that day (UTC). Undefined for anything else, including impossible dates. */
export function parseDeadline(value: string | undefined): Date | undefined {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  const d = new Date(`${value}T23:59:59.999Z`)
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) return undefined
  return d
}

export type CommandArgs = { apply: boolean; limit?: number; deadline?: string; throttleMs?: number; includeUnsent?: boolean }

/** Shared CLI flag parser. Dry run is the default; `--dry-run` with `--apply` is a usage error. */
export function parseCommandArgs(argv: string[]): CommandArgs {
  const has = (n: string) => argv.includes(n)
  const val = (n: string) => {
    const i = argv.indexOf(n)
    return i >= 0 ? argv[i + 1] : undefined
  }
  if (has('--apply') && has('--dry-run')) throw new CliUsageError('Use either --dry-run or --apply, not both.')
  const out: CommandArgs = { apply: has('--apply') }
  const limit = val('--limit')
  if (limit !== undefined) {
    if (!/^[1-9][0-9]{0,6}$/.test(limit)) throw new CliUsageError('--limit must be a positive whole number.')
    out.limit = Number(limit)
  }
  const deadline = val('--deadline')
  if (deadline !== undefined) {
    if (!parseDeadline(deadline)) throw new CliUsageError('--deadline must be a real date as YYYY-MM-DD.')
    out.deadline = deadline
  }
  const throttle = val('--throttle-ms')
  if (throttle !== undefined) {
    if (!/^[0-9]{1,6}$/.test(throttle)) throw new CliUsageError('--throttle-ms must be a whole number of milliseconds.')
    out.throttleMs = Number(throttle)
  }
  if (has('--include-unsent')) out.includeUnsent = true
  return out
}

export function reconfirmMailText(confirmUrl: string, unsubscribeUrl: string | undefined, deadline: Date): string {
  return [
    'Church Times Nigeria is renewing permission for its newsletter.',
    '',
    'Your address was copied from our previous mailing list, but we cannot show when or how you agreed to receive the newsletter.',
    'Under the Nigeria Data Protection Act we need your clear confirmation before we send you anything.',
    '',
    `To keep receiving the newsletter, open this link before ${deadline.toISOString().slice(0, 10)} (it works once):`,
    confirmUrl,
    '',
    'If you do nothing, we will not send you the newsletter, and after that date we will delete your address from our subscriber list.',
    ...(unsubscribeUrl ? ['', `To be removed now: ${unsubscribeUrl}`] : []),
    '',
    'This is the only message we will send about this.',
  ].join('\n')
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Row = { id: number; email: string }

/**
 * ONE re-permission e-mail per eligible row (pending, imported without opt-in time, never mailed: `lastConfirmMailAt`
 * empty). Resumable: a row is stamped before its mail is sent, so a rerun skips rows already handled; a failed send
 * clears the stamp and token so the row is retried next run. Throttled between sends. Dry run (default) only counts.
 */
export async function runReconfirm(
  payload: Payload,
  options: { apply: boolean; limit?: number; deadline?: string; throttleMs?: number; now?: Date; maxConsecutiveFailures?: number },
): Promise<ReconfirmCounts & { deadline: string }> {
  const now = options.now ?? new Date()
  const deadline = options.deadline ? parseDeadline(options.deadline) : new Date(now.getTime() + 30 * DAY_MS)
  if (!deadline || deadline.getTime() <= now.getTime()) throw new CliUsageError('--deadline must be a date in the future.')
  const deadlineDay = deadline.toISOString().slice(0, 10)

  const where: Where = { and: [...unconfirmedImported, { lastConfirmMailAt: { exists: false } }] }
  const total = await payload.count({ collection: 'subscribers', where, overrideAccess: true })
  const counts: ReconfirmCounts = {
    eligible: options.limit ? Math.min(total.totalDocs, options.limit) : total.totalDocs,
    attempted: 0,
    sent: 0,
    failed: 0,
    stoppedEarly: false,
  }
  if (!options.apply || counts.eligible === 0) return { ...counts, deadline: deadlineDay }

  const siteUrl = resolvePublicSiteUrl()
  if (!siteUrl) throw new CliUsageError('PUBLIC_SITE_URL is missing or unsafe: cannot build confirmation links.')
  if (!process.env.SMTP_HOST?.trim()) throw new CliUsageError('SMTP_HOST is not configured: nothing can be sent.')
  const secret = resolveNewsletterTokenSecret()
  const throttle = options.throttleMs ?? 1000
  const maxFail = options.maxConsecutiveFailures ?? 5
  let consecutiveFailures = 0

  while (counts.attempted < counts.eligible) {
    const batch = await payload.find({
      collection: 'subscribers',
      where,
      sort: 'id',
      limit: Math.min(50, counts.eligible - counts.attempted),
      pagination: false,
      depth: 0,
      overrideAccess: true,
      select: { email: true },
    })
    if (batch.docs.length === 0) break
    for (const doc of batch.docs as unknown as Row[]) {
      counts.attempted++
      const token = generateConfirmToken()
      await payload.update({
        collection: 'subscribers',
        id: doc.id,
        data: {
          confirmTokenHash: hashToken(token),
          confirmTokenExpiresAt: deadline.toISOString(),
          lastConfirmMailAt: now.toISOString(),
          consentTextVersion: RECONFIRM_CONSENT_VERSION,
        } as never,
        overrideAccess: true,
        context: { subscriberSystemWrite: true },
      })
      try {
        await sendPlainMail(payload, {
          to: [doc.email],
          subject: 'Please confirm your Church Times Nigeria newsletter subscription',
          text: reconfirmMailText(
            buildConfirmUrl(siteUrl, token),
            secret ? buildUnsubscribeUrl(siteUrl, signUnsubscribeToken(doc.id, secret)) : undefined,
            deadline,
          ),
        })
        counts.sent++
        consecutiveFailures = 0
      } catch (err) {
        counts.failed++
        consecutiveFailures++
        payload.logger.error({ summary: safeErrorSummary(err) }, 'reconfirm email failed')
        await payload.update({
          collection: 'subscribers',
          id: doc.id,
          data: { confirmTokenHash: null, confirmTokenExpiresAt: null, lastConfirmMailAt: null } as never,
          overrideAccess: true,
          context: { subscriberSystemWrite: true },
        })
        if (consecutiveFailures >= maxFail) {
          counts.stoppedEarly = true
          break
        }
      }
      if (throttle > 0) await sleep(throttle)
    }
    if (counts.stoppedEarly) break
  }

  await writeSystemAuditLog(payload, {
    action: 'subscriber.reconfirm-run',
    collection: 'subscribers',
    docId: 'reconfirm',
    summary: `Re-permission run: ${counts.sent} sent, ${counts.failed} failed`,
    details: { ...counts, deadline: deadlineDay, consentTextVersion: RECONFIRM_CONSENT_VERSION },
  })
  return { ...counts, deadline: deadlineDay }
}

export type PurgeCounts = { eligible: number; purged: number; removedDuplicates: number }

/**
 * Erase unconfirmed imported rows once the deadline has PASSED. Default: only rows that were actually mailed (so nobody is
 * purged without having had the chance to answer); `includeUnsent` also takes rows never mailed. The address is reduced to
 * its salted hash (`erased:<hmac>`, the same suppression record as the staff erase action), name, IP hash and token cleared.
 */
export async function runPurgeUnconfirmed(
  payload: Payload,
  options: { apply: boolean; deadline: string; limit?: number; includeUnsent?: boolean; now?: Date },
): Promise<PurgeCounts> {
  const now = options.now ?? new Date()
  const deadline = parseDeadline(options.deadline)
  if (!deadline) throw new CliUsageError('--deadline must be a real date as YYYY-MM-DD.')
  if (deadline.getTime() >= now.getTime()) {
    throw new CliUsageError('Refusing to purge: the deadline has not passed yet.')
  }
  const where: Where = {
    and: [...unconfirmedImported, ...(options.includeUnsent ? [] : [{ lastConfirmMailAt: { exists: true } }])],
  }
  const total = await payload.count({ collection: 'subscribers', where, overrideAccess: true })
  const counts: PurgeCounts = {
    eligible: options.limit ? Math.min(total.totalDocs, options.limit) : total.totalDocs,
    purged: 0,
    removedDuplicates: 0,
  }
  if (!options.apply || counts.eligible === 0) return counts

  let done = 0
  while (done < counts.eligible) {
    const batch = await payload.find({
      collection: 'subscribers',
      where,
      sort: 'id',
      limit: Math.min(100, counts.eligible - done),
      pagination: false,
      depth: 0,
      overrideAccess: true,
      select: { email: true },
    })
    if (batch.docs.length === 0) break
    for (const doc of batch.docs as unknown as Row[]) {
      done++
      const tombstone = hashSubscriberEmail(doc.email)
      const existing = await payload.count({ collection: 'subscribers', where: { email: { equals: tombstone } }, overrideAccess: true })
      if (existing.totalDocs > 0) {
        await payload.delete({ collection: 'subscribers', id: doc.id, overrideAccess: true })
        counts.removedDuplicates++
      } else {
        await payload.update({
          collection: 'subscribers',
          id: doc.id,
          data: {
            email: tombstone,
            name: null,
            ipHash: null,
            status: 'erased',
            confirmTokenHash: null,
            confirmTokenExpiresAt: null,
          } as never,
          overrideAccess: true,
          context: { subscriberSystemWrite: true },
        })
      }
      counts.purged++
    }
  }
  await writeSystemAuditLog(payload, {
    action: 'subscriber.purge-unconfirmed',
    collection: 'subscribers',
    docId: 'purge',
    summary: `Purged ${counts.purged} unconfirmed imported subscriber(s) after the ${options.deadline} deadline`,
    details: { ...counts, deadline: options.deadline, includeUnsent: Boolean(options.includeUnsent) },
  })
  return counts
}

export function formatReconfirmReport(c: ReconfirmCounts & { deadline: string }, apply: boolean): string {
  return [
    apply ? 'APPLY: re-permission e-mails were sent.' : 'DRY RUN: nothing was sent or written. Re-run with --apply.',
    `deadline:                  ${c.deadline}`,
    `eligible (unmailed):       ${c.eligible}`,
    `attempted:                 ${c.attempted}`,
    `sent:                      ${c.sent}`,
    `failed (will retry):       ${c.failed}`,
    ...(c.stoppedEarly ? ['STOPPED EARLY after repeated send failures: check SMTP, then re-run (it resumes).'] : []),
  ].join('\n')
}

export function formatPurgeReport(c: PurgeCounts, apply: boolean): string {
  return [
    apply ? 'APPLY: unconfirmed imported rows were erased.' : 'DRY RUN: nothing was written. Re-run with --apply.',
    `eligible:                  ${c.eligible}`,
    `erased (hash kept):        ${c.purged}`,
    `of which duplicates removed: ${c.removedDuplicates}`,
  ].join('\n')
}
