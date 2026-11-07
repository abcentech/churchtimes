import { describe, expect, it } from 'vitest'

import {
  buildContactNotification,
  computeContactHash,
  CONTACT_REFERENCE_RE,
  generateContactReference,
  parseRecipientList,
  validateContactInput,
} from '../../src/lib/contactMessage'
import { isHoneypotHit, positiveInt, stripHeaderValue } from '../../src/lib/publicEndpoint'

const valid = {
  name: 'Ada Obi',
  email: 'Ada@Example.test',
  topic: 'general',
  message: 'Plain text, at least twenty characters long.',
}

describe('generateContactReference', () => {
  it('is MSG- plus exactly 8 characters of the fixed alphabet', () => {
    for (let i = 0; i < 200; i++) expect(generateContactReference()).toMatch(CONTACT_REFERENCE_RE)
    expect('MSG-ABCDEFG0').not.toMatch(CONTACT_REFERENCE_RE) // 0 is not in the alphabet
    expect('MSG-ABCDEFGHJ').not.toMatch(CONTACT_REFERENCE_RE) // 9 characters
    expect('SUB-ABCDEFGH').not.toMatch(CONTACT_REFERENCE_RE)
  })
})

describe('validateContactInput', () => {
  it('accepts a valid message, lower-cases the address and copies only whitelisted fields', () => {
    const r = validateContactInput({ ...valid, status: 'replied', reference: 'X', ipHash: 'y' })
    expect(r.ok && !r.honeypot).toBe(true)
    if (r.ok && !r.honeypot) {
      expect(Object.keys(r.data).sort()).toEqual(['email', 'message', 'name', 'topic'])
      expect(r.data.email).toBe('ada@example.test')
    }
  })

  it('reports each field and enforces the limits', () => {
    const r = validateContactInput({ name: 'A', email: 'nope', topic: 'x', message: 'short' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errors.map((e) => e.field).sort()).toEqual(['email', 'message', 'name', 'topic'])
    expect(validateContactInput({ ...valid, name: 'Al' }).ok).toBe(true)
    expect(validateContactInput({ ...valid, name: 'N'.repeat(121) }).ok).toBe(false)
    expect(validateContactInput({ ...valid, message: 'x'.repeat(19) }).ok).toBe(false)
    expect(validateContactInput({ ...valid, message: 'x'.repeat(20) }).ok).toBe(true)
    expect(validateContactInput({ ...valid, message: 'x'.repeat(5000) }).ok).toBe(true)
    expect(validateContactInput({ ...valid, message: 'x'.repeat(5001) }).ok).toBe(false)
  })

  it('accepts each topic and nothing else', () => {
    for (const topic of ['general', 'advertising', 'corrections', 'tips', 'other']) {
      expect(validateContactInput({ ...valid, topic }).ok).toBe(true)
    }
    for (const topic of ['', 'GENERAL', 'sales', 7, null, ['general']]) {
      expect(validateContactInput({ ...valid, topic }).ok).toBe(false)
    }
  })

  it('strips markup from the message (plain text only) and judges the length after stripping', () => {
    const r = validateContactInput({ ...valid, message: `<b>bold</b> <script>alert(1)</script>${'y'.repeat(25)}` })
    expect(r.ok && !r.honeypot && r.data.message).toBe(`bold ${'y'.repeat(25)}`)
    expect(validateContactInput({ ...valid, message: '<script>alert(1)</script>tiny' }).ok).toBe(false)
  })

  it('treats a non-empty website field as a honeypot hit', () => {
    expect(validateContactInput({ ...valid, website: 'http://x.example' })).toEqual({ ok: true, honeypot: true })
    expect(validateContactInput({ ...valid, website: '  ' }).ok).toBe(true)
    expect(isHoneypotHit({ website: '' })).toBe(false)
    expect(isHoneypotHit({})).toBe(false)
    expect(isHoneypotHit({ website: 'x' })).toBe(true)
    expect(isHoneypotHit({ website: 1 })).toBe(true)
  })

  it('rejects bodies that are not objects', () => {
    for (const raw of [null, 'x', 3, [valid]]) expect(validateContactInput(raw).ok).toBe(false)
  })
})

describe('computeContactHash', () => {
  it('ignores case and whitespace but not the address or the words', () => {
    const base = computeContactHash({ email: 'a@example.test', message: 'Hello   there friend' })
    expect(computeContactHash({ email: ' A@EXAMPLE.test ', message: 'hello there\nfriend ' })).toBe(base)
    expect(computeContactHash({ email: 'b@example.test', message: 'Hello there friend' })).not.toBe(base)
    expect(computeContactHash({ email: 'a@example.test', message: 'Hello there friends' })).not.toBe(base)
  })
})

describe('parseRecipientList', () => {
  it('splits a comma list and reports invalid entries without echoing long values', () => {
    expect(parseRecipientList('a@example.test, b@example.test ,,')).toEqual({
      valid: ['a@example.test', 'b@example.test'],
      invalid: [],
    })
    const r = parseRecipientList('a@example.test, nope, c@example.test\r\nBcc: x@example.test')
    expect(r.valid).toEqual(['a@example.test'])
    expect(r.invalid).toHaveLength(2)
    expect(parseRecipientList(undefined)).toEqual({ valid: [], invalid: [] })
    expect(parseRecipientList(Array.from({ length: 12 }, (_, i) => `u${i}@example.test`).join(',')).invalid).toHaveLength(2)
  })
})

describe('header safety', () => {
  it('stripHeaderValue removes CR, LF, other control characters and line separators', () => {
    expect(stripHeaderValue('Ada\r\nBcc: x@example.test')).toBe('Ada Bcc: x@example.test')
    expect(stripHeaderValue('a\u0000b\u0007c d e\tf')).toBe('a b c d e f')
    expect(stripHeaderValue('x'.repeat(500), 50)).toHaveLength(50)
    expect(stripHeaderValue(undefined)).toBe('')
    expect(stripHeaderValue('ok')).toBe('ok')
  })

  it('buildContactNotification has no line break in any header-bound value', () => {
    const n = buildContactNotification({
      name: 'Ada\r\nBcc: x@example.test',
      email: 'ada@example.test',
      topic: 'tips',
      message: 'Body\r\nwith lines',
      reference: 'MSG-ABCDEFGH',
    })
    expect(n.subject).not.toMatch(/[\r\n]/)
    expect(n.replyTo).toBe('ada@example.test')
    expect(n.subject).toContain('MSG-ABCDEFGH')
    expect(n.text).toContain('Body')
  })
})

describe('positiveInt', () => {
  it('falls back for anything that is not a positive integer', () => {
    expect(positiveInt('7', 5)).toBe(7)
    for (const v of ['0', '-3', 'x', '', undefined]) expect(positiveInt(v, 5)).toBe(5)
  })
})
