import { createHmac, timingSafeEqual } from 'node:crypto'

export const PREVIEW_TTL_DEFAULT = 900
export const PREVIEW_TTL_MIN = 60
export const PREVIEW_TTL_MAX = 3600

const TEST_SECRET = 'test-only-preview-secret-0123456789abcdef'

const b64u = (buf: Buffer | string): string => Buffer.from(buf).toString('base64url')

function resolveSecret(secret: string | undefined): string {
  if (!secret && process.env.NODE_ENV === 'test') return TEST_SECRET
  if (!secret || secret.length < 32) {
    throw new Error('PREVIEW_SECRET must be set and at least 32 characters long.')
  }
  return secret
}

const sign = (payloadPart: string, secret: string): Buffer =>
  createHmac('sha256', secret).update(payloadPart).digest()

export function clampTtl(ttlSeconds: unknown): number {
  const n =
    typeof ttlSeconds === 'number' && Number.isFinite(ttlSeconds)
      ? Math.floor(ttlSeconds)
      : PREVIEW_TTL_DEFAULT
  return Math.min(PREVIEW_TTL_MAX, Math.max(PREVIEW_TTL_MIN, n))
}

export function createPreviewToken(opts: {
  articleId: number | string
  ttlSeconds?: number
  secret?: string
  now?: Date
}): { token: string; expiresAt: string } {
  const secret = resolveSecret(opts.secret ?? process.env.PREVIEW_SECRET)
  const nowSec = Math.floor((opts.now ?? new Date()).getTime() / 1000)
  const exp = nowSec + clampTtl(opts.ttlSeconds)
  const payloadPart = b64u(JSON.stringify({ a: opts.articleId, e: exp }))
  const token = `${payloadPart}.${b64u(sign(payloadPart, secret))}`
  return { token, expiresAt: new Date(exp * 1000).toISOString() }
}

export function verifyPreviewToken(
  token: unknown,
  secret: string | undefined = process.env.PREVIEW_SECRET,
  now: Date = new Date(),
): { articleId: number | string } | null {
  if (typeof token !== 'string' || token.length > 2048) return null
  const parts = token.split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null
  let key: string
  try {
    key = resolveSecret(secret)
  } catch {
    return null
  }
  const expected = sign(parts[0], key)
  const given = Buffer.from(parts[1], 'base64url')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  try {
    const p = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as {
      a?: unknown
      e?: unknown
    }
    if (typeof p.e !== 'number' || Math.floor(now.getTime() / 1000) >= p.e) return null
    if (typeof p.a !== 'number' && typeof p.a !== 'string') return null
    return { articleId: p.a }
  } catch {
    return null
  }
}
