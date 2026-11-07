import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Paystack webhook signature: the `x-paystack-signature` header is the lowercase hex HMAC-SHA512 of the RAW request body,
 * keyed with the account's secret key (Paystack has no separate webhook secret). See docs/w12/giving.md for the sources.
 *
 * The HMAC is computed over the exact bytes received (never a re-serialised JSON object) and compared in constant time
 * on the decoded 64-byte digests, after a strict shape check, so neither the length nor the content of a guess leaks
 * through timing.
 */

const SIGNATURE_HEX_RE = /^[0-9a-fA-F]{128}$/

export function computeHmacSha512Hex(raw: Buffer, secret: string): string {
  return createHmac('sha512', secret).update(raw).digest('hex')
}

export function verifyHmacSha512(raw: Buffer, header: string | null | undefined, secret: string): boolean {
  if (typeof secret !== 'string' || secret.length === 0) return false
  if (typeof header !== 'string') return false
  const given = header.trim()
  if (!SIGNATURE_HEX_RE.test(given)) return false
  const expected = createHmac('sha512', secret).update(raw).digest()
  const actual = Buffer.from(given, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
