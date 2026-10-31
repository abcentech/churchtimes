import type { Endpoint, PayloadRequest } from 'payload'

import { isEditorRole, type UserLike } from '../access/roles'
import { writeAuditLog } from '../lib/audit'
import { isMailConfigured } from '../lib/mailer'
import { createDigestDraft, sendTestDigest } from '../lib/newsletterDigestRunner'
import { createRateLimiter } from '../lib/rateLimit'
import { safeErrorFields, safeErrorSummary } from '../lib/safeLog'
import { isValidEmail } from '../lib/sanitize'

/**
 * Staff tools for the daily digest (editors and admins only; cookie or API-key auth, Payload's CSRF origin check applies):
 * - POST /api/newsletter/digest/dry-run   writes today's issue as a `draft` newsletter-issue and sends nothing (10 per hour per user);
 * - POST /api/newsletter/digest/test-send sends today's issue to the SIGNED-IN staff member's own address only
 *   (never to a subscriber, never to an address in the request), subject prefixed "[TEST]", 5 per hour per user.
 * Both work while the digest schedule is off, so staff can check the result before switching it on.
 */

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } })
const err = (status: number, message: string) => json({ ok: false, errors: [{ message }] }, status)

let testLimiter: ReturnType<typeof createRateLimiter> | undefined
let dryRunLimiter: ReturnType<typeof createRateLimiter> | undefined
const getTestLimiter = () => (testLimiter ??= createRateLimiter({ limit: 5, windowMs: 3600 * 1000 }))
/** Each dry run writes a draft issue: 10 per hour per user is plenty for checking. */
const getDryRunLimiter = () => (dryRunLimiter ??= createRateLimiter({ limit: 10, windowMs: 3600 * 1000 }))
export function resetDigestStaffLimiter(): void {
  testLimiter = undefined
  dryRunLimiter = undefined
}

const staffEditor = (req: PayloadRequest): UserLike | Response => {
  const user = req.user as (UserLike & { email?: string }) | null
  if (!user) return err(401, 'Authentication required.')
  if (!isEditorRole(user)) return err(403, 'Only editors and admins can run the digest tools.')
  return user
}

export const digestDryRunEndpoint: Endpoint = {
  path: '/newsletter/digest/dry-run',
  method: 'post',
  handler: async (req: PayloadRequest) => {
    const user = staffEditor(req)
    if (user instanceof Response) return user
    const limited = getDryRunLimiter().check(String(user.id))
    if (!limited.allowed) return err(429, 'Too many dry runs. Try again later.')
    try {
      const result = await createDigestDraft(req.payload)
      return json({ ok: true, ...result })
    } catch (e) {
      req.payload.logger.error(safeErrorFields(e), 'newsletter digest dry run failed')
      // The error class and code only (e.g. ValidationError, ECONNREFUSED): never a message that could carry content.
      return err(500, `The dry run failed (${safeErrorSummary(e)}).`)
    }
  },
}

export const digestTestSendEndpoint: Endpoint = {
  path: '/newsletter/digest/test-send',
  method: 'post',
  handler: async (req: PayloadRequest) => {
    const user = staffEditor(req)
    if (user instanceof Response) return user
    const email = (user as { email?: string }).email ?? ''
    if (!isValidEmail(email)) return err(400, 'Your staff account has no valid email address.')
    if (!isMailConfigured()) return err(503, 'SMTP is not configured.')
    const limited = getTestLimiter().check(String(user.id))
    if (!limited.allowed) return err(429, 'Too many test sends. Try again later.')
    try {
      const result = await sendTestDigest(req.payload, email)
      if (result.outcome === 'no-stories') return json({ ok: true, outcome: 'no-stories' })
      await writeAuditLog(req, {
        action: 'newsletter.digest-test-send',
        collection: 'newsletter-issues',
        docId: 'test',
        summary: `Digest test send to the requesting staff member (${result.stories ?? 0} stories)`,
      }).catch(() => undefined)
      return json({ ok: true, outcome: 'test-sent', stories: result.stories ?? 0 })
    } catch (e) {
      req.payload.logger.error(safeErrorFields(e), 'newsletter digest test send failed')
      return err(502, 'The test send failed. Check the SMTP settings.')
    }
  },
}

export const digestStaffEndpoints: Endpoint[] = [digestDryRunEndpoint, digestTestSendEndpoint]
