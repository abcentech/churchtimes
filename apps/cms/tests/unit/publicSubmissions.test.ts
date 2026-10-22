import { describe, expect, it } from 'vitest'

import { textToLexical } from '../../src/endpoints/convertSubmission'
import {
  generateReference,
  isConsentRequired,
  isOriginAllowed,
  validateSubmissionInput,
} from '../../src/endpoints/publicSubmissions'

const valid = {
  name: 'Ada Obi',
  email: 'ada@example.com',
  title: 'Church opens clinic',
  body: 'The church opened a free clinic in Ibadan this week for residents.',
}

describe('validateSubmissionInput', () => {
  it('accepts a valid submission and only copies whitelisted fields', () => {
    const r = validateSubmissionInput({ ...valid, status: 'converted', reference: 'X', ipHash: 'y', evil: 1 })
    expect(r.ok && !r.honeypot).toBe(true)
    if (r.ok && !r.honeypot) {
      expect(Object.keys(r.data).sort()).toEqual(['body', 'email', 'name', 'title'])
    }
  })

  it('aggregates errors per field', () => {
    const r = validateSubmissionInput({ name: 'A', email: 'nope', title: 'abc', body: 'short' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.map((e) => e.field).sort()).toEqual(['body', 'email', 'name', 'title'])
  })

  it('rejects non-objects', () => {
    for (const v of [null, 'x', 5, []]) expect(validateSubmissionInput(v).ok).toBe(false)
  })

  it('reports missing required fields', () => {
    const r = validateSubmissionInput({})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.length).toBe(4)
  })

  it('enforces max lengths', () => {
    const r = validateSubmissionInput({
      ...valid,
      name: 'x'.repeat(121),
      body: 'y'.repeat(20_001),
      phone: '1'.repeat(41),
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.map((e) => e.field).sort()).toEqual(['body', 'name', 'phone'])
  })

  it('treats a filled honeypot as honeypot, empty/absent as normal', () => {
    expect(validateSubmissionInput({ ...valid, website: 'http://spam' })).toEqual({ ok: true, honeypot: true })
    const empty = validateSubmissionInput({ ...valid, website: '' })
    expect(empty.ok && !empty.honeypot).toBe(true)
  })

  it('sanitises HTML from text fields', () => {
    const r = validateSubmissionInput({
      ...valid,
      name: 'Ada <script>alert(1)</script>Obi',
      title: '<img src=x onerror=alert(1)>Church opens clinic',
    })
    expect(r.ok && !r.honeypot).toBe(true)
    if (r.ok && !r.honeypot) {
      expect(r.data.name).toBe('Ada Obi')
      expect(r.data.title).toBe('Church opens clinic')
    }
  })

  it('rejects when sanitising leaves too little text', () => {
    expect(validateSubmissionInput({ ...valid, title: '<b></b><i>x</i>' }).ok).toBe(false)
  })
})

describe('generateReference', () => {
  it('uses SUB- plus 8 unambiguous chars', () => {
    for (let i = 0; i < 50; i++) expect(generateReference()).toMatch(/^SUB-[A-HJKMNP-Z2-9]{8}$/)
  })
})

describe('isOriginAllowed', () => {
  it('allows requests without Origin', () => {
    expect(isOriginAllowed(null, { NODE_ENV: 'production' })).toBe(true)
  })
  it('matches the configured list', () => {
    const env = { PUBLIC_SUBMISSION_ORIGINS: 'https://a.org, https://b.org/', NODE_ENV: 'production' } as never
    expect(isOriginAllowed('https://a.org', env)).toBe(true)
    expect(isOriginAllowed('https://b.org', env)).toBe(true)
    expect(isOriginAllowed('https://evil.org', env)).toBe(false)
  })
  it('unset: rejects browsers in production, allows in dev', () => {
    expect(isOriginAllowed('https://a.org', { NODE_ENV: 'production' } as never)).toBe(false)
    expect(isOriginAllowed('http://localhost:5173', { NODE_ENV: 'development' } as never)).toBe(true)
  })
})

describe('textToLexical', () => {
  it('builds one paragraph per blank-line block', () => {
    const s = textToLexical('One\n\nTwo line a\nTwo line b\n\n\n\nThree')
    expect(s.root.type).toBe('root')
    expect(s.root.children).toHaveLength(3)
    expect((s.root.children[1] as { children: unknown[] }).children).toHaveLength(3)
  })
})

describe('validateSubmissionInput consent', () => {
  it('ignores consent by default and keeps it out of data when absent', () => {
    const r = validateSubmissionInput(valid, { requireConsent: false })
    expect(r.ok && !r.honeypot && 'consent' in r.data).toBe(false)
  })
  it('keeps consent true and a cleaned text version', () => {
    const r = validateSubmissionInput({ ...valid, consent: true, consentTextVersion: ' 2026-10 ' }, { requireConsent: false })
    expect(r.ok && !r.honeypot && r.data.consent).toBe(true)
    expect(r.ok && !r.honeypot && r.data.consentTextVersion).toBe('2026-10')
  })
  it('does not keep a version without consent', () => {
    const r = validateSubmissionInput({ ...valid, consent: false, consentTextVersion: 'x' }, { requireConsent: false })
    expect(r.ok && !r.honeypot && r.data.consentTextVersion).toBeFalsy()
  })
  it('rejects a non-boolean consent', () => {
    const r = validateSubmissionInput({ ...valid, consent: 'yes' }, { requireConsent: false })
    expect(!r.ok && r.errors.map((e) => e.field)).toContain('consent')
  })
  it('requires consent true when required', () => {
    for (const body of [valid, { ...valid, consent: false }]) {
      const r = validateSubmissionInput(body, { requireConsent: true })
      expect(!r.ok && r.errors.map((e) => e.field)).toEqual(['consent'])
    }
    expect(validateSubmissionInput({ ...valid, consent: true }, { requireConsent: true }).ok).toBe(true)
  })
  it('reads SUBMISSIONS_REQUIRE_CONSENT from the environment', () => {
    expect(isConsentRequired({})).toBe(false)
    expect(isConsentRequired({ SUBMISSIONS_REQUIRE_CONSENT: 'true' })).toBe(true)
    expect(isConsentRequired({ SUBMISSIONS_REQUIRE_CONSENT: '1' })).toBe(true)
    expect(isConsentRequired({ SUBMISSIONS_REQUIRE_CONSENT: 'false' })).toBe(false)
  })
})
