import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { buildSecurityHeaders, hstsMaxAge } from '../../next.config.mjs'
import { mediaStaticDir } from '../../src/lib/mediaDir'

const asEnv = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv
const header = (env: Record<string, string>, key: string) => buildSecurityHeaders(asEnv(env)).find((h: { key: string }) => h.key === key)?.value

describe('next.config security headers (CMS_HSTS_MAX_AGE, CMS_NOINDEX)', () => {
  it('keeps the 180-day HSTS default in production and sends none outside it', () => {
    expect(header({ NODE_ENV: 'production' }, 'Strict-Transport-Security')).toBe('max-age=15552000')
    expect(header({ NODE_ENV: 'development' }, 'Strict-Transport-Security')).toBeUndefined()
    expect(header({ NODE_ENV: 'production' }, 'X-Robots-Tag')).toBeUndefined()
  })

  it('lets staging shorten HSTS and add noindex', () => {
    const env = { NODE_ENV: 'production', CMS_HSTS_MAX_AGE: '300', CMS_NOINDEX: 'true' }
    expect(header(env, 'Strict-Transport-Security')).toBe('max-age=300')
    expect(header(env, 'X-Robots-Tag')).toBe('noindex, nofollow')
  })

  it('rejects an invalid HSTS value instead of ignoring it', () => {
    for (const bad of ['abc', '-1', '1.5', '31536001', '99999999999']) {
      expect(() => hstsMaxAge(asEnv({ CMS_HSTS_MAX_AGE: bad }))).toThrow(/CMS_HSTS_MAX_AGE/)
    }
    expect(hstsMaxAge(asEnv({ CMS_HSTS_MAX_AGE: '0' }))).toBe(0)
  })
})

describe('mediaStaticDir (CMS_MEDIA_DIR)', () => {
  it('defaults to "media"', () => {
    expect(mediaStaticDir({})).toBe('media')
    expect(mediaStaticDir({ CMS_MEDIA_DIR: '  ' })).toBe('media')
  })
  it('accepts an absolute path and refuses a relative one', () => {
    const abs = path.resolve('/tmp/churchtimes-media')
    expect(mediaStaticDir({ CMS_MEDIA_DIR: abs })).toBe(abs)
    expect(() => mediaStaticDir({ CMS_MEDIA_DIR: 'media' })).toThrow(/absolute/)
  })
})
