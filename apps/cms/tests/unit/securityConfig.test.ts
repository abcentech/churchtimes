import { describe, expect, it } from 'vitest'

import {
  checkOriginList,
  normaliseOrigin,
  parseOrigin,
  firstRegisterAllowed,
  validateProductionEnv,
} from '../../src/lib/securityConfig'

const good = {
  NODE_ENV: 'production',
  PAYLOAD_SECRET: 'a'.repeat(40),
  PREVIEW_SECRET: 'b'.repeat(40),
  IP_HASH_SALT: 'c'.repeat(20),
  NEWSLETTER_TOKEN_SECRET: 'd'.repeat(40),
  TURNSTILE_SECRET_KEY: '0x4AAAAAAAreal-looking-secret',
  CMS_PUBLIC_URL: 'https://cms.example.org',
  CMS_CORS_ORIGINS: 'https://www.example.org',
  CMS_CSRF_ORIGINS: 'https://cms.example.org',
  PUBLIC_SUBMISSION_ORIGINS: 'https://www.example.org',
  TRUST_PROXY: 'true',
  TURNSTILE_ALLOWED_HOSTNAMES: 'www.example.org',
  TURNSTILE_EXPECTED_ACTION: 'submit-story,contact-message,newsletter-subscribe',
  SMTP_HOST: 'smtp.example.org',
  EMAIL_FROM_ADDRESS: 'cms@example.org',
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
    expect(
      validateProductionEnv({ ...good, EMAIL_FROM_ADDRESS: undefined } as NodeJS.ProcessEnv).problems.join(),
    ).toMatch(/EMAIL_FROM_ADDRESS/)
    expect(validateProductionEnv(good).problems).toEqual([])
  })

  it('requires SMTP_HOST unless CMS_ALLOW_NO_SMTP=true (then it only warns)', () => {
    const noSmtp = { ...good, SMTP_HOST: undefined } as NodeJS.ProcessEnv
    expect(validateProductionEnv(noSmtp).problems.join()).toMatch(/SMTP_HOST is required/)
    for (const v of ['TRUE', '1', 'false', '']) {
      expect(validateProductionEnv({ ...noSmtp, CMS_ALLOW_NO_SMTP: v }).problems.join(), v).toMatch(/SMTP_HOST is required/)
    }
    const optOut = validateProductionEnv({ ...noSmtp, CMS_ALLOW_NO_SMTP: 'true' })
    expect(optOut.problems).toEqual([])
    expect(optOut.warnings.join()).toMatch(/SMTP_HOST is not set/)
  })

  it('requires non-empty CORS, CSRF and submission origin lists', () => {
    for (const key of ['CMS_CORS_ORIGINS', 'CMS_CSRF_ORIGINS', 'PUBLIC_SUBMISSION_ORIGINS']) {
      for (const v of [undefined, '', ' , ']) {
        expect(validateProductionEnv({ ...good, [key]: v }).problems.join(), `${key}=${v}`).toMatch(
          new RegExp(`${key} is required`),
        )
      }
    }
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

describe('Turnstile pinning (required in production, skipped for disposable local staging)', () => {
  it('fails startup when TURNSTILE_ALLOWED_HOSTNAMES or TURNSTILE_EXPECTED_ACTION is unset, blank or only commas', () => {
    for (const key of ['TURNSTILE_ALLOWED_HOSTNAMES', 'TURNSTILE_EXPECTED_ACTION']) {
      for (const v of [undefined, '', '  ', ' , ']) {
        expect(validateProductionEnv({ ...good, [key]: v }).problems.join(), `${key}=${v}`).toMatch(
          new RegExp(`${key} is required`),
        )
      }
    }
  })

  it('a complete configuration has no problems and no warnings', () => {
    expect(validateProductionEnv(good)).toEqual({ problems: [], warnings: [] })
  })

  it('does not require pinning or SMTP for disposable local staging (Cloudflare dummy keys report fixed hostnames)', () => {
    const staging = {
      ...good,
      TURNSTILE_ALLOWED_HOSTNAMES: undefined,
      TURNSTILE_EXPECTED_ACTION: undefined,
      SMTP_HOST: undefined,
      EMAIL_FROM_ADDRESS: undefined,
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

describe('NEWSLETTER_TOKEN_SECRET and PUBLIC_SITE_URL (C4)', () => {
  const without = (key: string): NodeJS.ProcessEnv => {
    const env = { ...good } as Record<string, string | undefined>
    delete env[key]
    return env as NodeJS.ProcessEnv
  }
  it('requires a strong NEWSLETTER_TOKEN_SECRET in production, distinct from the other secrets', () => {
    expect(validateProductionEnv(without('NEWSLETTER_TOKEN_SECRET')).problems.join()).toMatch(/NEWSLETTER_TOKEN_SECRET/)
    expect(validateProductionEnv({ ...good, NEWSLETTER_TOKEN_SECRET: 'short' }).problems.join()).toMatch(/NEWSLETTER_TOKEN_SECRET/)
    expect(validateProductionEnv({ ...good, NEWSLETTER_TOKEN_SECRET: good.PAYLOAD_SECRET }).problems.join()).toMatch(/differ/)
    expect(validateProductionEnv({ ...good, NEWSLETTER_TOKEN_SECRET: good.PREVIEW_SECRET }).problems.join()).toMatch(/differ/)
    expect(validateProductionEnv(good).problems).toEqual([])
  })
  it('accepts only a bare https PUBLIC_SITE_URL in production', () => {
    expect(validateProductionEnv({ ...good, PUBLIC_SITE_URL: 'https://www.example.org' }).problems).toEqual([])
    for (const bad of ['http://www.example.org', 'https://www.example.org/news', 'www.example.org', 'https://www.example.org/']) {
      expect(validateProductionEnv({ ...good, PUBLIC_SITE_URL: bad }).problems.join(), bad).toMatch(/PUBLIC_SITE_URL/)
    }
  })
})

describe('CONTACT_NOTIFY_TO (C5)', () => {
  it('is optional, accepts a comma list and fails startup on an invalid entry without echoing it', () => {
    expect(validateProductionEnv(good).problems).toEqual([])
    expect(validateProductionEnv({ ...good, CONTACT_NOTIFY_TO: 'a@example.test, b@example.test' }).problems).toEqual([])
    const bad = validateProductionEnv({ ...good, CONTACT_NOTIFY_TO: 'a@example.test, not-an-address' }).problems
    expect(bad.join()).toMatch(/CONTACT_NOTIFY_TO/)
    expect(bad.join()).not.toMatch(/not-an-address/)
  })
})

describe('firstRegisterAllowed (first-admin takeover guard)', () => {
  it('is allowed outside production (development bootstrap)', () => {
    expect(firstRegisterAllowed({ NODE_ENV: 'development' } as NodeJS.ProcessEnv)).toBe(true)
    expect(firstRegisterAllowed({ NODE_ENV: 'test' } as NodeJS.ProcessEnv)).toBe(true)
    expect(firstRegisterAllowed({} as NodeJS.ProcessEnv)).toBe(true)
  })

  it('is refused in production unless ALLOW_FIRST_REGISTER is exactly "true"', () => {
    expect(firstRegisterAllowed(good)).toBe(false)
    for (const v of ['', 'TRUE', '1', 'yes', 'false']) {
      expect(firstRegisterAllowed({ ...good, ALLOW_FIRST_REGISTER: v }), v).toBe(false)
    }
    expect(firstRegisterAllowed({ ...good, ALLOW_FIRST_REGISTER: 'true' })).toBe(true)
  })

  it('is allowed for disposable loopback staging (which the e2e stacks use)', () => {
    const staging = {
      ...good,
      CMS_ALLOW_INSECURE_LOCAL_STAGING: 'true',
      CMS_PUBLIC_URL: 'http://cms.churchtimes.localhost:3100',
      CMS_CORS_ORIGINS: 'http://www.churchtimes.localhost:5173',
      CMS_CSRF_ORIGINS: 'http://newsroom.churchtimes.localhost:5174',
      PUBLIC_SUBMISSION_ORIGINS: 'http://www.churchtimes.localhost:5173',
    } as NodeJS.ProcessEnv
    expect(firstRegisterAllowed(staging)).toBe(true)
    // the flag next to a public https origin is not staging: still refused (and startup fails separately)
    expect(firstRegisterAllowed({ ...good, CMS_ALLOW_INSECURE_LOCAL_STAGING: 'true' })).toBe(false)
  })
})
