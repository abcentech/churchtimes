import { describe, expect, it } from 'vitest'

import {
  buildConfirmUrl,
  csvCell,
  generateConfirmToken,
  hashSubscriberEmail,
  hashToken,
  isPlausibleToken,
  resolveNewsletterTokenSecret,
  resolvePublicSiteUrl,
  signUnsubscribeToken,
  toCsv,
  validateSubscribeInput,
  verifyUnsubscribeToken,
} from '../../src/lib/newsletter'
import { parseCsv, parseMailchimpTime, planMailchimpImport } from '../../src/lib/subscriberImport'

const valid = { email: 'Reader@Example.test', consent: true, source: 'footer' }
const SECRET = 's'.repeat(40)

describe('validateSubscribeInput', () => {
  it('lower-cases the address and keeps only whitelisted fields', () => {
    const r = validateSubscribeInput({ ...valid, status: 'confirmed', ipHash: 'x', confirmTokenHash: 'y' })
    expect(r.ok && !r.honeypot && r.data).toEqual({ email: 'reader@example.test', source: 'footer' })
  })

  it('treats a missing, null, empty or whitespace name as no name', () => {
    for (const name of [undefined, null, '', '   ', '<b></b>']) {
      const r = validateSubscribeInput({ ...valid, name })
      expect(r.ok, String(name)).toBe(true)
      if (r.ok && !r.honeypot) expect('name' in r.data).toBe(false)
    }
    const named = validateSubscribeInput({ ...valid, name: 'Ada Obi' })
    expect(named.ok && !named.honeypot && named.data.name).toBe('Ada Obi')
  })

  it('rejects a one-character, over-long or non-text name', () => {
    for (const name of ['A', 'N'.repeat(121), 7, ['Ada']]) expect(validateSubscribeInput({ ...valid, name }).ok).toBe(false)
  })

  it('requires consent to be literally true', () => {
    for (const consent of [undefined, false, 'true', 1, 'yes', null]) {
      const r = validateSubscribeInput({ ...valid, consent })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.errors.map((e) => e.field)).toContain('consent')
    }
  })

  it('requires a valid email and a source from the list', () => {
    expect(validateSubscribeInput({ ...valid, email: 'nope' }).ok).toBe(false)
    expect(validateSubscribeInput({ ...valid, email: undefined }).ok).toBe(false)
    for (const source of ['footer', 'article', 'home', 'other']) expect(validateSubscribeInput({ ...valid, source }).ok).toBe(true)
    for (const source of [undefined, 'sidebar', 'FOOTER', 3]) expect(validateSubscribeInput({ ...valid, source }).ok).toBe(false)
  })

  it('honeypot wins over everything else', () => {
    expect(validateSubscribeInput({ ...valid, consent: false, website: 'http://x.example' })).toEqual({ ok: true, honeypot: true })
    expect(validateSubscribeInput([]).ok).toBe(false)
  })
})

describe('confirmation tokens', () => {
  it('are random, plausible and stored only as a SHA-256 hash', () => {
    const a = generateConfirmToken()
    const b = generateConfirmToken()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(isPlausibleToken(a)).toBe(true)
    expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/)
    expect(hashToken(a)).not.toContain(a)
    for (const bad of ['', 'short', 'x'.repeat(201), 'has space in it......', 5, null, undefined, { a: 1 }]) {
      expect(isPlausibleToken(bad)).toBe(false)
    }
  })
})

describe('signed unsubscribe tokens', () => {
  it('round-trips the subscriber id', () => {
    const t = signUnsubscribeToken(42, SECRET)
    expect(t).toMatch(/^u1\.42\.[A-Za-z0-9_-]{43}$/)
    expect(verifyUnsubscribeToken(t, SECRET)).toBe('42')
  })

  it('rejects tampering, other keys, other ids and malformed input', () => {
    const t = signUnsubscribeToken(42, SECRET)
    expect(verifyUnsubscribeToken(t, 'o'.repeat(40))).toBeNull()
    expect(verifyUnsubscribeToken(t.replace('.42.', '.43.'), SECRET)).toBeNull()
    expect(verifyUnsubscribeToken(`${t.slice(0, -1)}${t.endsWith('A') ? 'B' : 'A'}`, SECRET)).toBeNull()
    expect(verifyUnsubscribeToken(t, undefined)).toBeNull()
    for (const bad of ['', 'u1.42', 'u2.42.x', 'u1.4x.AAAA', 'u1.42.' + 'A'.repeat(42), 12, null, `${t}.extra`, 'x'.repeat(300)]) {
      expect(verifyUnsubscribeToken(bad, SECRET)).toBeNull()
    }
  })
})

describe('resolveNewsletterTokenSecret', () => {
  it('uses the configured secret, derives a key outside production and refuses in production without one', () => {
    expect(resolveNewsletterTokenSecret({ NODE_ENV: 'production', NEWSLETTER_TOKEN_SECRET: SECRET } as NodeJS.ProcessEnv)).toBe(SECRET)
    expect(resolveNewsletterTokenSecret({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toBeUndefined()
    expect(resolveNewsletterTokenSecret({ NODE_ENV: 'production', NEWSLETTER_TOKEN_SECRET: 'short' } as NodeJS.ProcessEnv)).toBeUndefined()
    const dev = resolveNewsletterTokenSecret({ NODE_ENV: 'development', PAYLOAD_SECRET: 'p'.repeat(40) } as NodeJS.ProcessEnv)
    expect(dev).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('resolvePublicSiteUrl', () => {
  const prod = (url?: string) => ({ NODE_ENV: 'production', PUBLIC_SITE_URL: url }) as NodeJS.ProcessEnv
  it('is https only in production and a bare origin', () => {
    expect(resolvePublicSiteUrl(prod('https://www.example.test'))).toBe('https://www.example.test')
    expect(resolvePublicSiteUrl(prod('https://www.example.test/'))).toBe('https://www.example.test')
    for (const bad of ['http://www.example.test', 'http://localhost:5173', 'https://www.example.test/x', 'javascript:alert(1)', '']) {
      expect(resolvePublicSiteUrl(prod(bad)), bad).toBeNull()
    }
    expect(resolvePublicSiteUrl(prod(undefined))).toBeNull()
  })
  it('allows http://localhost only outside production', () => {
    expect(resolvePublicSiteUrl({ NODE_ENV: 'development', PUBLIC_SITE_URL: 'http://localhost:5173' } as NodeJS.ProcessEnv)).toBe('http://localhost:5173')
    expect(resolvePublicSiteUrl({ NODE_ENV: 'development', PUBLIC_SITE_URL: 'http://example.test' } as NodeJS.ProcessEnv)).toBeNull()
  })
  it('builds a public-site link, never an API path', () => {
    const url = buildConfirmUrl('https://www.example.test', 'abc_DEF-123')
    expect(url).toBe('https://www.example.test/newsletter/confirm?token=abc_DEF-123')
    expect(url).not.toContain('/api/')
  })
})

describe('hashSubscriberEmail', () => {
  it('is stable, case-insensitive, salted and never contains the address', () => {
    const env = { NODE_ENV: 'test', IP_HASH_SALT: 'salt-one' } as NodeJS.ProcessEnv
    const h = hashSubscriberEmail('Reader@Example.test', env)
    expect(h).toMatch(/^erased:[0-9a-f]{64}$/)
    expect(hashSubscriberEmail(' reader@example.test ', env)).toBe(h)
    expect(hashSubscriberEmail('reader@example.test', { ...env, IP_HASH_SALT: 'salt-two' } as NodeJS.ProcessEnv)).not.toBe(h)
    expect(h).not.toContain('reader')
    expect(() => hashSubscriberEmail('a@example.test', { NODE_ENV: 'production', IP_HASH_SALT: 'short' } as NodeJS.ProcessEnv)).toThrow()
  })
})

describe('CSV export guard', () => {
  it('prefixes formula starters with an apostrophe', () => {
    for (const s of ['=1+1', '+1', '-1', '@SUM(A1)', '\tcmd', '\rcmd']) expect(csvCell(s).replace(/^"/, '')).toMatch(/^'/)
    expect(csvCell('=HYPERLINK("http://x.example")')).toBe('"\'=HYPERLINK(""http://x.example"")"')
  })
  it('leaves normal cells alone and quotes commas, quotes and newlines', () => {
    expect(csvCell('ada@example.test')).toBe('ada@example.test')
    expect(csvCell('Obi, Ada')).toBe('"Obi, Ada"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('two\nlines')).toBe('"two\nlines"')
    expect(csvCell(null)).toBe('')
    expect(csvCell(undefined)).toBe('')
  })
  it('toCsv writes the header and only the listed columns (never ipHash or tokens)', () => {
    const csv = toCsv([{ email: '+tag@example.test', name: '=cmd', status: 'confirmed', ipHash: 'secret', confirmTokenHash: 'secret2' }])
    const [header, row] = csv.split('\r\n')
    expect(header).toBe('email,name,status,source,consentAt,confirmedAt,unsubscribedAt,importedFrom')
    expect(row).toBe("'+tag@example.test,'=cmd,confirmed,,,,,")
    expect(csv).not.toContain('secret')
  })
})

describe('parseCsv', () => {
  it('handles quotes, embedded commas and newlines, CRLF, a BOM and blank lines', () => {
    const rows = parseCsv('﻿a,b\r\n"x, y","line1\nline2"\r\n\r\n"q""q",\r\n')
    expect(rows).toEqual([['a', 'b'], ['x, y', 'line1\nline2'], ['q"q', '']])
  })
})

describe('planMailchimpImport (synthetic data)', () => {
  const NOW = new Date('2026-10-16T12:00:00Z')
  const header = 'Email Address,First Name,Last Name,OPTIN_TIME,CONFIRM_TIME,Status'
  const file = [
    header,
    'ada@example.test,Ada,Obi,2024-03-01 09:30:00,2024-03-01 09:31:00,subscribed',
    'ADA@example.test,Ada,Obi,,,subscribed',
    'bola@example.test,Bola,,,2024-04-02 10:00:00,Subscribed',
    'cleaned@example.test,C,D,,,cleaned',
    'gone@example.test,E,F,,,unsubscribed',
    'wait@example.test,G,H,,,pending',
    'not-an-email,I,J,,,subscribed',
    'chi@example.test,,,,,subscribed',
    'future@example.test,Fu,Ture,2999-01-01 00:00:00,,subscribed',
  ].join('\n')

  it('imports only subscribed rows and counts everything else', () => {
    const { counts, candidates } = planMailchimpImport(file, { now: NOW })
    expect(counts).toMatchObject({
      rowsRead: 9,
      candidates: 6,
      blockingCandidates: 2,
      skippedNotSubscribed: 1,
      skippedInvalidEmail: 1,
      skippedDuplicateInFile: 1,
    })
    expect(candidates.map((c) => c.email)).toEqual([
      'ada@example.test',
      'bola@example.test',
      'cleaned@example.test',
      'gone@example.test',
      'chi@example.test',
      'future@example.test',
    ])
    expect(candidates.find((c) => c.email === 'cleaned@example.test')!.kind).toBe('bounced')
    expect(candidates.find((c) => c.email === 'gone@example.test')!.kind).toBe('unsubscribed')
  })

  it('uses the Mailchimp OPTIN_TIME as consentAt and stores nothing when it is missing (never the import time)', () => {
    const { candidates } = planMailchimpImport(file, { now: NOW })
    const by = Object.fromEntries(candidates.map((c) => [c.email, c]))
    expect(by['ada@example.test']).toMatchObject({
      name: 'Ada Obi',
      consentAt: '2024-03-01T09:30:00.000Z',
      confirmedAt: '2024-03-01T09:31:00.000Z',
    })
    // confirm time only: carried as confirmedAt, but with no opt-in time the importer stores the row pending (see integration tests)
    expect(by['bola@example.test']).toMatchObject({ name: 'Bola', confirmedAt: '2024-04-02T10:00:00.000Z' })
    expect('consentAt' in by['bola@example.test']!).toBe(false)
    // neither time: nothing is invented
    expect('consentAt' in by['chi@example.test']!).toBe(false)
    expect('confirmedAt' in by['chi@example.test']!).toBe(false)
    expect('name' in by['chi@example.test']!).toBe(false)
    expect('consentAt' in by['future@example.test']!).toBe(false) // a future opt-in time is ignored, not replaced by now
    expect(planMailchimpImport(file, { now: NOW }).counts.importedWithoutOptinTime).toBe(3)
  })

  it('tolerates other Mailchimp header spellings', () => {
    const alt = 'email,fname,lname,optin_time,member_status\nx@example.test,X,Y,2024-01-02 03:04:05,subscribed'
    const { candidates, counts } = planMailchimpImport(alt.replace('member_status', 'Member Status'), { now: NOW })
    expect(counts.candidates).toBe(1)
    expect(candidates[0]).toMatchObject({ email: 'x@example.test', name: 'X Y', consentAt: '2024-01-02T03:04:05.000Z' })
  })

  it('refuses a file with no email column, and a file with no status column unless told it is the Subscribed export', () => {
    expect(planMailchimpImport('foo,bar\n1,2', { now: NOW }).counts.refused).toBe('no-email-column')
    const noStatus = 'Email Address,First Name\na@example.test,A'
    const refused = planMailchimpImport(noStatus, { now: NOW })
    expect(refused.counts.refused).toBe('no-status-column')
    expect(refused.candidates).toEqual([])
    const ok = planMailchimpImport(noStatus, { now: NOW, assumeSubscribed: true })
    expect(ok.counts.candidates).toBe(1)
  })

  it('never carries an address in the counts', () => {
    expect(JSON.stringify(planMailchimpImport(file, { now: NOW }).counts)).not.toContain('@')
  })

  it('parseMailchimpTime reads UTC "YYYY-MM-DD HH:MM:SS" and nothing else', () => {
    expect(parseMailchimpTime('2024-03-01 09:30:00', NOW)).toBe('2024-03-01T09:30:00.000Z')
    expect(parseMailchimpTime('2024-03-01T09:30:00Z', NOW)).toBeUndefined() // only the exact Mailchimp format is a time
    expect(parseMailchimpTime('garbage', NOW)).toBeUndefined()
    expect(parseMailchimpTime('', NOW)).toBeUndefined()
  })
})
