import { createHash } from 'node:crypto'

const squash = (s: string): string => s.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * Duplicate-detection fingerprint of a public submission: sha256 over the lowercased email, the
 * whitespace-collapsed lowercased title and the whitespace-collapsed lowercased body.
 * Inputs are expected to be already sanitised (see validateSubmissionInput).
 */
export function computeContentHash(input: { email: string; title: string; body: string }): string {
  return createHash('sha256')
    .update([input.email.trim().toLowerCase(), squash(input.title), squash(input.body)].join('\u0000'))
    .digest('hex')
}
