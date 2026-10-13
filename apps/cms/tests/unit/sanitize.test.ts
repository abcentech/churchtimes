import { describe, expect, it } from 'vitest'

import { cleanText, isValidEmail, slugify } from '../../src/lib/sanitize'

describe('cleanText', () => {
  it('coerces non-strings to empty string', () => {
    expect(cleanText(undefined)).toBe('')
    expect(cleanText(null)).toBe('')
    expect(cleanText(42)).toBe('')
    expect(cleanText({ a: 1 })).toBe('')
  })

  it('strips tags and script/style contents', () => {
    expect(cleanText('Hello <b>world</b>')).toBe('Hello world')
    expect(cleanText('a<script>alert(1)</script>b')).toBe('ab')
    expect(cleanText('a<style>body{display:none}</style>b')).toBe('ab')
    expect(cleanText('<img src=x onerror=alert(1)>text')).toBe('text')
    expect(cleanText('<svg/onload=alert(1)>hi')).toBe('hi')
    expect(cleanText('x<!-- hidden -->y')).toBe('xy')
  })

  it('cannot be reassembled from nested payloads', () => {
    const out = cleanText('<scr<script></script>ipt>alert(1)</scr</script>ipt>')
    expect(out).not.toMatch(/<\s*\/?script/i)
    expect(out).not.toContain('<')
  })

  it('leaves javascript: text inert as plain text', () => {
    expect(cleanText('javascript:alert(1)')).toBe('javascript:alert(1)')
  })

  it('does not decode entities', () => {
    expect(cleanText('&lt;script&gt;')).toBe('&lt;script&gt;')
  })

  it('removes control characters', () => {
    expect(cleanText('a\u0000b\u0007c\u007fd')).toBe('a b c d')
    expect(cleanText('a\nb\tc')).toBe('a b c')
  })

  it('multiline keeps newlines/tabs, normalises CRLF and collapses blank lines', () => {
    expect(cleanText('a\r\nb\r\n\r\n\r\n\r\nc\u0000', { multiline: true })).toBe('a\nb\n\nc')
    expect(cleanText('a\tb', { multiline: true })).toBe('a\tb')
  })

  it('trims and truncates to max', () => {
    expect(cleanText('   hi   ')).toBe('hi')
    expect(cleanText('abcdefgh', { max: 3 })).toBe('abc')
  })
})

describe('isValidEmail', () => {
  it('accepts normal addresses', () => {
    expect(isValidEmail('ada@example.com')).toBe(true)
    expect(isValidEmail('a.b+tag@sub.example.org')).toBe(true)
  })
  it('rejects invalid ones', () => {
    const bad = ['', 'x', 'a@b', 'a@@b.com', 'a b@c.com', '.a@b.com', 'a..b@c.com', 'a@b..com', '<a@b.com>', 5, null]
    for (const v of bad) expect(isValidEmail(v)).toBe(false)
    expect(isValidEmail('a@' + 'b'.repeat(250) + '.com')).toBe(false)
  })
})

describe('slugify', () => {
  it('produces contract-compliant slugs', () => {
    expect(slugify('Synod 2026: Day #1!')).toBe('synod-2026-day-1')
    expect(slugify('Café Ñandú')).toBe('cafe-nandu')
    expect(slugify('!!!', 150, 'x')).toBe('x')
  })
})
