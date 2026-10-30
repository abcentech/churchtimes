import type { Endpoint, PayloadRequest, Where } from 'payload'

import { isAdmin, isEditorInChief, type UserLike } from '../access/roles'
import { writeAuditLog } from '../lib/audit'
import { csvRow } from '../lib/csvSafe'
import { safeErrorFields } from '../lib/safeLog'

const err = (status: number, message: string) =>
  Response.json({ ok: false, errors: [{ message }] }, { status, headers: { 'Cache-Control': 'no-store' } })

export const DONATION_EXPORT_MAX_ROWS = 50_000
const STATUSES = ['pending', 'succeeded', 'failed', 'abandoned'] as const
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** Columns everyone allowed to export gets (no personal data). */
export const DONATION_EXPORT_COLUMNS = [
  'reference', 'createdAt', 'paidAt', 'status', 'provider', 'currency', 'amountMinor', 'amount', 'cause', 'channel', 'anonymous', 'consentAt', 'receiptSentAt',
] as const
/** Added for admins only. */
export const DONATION_EXPORT_PERSONAL_COLUMNS = ['name', 'email', 'providerRef'] as const

/** Major-unit amount as text (two decimals for every supported currency: NGN kobo, USD cents, GBP pence, EUR cents). */
export const majorAmount = (minor: unknown): string =>
  typeof minor === 'number' && Number.isFinite(minor) ? (minor / 100).toFixed(2) : ''

/** The CSV for these rows; personal columns only when `withPersonal`. Cells are formula-injection safe (csvSafe). */
export function donationsCsv(rows: Array<Record<string, unknown>>, withPersonal: boolean): string {
  const cols = [...DONATION_EXPORT_COLUMNS, ...(withPersonal ? DONATION_EXPORT_PERSONAL_COLUMNS : [])]
  const lines = [csvRow(cols)]
  for (const r of rows) {
    lines.push(csvRow(cols.map((c) => (c === 'amount' ? majorAmount(r.amountMinor) : r[c] ?? ''))))
  }
  return lines.join('\r\n') + '\r\n'
}

/**
 * `GET /api/donations/export?status=succeeded&from=2026-10-01&to=2026-10-31` (all three optional; dates are UTC days,
 * inclusive). CSV of the giving ledger for reconciliation. Admin and editor-in-chief; the giver's name, e-mail and the
 * provider reference are included for admins ONLY. Audited (counts and filters, never personal data), never cached.
 */
export const donationsExportEndpoint: Endpoint = {
  path: '/export',
  method: 'get',
  handler: async (req: PayloadRequest) => {
    try {
      const user = req.user as UserLike | null
      if (!user) return err(401, 'Authentication required.')
      if (!isEditorInChief(user)) return err(403, 'Only an admin or the editor-in-chief can export donations.')
      const params = req.searchParams ?? new URL(req.url ?? 'http://localhost/').searchParams
      const and: Where[] = []
      const status = params.get('status')
      if (status !== null && status !== '') {
        if (!(STATUSES as readonly string[]).includes(status)) return err(400, `status must be one of: ${STATUSES.join(', ')}.`)
        and.push({ status: { equals: status } })
      }
      for (const [key, op] of [['from', 'greater_than_equal'], ['to', 'less_than']] as const) {
        const v = params.get(key)
        if (v === null || v === '') continue
        if (!DATE_RE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) return err(400, `${key} must be a date like 2026-10-31.`)
        const day = new Date(`${v}T00:00:00Z`)
        if (key === 'to') day.setUTCDate(day.getUTCDate() + 1)
        and.push({ createdAt: { [op]: day.toISOString() } })
      }
      const withPersonal = isAdmin(user)
      const rows: Array<Record<string, unknown>> = []
      for (let page = 1; ; page++) {
        const batch = await req.payload.find({
          collection: 'donations',
          where: and.length ? { and } : {},
          sort: 'createdAt',
          limit: 1000,
          page,
          depth: 0,
          overrideAccess: true,
          req,
        })
        rows.push(...(batch.docs as unknown as Array<Record<string, unknown>>))
        if (rows.length > DONATION_EXPORT_MAX_ROWS) return err(413, `More than ${DONATION_EXPORT_MAX_ROWS} rows: narrow the dates.`)
        if (!batch.hasNextPage) break
      }
      await writeAuditLog(req, {
        action: 'donation.export',
        collection: 'donations',
        docId: 'export',
        summary: `Exported ${rows.length} donation row(s)${withPersonal ? ' with personal data' : ''}`,
        details: { status: status || null, from: params.get('from') || null, to: params.get('to') || null, rows: rows.length, personal: withPersonal },
      })
      const stamp = new Date().toISOString().slice(0, 10)
      return new Response(donationsCsv(rows, withPersonal), {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="donations-${stamp}.csv"`,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      })
    } catch (e) {
      req.payload.logger.error(safeErrorFields(e), 'donation export failed')
      return err(500, 'Something went wrong. Please try again.')
    }
  },
}
