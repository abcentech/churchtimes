import { describe, expect, it } from 'vitest'

import { donationsCsv, majorAmount } from '../../src/endpoints/donationsExport'
import { topicFeedXml } from '../../src/endpoints/publicNewsroom'
import { causesProblem, currenciesProblem } from '../../src/globals/GivingSettings'
import { collectGalleryMedia, findEmbedProblem } from '../../src/lib/lexicalEmbeds'
import {
  contentTypeOf,
  isSafeProfileUrl,
  isValidLqip,
  keyPointsProblem,
  plainTextProblem,
  readingMinutes,
  slugValidator,
  updateStampProblem,
} from '../../src/lib/newsroomFields'

const body = (...nodes: unknown[]) => ({ root: { type: 'root', children: nodes } })
const block = (fields: Record<string, unknown>) => ({ type: 'block', version: 2, format: '', fields: { id: 'x', blockName: '', ...fields } })

describe('newsroom field rules', () => {
  it('plain text: limits, markup and control characters', () => {
    expect(plainTextProblem('', 'K', 5)).toBeNull()
    expect(plainTextProblem('', 'K', 5, { required: true })).toMatch(/required/)
    expect(plainTextProblem('   ', 'K', 5, { required: true })).toMatch(/required/)
    expect(plainTextProblem('abcdef', 'K', 5)).toMatch(/at most 5/)
    expect(plainTextProblem('<b>', 'K', 5)).toMatch(/plain text/)
    expect(plainTextProblem('a\nb', 'K', 5)).toMatch(/plain text/)
    expect(plainTextProblem('a\nb', 'K', 5, { multiline: true })).toBeNull()
    expect(plainTextProblem(5, 'K', 5)).toMatch(/plain text/)
    expect(plainTextProblem('Ọ̀ṣọ́ ẹ ɓ', 'K', 20)).toBeNull()
  })
  it('key points, update stamp, content type, slugs, urls, lqip, reading time', () => {
    expect(keyPointsProblem([{ text: 'a' }])).toBeNull()
    expect(keyPointsProblem(Array.from({ length: 6 }, () => ({ text: 'a' })))).toMatch(/At most 5/)
    expect(keyPointsProblem([{ text: 'x'.repeat(201) }])).toMatch(/200/)
    expect(keyPointsProblem('nope')).toMatch(/list/)
    const now = Date.parse('2026-10-30T08:00:00Z')
    expect(updateStampProblem('2026-10-30T08:09:00Z', now)).toBeNull()
    expect(updateStampProblem('2026-10-30T08:11:00Z', now)).toMatch(/future/)
    expect(updateStampProblem('soon', now)).toMatch(/valid/)
    expect(contentTypeOf(null)).toBe('news')
    expect(contentTypeOf('opinion')).toBe('opinion')
    expect(slugValidator('ok-slug-1')).toBe(true)
    expect(slugValidator('Bad Slug')).not.toBe(true)
    expect(slugValidator('a'.repeat(81))).not.toBe(true)
    expect(isSafeProfileUrl('https://x.com/ada')).toBe(true)
    for (const bad of ['javascript:alert(1)', 'https://user:pw@x.com', 'https://x.com/a b', 'ftp://x.com', 'https://localhost', `https://x.com/${'a'.repeat(300)}`]) {
      expect(isSafeProfileUrl(bad)).toBe(false)
    }
    expect(isValidLqip('data:image/webp;base64,AAAA')).toBe(true)
    expect(isValidLqip('data:image/svg+xml;base64,AAAA')).toBe(false)
    expect(isValidLqip(`data:image/webp;base64,${'A'.repeat(1500)}`)).toBe(false)
    expect(readingMinutes(0)).toBe(1)
    expect(readingMinutes(1100)).toBe(5)
  })
})

describe('pull quote and gallery blocks in article bodies', () => {
  it('accepts well-formed blocks and collects gallery media', () => {
    const doc = body(
      block({ blockType: 'pullQuote', quote: 'We rebuild.', attribution: 'A' }),
      block({ blockType: 'gallery', images: [{ id: 'r1', image: 4, caption: 'c' }, { id: 'r2', image: { id: 5 } }, { image: 4 }] }),
    )
    expect(findEmbedProblem(doc)).toBeNull()
    expect(collectGalleryMedia(doc)).toEqual([4, 5])
  })
  it('refuses malformed ones', () => {
    const cases: Array<[unknown, RegExp]> = [
      [block({ blockType: 'pullQuote', quote: '' }), /required/],
      [block({ blockType: 'pullQuote', quote: 'q', extra: 1 }), /unexpected/],
      [{ ...block({ blockType: 'pullQuote', quote: 'q' }), url: 'https://evil.test' }, /children or URL/],
      [block({ blockType: 'gallery', images: Array.from({ length: 13 }, () => ({ image: 1 })) }), /at most 12/],
      [block({ blockType: 'gallery', images: [{ image: 0 }] }), /invalid media id/],
      [block({ blockType: 'gallery', images: [{ image: 1, caption: '<script>' }] }), /plain text/],
      [block({ blockType: 'gallery', images: [null] }), /malformed/],
      [block({ blockType: 'somethingElse' }), /Embeds other than YouTube/],
    ]
    for (const [node, re] of cases) expect(findEmbedProblem(body(node))).toMatch(re)
  })
})

describe('giving settings validation', () => {
  it('currencies: once each, min <= max, presets in range, whole minor units', () => {
    expect(currenciesProblem([{ currency: 'NGN', minimum: 100, maximum: 500, presets: [100, 500] }])).toBeNull()
    expect(currenciesProblem([{ currency: 'NGN', minimum: 100, maximum: 500 }, { currency: 'NGN', minimum: 100, maximum: 500 }])).toMatch(/twice/)
    expect(currenciesProblem([{ currency: 'NGN', minimum: 600, maximum: 500 }])).toMatch(/above/)
    expect(currenciesProblem([{ currency: 'NGN', minimum: 100, maximum: 500, presets: [50] }])).toMatch(/between/)
    expect(currenciesProblem([{ currency: 'NGN', minimum: 1.5, maximum: 500 }])).toMatch(/whole/)
    expect(causesProblem([{ key: 'general' }, { key: 'general' }])).toMatch(/once/)
  })
})

describe('donations CSV and topic feed', () => {
  it('CSV: personal columns only on request, formula cells neutralised, major amounts', () => {
    const rows = [{ reference: 'r1', amountMinor: 123456, status: 'succeeded', name: '=cmd()', email: 'a@b.c', currency: 'NGN' }]
    const plain = donationsCsv(rows, false)
    expect(plain.split('\r\n')[0]).not.toContain('email')
    expect(plain).not.toContain('a@b.c')
    expect(plain).toContain('1234.56')
    const full = donationsCsv(rows, true)
    expect(full).toContain("'=cmd()")
    expect(full).toContain('a@b.c')
    expect(majorAmount('x')).toBe('')
  })
  it('feed: escaped, absolute public links', () => {
    const xml = topicFeedXml('https://site.example', '/{slug}/', { slug: 't', name: 'A & B', description: '<desc>' }, [
      { slug: 's1', title: 'T <1>', excerpt: 'E & "x"', publishedAt: '2026-10-30T08:00:00Z', category: { title: 'News' }, bylineName: 'Ada' },
    ])
    expect(xml).toContain('<title>A &amp; B - Church Times Nigeria</title>')
    expect(xml).toContain('<description>&lt;desc&gt;</description>')
    expect(xml).toContain('<link>https://site.example/s1/</link>')
    expect(xml).toContain('<title>T &lt;1&gt;</title>')
    expect(xml).toContain('E &amp; &quot;x&quot;')
    expect(xml).toContain('<pubDate>Fri, 30 Oct 2026 08:00:00 GMT</pubDate>')
  })
})
