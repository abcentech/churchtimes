import { describe, expect, it } from 'vitest'

import { createPreviewToken, verifyPreviewToken } from '../../src/lib/previewToken'

const SECRET = 'a'.repeat(40)
const now = new Date('2026-10-13T10:00:00Z')

describe('previewToken', () => {
  it('round-trips a valid token', () => {
    const { token, expiresAt } = createPreviewToken({ articleId: 42, secret: SECRET, now })
    expect(expiresAt).toBe('2026-10-13T10:15:00.000Z')
    expect(verifyPreviewToken(token, SECRET, now)).toEqual({ articleId: 42 })
  })

  it('rejects expired tokens', () => {
    const { token } = createPreviewToken({ articleId: 1, ttlSeconds: 60, secret: SECRET, now })
    expect(verifyPreviewToken(token, SECRET, new Date(now.getTime() + 61_000))).toBeNull()
  })

  it('clamps ttl to 60..3600', () => {
    expect(createPreviewToken({ articleId: 1, ttlSeconds: 1, secret: SECRET, now }).expiresAt).toBe(
      '2026-10-13T10:01:00.000Z',
    )
    expect(createPreviewToken({ articleId: 1, ttlSeconds: 999999, secret: SECRET, now }).expiresAt).toBe(
      '2026-10-13T11:00:00.000Z',
    )
  })

  it('rejects tampered payload or signature', () => {
    const { token } = createPreviewToken({ articleId: 1, secret: SECRET, now })
    const [p, s] = token.split('.')
    const forged = Buffer.from(JSON.stringify({ a: 2, e: 9999999999 })).toString('base64url')
    expect(verifyPreviewToken(`${forged}.${s}`, SECRET, now)).toBeNull()
    expect(verifyPreviewToken(`${p}.${s}x`, SECRET, now)).toBeNull()
    expect(verifyPreviewToken(`${p}`, SECRET, now)).toBeNull()
    expect(verifyPreviewToken('', SECRET, now)).toBeNull()
    expect(verifyPreviewToken(undefined, SECRET, now)).toBeNull()
  })

  it('rejects a wrong secret', () => {
    const { token } = createPreviewToken({ articleId: 1, secret: SECRET, now })
    expect(verifyPreviewToken(token, 'b'.repeat(40), now)).toBeNull()
  })

  it('throws for a short secret when creating', () => {
    expect(() => createPreviewToken({ articleId: 1, secret: 'short', now })).toThrow()
  })
})
