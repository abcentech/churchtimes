import { formatMinor } from './currency'
import type { DonationRow } from './store'

/**
 * Plain-text receipt, sent ONLY after the server has confirmed the payment with the provider. It carries the reference,
 * amount, date, cause and payment method type; never card details (we never receive them) and never anything the reader
 * did not give us. All values are server-side (the cause label and note come from the CMS settings).
 */
export function buildDonationReceipt(
  row: Pick<DonationRow, 'reference' | 'amountMinor' | 'currency' | 'paidAt' | 'channel' | 'name' | 'anonymous'>,
  opts: { causeLabel: string; thankYouNote?: string; testMode?: boolean },
): { subject: string; text: string } {
  const paid = row.paidAt ? new Date(row.paidAt) : new Date()
  const when = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Lagos', timeZoneName: 'short' }).format(paid)
  const greeting = row.name && !row.anonymous ? `Dear ${row.name},` : 'Dear friend,'
  const lines = [
    greeting,
    '',
    opts.thankYouNote?.trim() || 'Thank you for supporting independent journalism at Church Times Nigeria.',
    '',
    'Your gift',
    `  Amount: ${formatMinor(row.amountMinor, row.currency)}`,
    `  Towards: ${opts.causeLabel}`,
    `  Date: ${when}`,
    ...(row.channel ? [`  Paid by: ${row.channel.replace(/_/g, ' ')}`] : []),
    `  Reference: ${row.reference}`,
    '',
    ...(opts.testMode ? ['This was a TEST payment. No money was taken.', ''] : []),
    'The payment was processed by Paystack. Church Times Nigeria never receives or stores your card details.',
    'Keep this email as your receipt. If anything looks wrong, reply with the reference above.',
    '',
    'Church Times Nigeria · Churchtimes Agency Ltd',
  ]
  return { subject: `Your receipt from Church Times Nigeria (${row.reference})`, text: lines.join('\n') }
}
