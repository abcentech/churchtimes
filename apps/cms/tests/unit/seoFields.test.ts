import { describe, expect, it } from 'vitest'

import {
  SEO_DESCRIPTION_MAX,
  SEO_TITLE_MAX,
  cleanSeoValue,
  hasTemplateVariable,
  seoFieldValidator,
} from '../../src/lib/seoFields'

describe('cleanSeoValue', () => {
  it('treats unset, empty and markup-only values as null', () => {
    expect(cleanSeoValue(undefined)).toBeNull()
    expect(cleanSeoValue(null)).toBeNull()
    expect(cleanSeoValue('')).toBeNull()
    expect(cleanSeoValue('   \n\t ')).toBeNull()
    expect(cleanSeoValue('<b></b>')).toBeNull()
    expect(cleanSeoValue('<script>alert(1)</script>')).toBeNull()
  })

  it('returns single-line plain text with markup and control characters stripped', () => {
    expect(cleanSeoValue('  Church <b>opens</b> clinic  ')).toBe('Church opens clinic')
    expect(cleanSeoValue('Line one\nLine two')).toBe('Line one Line two')
    expect(cleanSeoValue('a\u0000b')).toBe('a b')
    expect(cleanSeoValue('<img src=x onerror=alert(1)>Hello')).toBe('Hello')
  })

  it('does not decode entities or invent text', () => {
    expect(cleanSeoValue('Faith &amp; hope')).toBe('Faith &amp; hope')
  })

  it('flags non-strings as invalid', () => {
    expect(cleanSeoValue(42)).toBe('invalid')
    expect(cleanSeoValue({ a: 1 })).toBe('invalid')
    expect(cleanSeoValue(['x'])).toBe('invalid')
    expect(cleanSeoValue(true)).toBe('invalid')
  })
})

describe('hasTemplateVariable', () => {
  it('detects Rank Math style placeholders', () => {
    expect(hasTemplateVariable('%title% %sep% %sitename%')).toBe(true)
    expect(hasTemplateVariable('Latest news %currentyear%')).toBe(true)
    expect(hasTemplateVariable('%customfield(author_note)%')).toBe(true)
  })

  it('leaves ordinary percent signs alone', () => {
    expect(hasTemplateVariable('Giving up 10% of income')).toBe(false)
    expect(hasTemplateVariable('50% off and 20% more')).toBe(false)
    expect(hasTemplateVariable('100%')).toBe(false)
    expect(hasTemplateVariable('')).toBe(false)
  })
})

describe('seoFieldValidator', () => {
  const title = seoFieldValidator('seoTitle')
  const description = seoFieldValidator('seoDescription')

  it('accepts unset values and ordinary text up to the limit', () => {
    expect(title(undefined)).toBe(true)
    expect(title(null)).toBe(true)
    expect(title('')).toBe(true)
    expect(title('a'.repeat(SEO_TITLE_MAX))).toBe(true)
    expect(description('a'.repeat(SEO_DESCRIPTION_MAX))).toBe(true)
  })

  it('rejects over-length text with a per-field message', () => {
    expect(title('a'.repeat(SEO_TITLE_MAX + 1))).toBe(`SEO title must be at most ${SEO_TITLE_MAX} characters.`)
    expect(description('a'.repeat(SEO_DESCRIPTION_MAX + 1))).toBe(
      `SEO description must be at most ${SEO_DESCRIPTION_MAX} characters.`,
    )
  })

  it('rejects template variables and non-strings', () => {
    expect(title('%title% | Church Times')).toMatch(/template variables/)
    expect(description('Read %excerpt%')).toMatch(/template variables/)
    expect(title(7)).toMatch(/plain text/)
  })
})
