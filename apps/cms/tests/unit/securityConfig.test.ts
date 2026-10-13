import { describe, expect, it } from 'vitest'

import {
  checkOriginList,
  normaliseOrigin,
  parseOrigin,
  validateProductionEnv,
} from '../../src/lib/securityConfig'

const good = {
  NODE_ENV: 'production',
  PAYLOAD_SECRET: 'a'.repeat(40),
  PREVIEW_SECRET: 'b'.repeat(40),
  IP_HASH_SALT: 'c'.repeat(20),
  TURNSTILE_SECRET_KEY: '0x4AAAAAAAreal-looking-secret',
  CMS_PUBLIC_URL: 'https://cms.example.org',
  CMS_CORS_ORIGINS: 'https://www.example.org',
  CMS_CSRF_ORIGINS: 'https://cms.example.org',
  PUBLIC_SUBMISSION_ORIGINS: 'https://www.example.org',
  TRUST_PROXY: 'true',
} as NodeJS.ProcessEnv

describe('origin helpers', () => {
  it('parses bare origins only', () => {
    expect(parseOrigin('https://a.org')).not.toBeNull()
    expect(parseOrigin('https://a.org:8443')).not.toBeNull()
    for (const bad of ['https://a.org/', 'https://a.org/x', 'a.org', 'ftp://a.org', 'https://user@a.org', '*']) {
      expect(parseOrigin(bad), bad).toBeNull()
    }
  })
  it('normalises trailing slashes', () => {
    expect(normaliseOrigin('https://CMS.example.org/')).toBe('https://cms.example.org')
    expect(normaliseOrigin('*')).toBe('*')
  })
  it('rejects wildcards everywhere and http outside localhost-in-dev', () => {
    expect(checkOriginList(['*'], { name: 'X', production: false })).toHaveLength(1)
    expect(checkOriginList(['https://*.example.org'], { name: 'X', production: true })).toHaveLength(1)
    expect(checkOriginList(['http://localhost:5173'], { name: 'X', production: false })).toEqual([])
    expect(checkOriginList(['http://localhost:5173'], { name: 'X', production: true })).toHaveLength(1)
    expect(checkOriginList(['http://example.org'], { name: 'X', production: false })).toHaveLength(1)
    expect(checkOriginList(['https://example.org'], { name: 'X', production: true })).toEqual([])
  })
})

describe('validateProductionEnv', () => {
  it('accepts a complete, secure configuration', () => {
    expect(validateProductionEnv(good).problems).toEqual([])
  })

  it('requires TURNSTILE_SECRET_KEY and rejects Cloudflare dummy secrets', () => {
    expect(validateProductionEnv({ ...good, TURNSTILE_SECRET_KEY: '' }).problems.join()).toMatch(
      /TURNSTILE_SECRET_KEY is required/,
    )
    expect(
      validateProductionEnv({ ...good, TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA' }).problems.join(),
    ).toMatch(/dummy/)
  })

  it('requires an https CMS_PUBLIC_URL without a trailing slash', () => {
    expect(validateProductionEnv({ ...good, CMS_PUBLIC_URL: '' }).problems.join()).toMatch(/CMS_PUBLIC_URL is required/)
    expect(validateProductionEnv({ ...good, CMS_PUBLIC_URL: 'http://cms.example.org' }).problems.join()).toMatch(/https/)
    expect(validateProductionEnv({ ...good, CMS_PUBLIC_URL: 'https://cms.example.org/' }).problems.join()).toMatch(
      /bare origin/,
    )
  })

  it('rejects wildcard and http origins in CORS / CSRF / submission lists', () => {
    for (const key of ['CMS_CORS_ORIGINS', 'CMS_CSRF_ORIGINS', 'PUBLIC_SUBMISSION_ORIGINS']) {
      expect(validateProductionEnv({ ...good, [key]: '*' }).problems.join(), key).toMatch(/wildcard/)
      expect(validateProductionEnv({ ...good, [key]: 'http://localhost:5173' }).problems.join(), key).toMatch(/https/)
    }
  })

  it('requires strong, distinct secrets', () => {
    expect(validateProductionEnv({ ...good, PAYLOAD_SECRET: 'short' }).problems.join()).toMatch(/PAYLOAD_SECRET/)
    expect(validateProductionEnv({ ...good, PREVIEW_SECRET: good.PAYLOAD_SECRET }).problems.join()).toMatch(/differ/)
    expect(validateProductionEnv({ ...good, IP_HASH_SALT: 'short' }).problems.join()).toMatch(/IP_HASH_SALT/)
  })

  it('requires TRUST_PROXY=true in production (the app always runs behind a reverse proxy)', () => {
    for (const value of [undefined, '', 'false', 'TRUE', '1', 'yes']) {
      const env = { ...good, TRUST_PROXY: value } as NodeJS.ProcessEnv
      expect(validateProductionEnv(env).problems.join(), String(value)).toMatch(/TRUST_PROXY must be "true"/)
    }
    expect(validateProductionEnv({ ...good, TRUST_PROXY: 'true' }).problems).toEqual([])
  })

  it('validates TRUST_PROXY_HOPS and CLIENT_IP_HEADER when set', () => {
    expect(validateProductionEnv({ ...good, TRUST_PROXY_HOPS: '2' }).problems).toEqual([])
    for (const bad of ['0', 'abc', '-1', '11', '1.5']) {
      expect(validateProductionEnv({ ...good, TRUST_PROXY_HOPS: bad }).problems.join(), bad).toMatch(/TRUST_PROXY_HOPS/)
    }
    expect(validateProductionEnv({ ...good, CLIENT_IP_HEADER: 'cf-connecting-ip' }).problems).toEqual([])
    expect(validateProductionEnv({ ...good, CLIENT_IP_HEADER: 'X-Real-IP' }).problems).toEqual([])
    for (const bad of ['bad header', 'x-real-ip,x-forwarded-for', 'host', 'cookie', 'authorization', 'x-forwarded-for']) {
      expect(validateProductionEnv({ ...good, CLIENT_IP_HEADER: bad }).problems.join(), bad).toMatch(/CLIENT_IP_HEADER/)
    }
  })

  it('requires a from address when SMTP is configured', () => {
    expect(validateProductionEnv({ ...good, SMTP_HOST: 'smtp.example.org' }).problems.join()).toMatch(
      /EMAIL_FROM_ADDRESS/,
    )
    expect(
      validateProductionEnv({ ...good, SMTP_HOST: 'smtp.example.org', EMAIL_FROM_ADDRESS: 'cms@example.org' }).problems,
    ).toEqual([])
  })
})
