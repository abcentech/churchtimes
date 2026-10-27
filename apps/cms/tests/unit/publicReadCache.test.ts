import { describe, expect, it } from 'vitest'

import { publicReadCacheControl } from '../../src/proxy'

const q = (s = '') => new URLSearchParams(s)
const h = (o: Record<string, string> = {}) => new Headers(o)

describe('publicReadCacheControl', () => {
  it('caches anonymous GET/HEAD of the article and category lists', () => {
    expect(publicReadCacheControl('GET', '/api/articles', q('limit=20'), h())).toBe('public, max-age=60')
    expect(publicReadCacheControl('HEAD', '/api/articles/', q(), h())).toBe('public, max-age=60')
    expect(publicReadCacheControl('GET', '/api/categories', q(), h())).toBe('public, max-age=300')
  })
  it('never for credentials, drafts, previews, writes or other routes', () => {
    expect(publicReadCacheControl('GET', '/api/articles', q(), h({ cookie: 'payload-token=x' }))).toBeNull()
    expect(publicReadCacheControl('GET', '/api/articles', q(), h({ authorization: 'JWT x' }))).toBeNull()
    expect(publicReadCacheControl('GET', '/api/articles', q('draft=true'), h())).toBeNull()
    expect(publicReadCacheControl('GET', '/api/articles', q('preview=t'), h())).toBeNull()
    expect(publicReadCacheControl('POST', '/api/articles', q(), h())).toBeNull()
    expect(publicReadCacheControl('GET', '/api/users/me', q(), h())).toBeNull()
    expect(publicReadCacheControl('GET', '/api/articles/12', q(), h())).toBeNull()
  })
})
