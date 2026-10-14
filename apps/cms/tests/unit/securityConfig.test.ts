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

describe('CMS_ALLOW_INSECURE_LOCAL_STAGING (disposable local staging only)', () => {
  const staging = {
    ...good,
    CMS_ALLOW_INSECURE_LOCAL_STAGING: 'true',
    TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
    CMS_PUBLIC_URL: 'http://cms.churchtimes.localhost:3100',
    CMS_CORS_ORIGINS: 'http://www.churchtimes.localhost:5173,http://localhost:5174,http://127.0.0.1:5174',
    CMS_CSRF_ORIGINS: 'http://newsroom.churchtimes.localhost:5174',
    PUBLIC_SUBMISSION_ORIGINS: 'http://www.churchtimes.localhost:5173',
  } as NodeJS.ProcessEnv

  it('is ignored unless explicitly "true": http origins and dummy secrets stay rejected', () => {
    for (const value of [undefined, '', 'false', 'TRUE', '1']) {
      const env = { ...staging, CMS_ALLOW_INSECURE_LOCAL_STAGING: value } as NodeJS.ProcessEnv
      const problems = validateProductionEnv(env).problems.join()
      expect(problems, String(value)).toMatch(/https/)
      expect(problems, String(value)).toMatch(/dummy/)
    }
  })

  it('accepts http .localhost / localhost / 127.0.0.1 origins and the Cloudflare test secret when every origin is loopback', () => {
    expect(validateProductionEnv(staging).problems).toEqual([])
  })

  it('still enforces every other production rule (secrets, TRUST_PROXY, wildcards, origin shape)', () => {
    expect(validateProductionEnv({ ...staging, TRUST_PROXY: 'false' }).problems.join()).toMatch(/TRUST_PROXY/)
    expect(validateProductionEnv({ ...staging, PAYLOAD_SECRET: 'short' }).problems.join()).toMatch(/PAYLOAD_SECRET/)
    expect(validateProductionEnv({ ...staging, CMS_CORS_ORIGINS: '*' }).problems.join()).toMatch(/wildcard/)
    expect(validateProductionEnv({ ...staging, CMS_CORS_ORIGINS: 'http://localhost:5174/' }).problems.join()).toMatch(
      /bare origin/,
    )
    expect(validateProductionEnv({ ...staging, TURNSTILE_SECRET_KEY: '' }).problems.join()).toMatch(/required/)
  })

  it('fails startup (is never silently honoured) when any configured origin is not loopback', () => {
    for (const key of ['CMS_PUBLIC_URL', 'CMS_CORS_ORIGINS', 'CMS_CSRF_ORIGINS', 'PUBLIC_SUBMISSION_ORIGINS']) {
      const env = { ...staging, [key]: 'https://www.example.org' } as NodeJS.ProcessEnv
      expect(validateProductionEnv(env).problems.join(), key).toMatch(/not a loopback origin/)
    }
    // Look-alikes of loopback hostnames do not count.
    // So do wildcard binds, other 127/8 addresses, IPv4-mapped IPv6, trailing dots, userinfo and non-canonical spellings
    // (fail closed: parseOrigin rejects anything that is not exactly a canonical origin).
    for (const host of [
      'http://evil-localhost:5173',
      'http://localhost.evil.org',
      'http://127.0.0.1.evil.org',
      'http://0.0.0.0:5173',
      'http://127.0.0.2:5173',
      'http://[::ffff:127.0.0.1]:5173',
      'http://[::]:5173',
      'http://localhost.:5173',
      'http://LOCALHOST:5173',
      'http://user@localhost:5173',
      'http://evil.org@localhost:5173',
    ]) {
      const env = { ...staging, CMS_CORS_ORIGINS: host } as NodeJS.ProcessEnv
      expect(validateProductionEnv(env).problems.join(), host).toMatch(/not a loopback origin/)
    }
  })

  it('requires CMS_PUBLIC_URL', () => {
    const env = { ...staging, CMS_PUBLIC_URL: '' } as NodeJS.ProcessEnv
    expect(validateProductionEnv(env).problems.join()).toMatch(/requires CMS_PUBLIC_URL/)
  })
})

describe('Turnstile pinning warnings (production: logged, never a startup failure)', () => {
  it('warns about unset TURNSTILE_ALLOWED_HOSTNAMES and TURNSTILE_EXPECTED_ACTION without failing startup', () => {
    const result = validateProductionEnv(good)
    expect(result.problems).toEqual([])
    expect(result.warnings).toHaveLength(2)
    expect(result.warnings.join()).toMatch(/TURNSTILE_ALLOWED_HOSTNAMES is not set/)
    expect(result.warnings.join()).toMatch(/TURNSTILE_EXPECTED_ACTION is not set/)
  })

  it('no warnings when both are set to real values', () => {
    const env = { ...good, TURNSTILE_ALLOWED_HOSTNAMES: 'www.example.org', TURNSTILE_EXPECTED_ACTION: 'submit-story' }
    expect(validateProductionEnv(env)).toEqual({ problems: [], warnings: [] })
  })

  it('treats blank values as unset', () => {
    const env = { ...good, TURNSTILE_ALLOWED_HOSTNAMES: '  ', TURNSTILE_EXPECTED_ACTION: '' }
    expect(validateProductionEnv(env).warnings).toHaveLength(2)
  })

  it('warns only for the setting that is missing', () => {
    const onlyAction = validateProductionEnv({ ...good, TURNSTILE_EXPECTED_ACTION: 'submit-story' }).warnings
    expect(onlyAction).toHaveLength(1)
    expect(onlyAction[0]).toMatch(/TURNSTILE_ALLOWED_HOSTNAMES/)
    const onlyHost = validateProductionEnv({ ...good, TURNSTILE_ALLOWED_HOSTNAMES: 'www.example.org' }).warnings
    expect(onlyHost).toHaveLength(1)
    expect(onlyHost[0]).toMatch(/TURNSTILE_EXPECTED_ACTION/)
  })

  it('keeps hard failures and warnings separate', () => {
    const result = validateProductionEnv({ ...good, TRUST_PROXY: 'false' })
    expect(result.problems.join()).toMatch(/TRUST_PROXY/)
    expect(result.warnings).toHaveLength(2)
  })

  it('does not warn for disposable local staging (Cloudflare dummy keys report fixed hostnames)', () => {
    const staging = {
      ...good,
      CMS_ALLOW_INSECURE_LOCAL_STAGING: 'true',
      TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
      CMS_PUBLIC_URL: 'http://cms.churchtimes.localhost:3100',
      CMS_CORS_ORIGINS: 'http://www.churchtimes.localhost:5173',
      CMS_CSRF_ORIGINS: 'http://newsroom.churchtimes.localhost:5174',
      PUBLIC_SUBMISSION_ORIGINS: 'http://www.churchtimes.localhost:5173',
    } as NodeJS.ProcessEnv
    expect(validateProductionEnv(staging)).toEqual({ problems: [], warnings: [] })
  })
})
