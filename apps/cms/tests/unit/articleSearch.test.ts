import { describe, expect, it } from 'vitest'

import {
  cleanSnippet,
  lexicalToPlainText,
  parseSearchParams,
  sanitizeQuery,
  SEARCH_MAX_LIMIT,
  searchCountCap,
  searchMaxLimit,
  SEARCH_MAX_PAGE,
} from '../../src/lib/articleSearch'

const p = (qs: string) => parseSearchParams(new URLSearchParams(qs))

describe('lexicalToPlainText', () => {
  it('joins text nodes, separates blocks and strips markup characters', () => {
    const doc = {
      root: {
        type: 'root',
        children: [
          { type: 'paragraph', children: [{ type: 'text', text: 'Hello <b>world</b>' }] },
          { type: 'paragraph', children: [{ type: 'text', text: 'second' }, { type: 'linebreak' }, { type: 'text', text: 'line' }] },
        ],
      },
    }
    expect(lexicalToPlainText(doc)).toBe('Hello b world /b second line')
  })
  it('is bounded and tolerant of junk', () => {
    expect(lexicalToPlainText(null)).toBe('')
    expect(lexicalToPlainText('x')).toBe('')
    const big = { root: { children: Array.from({ length: 100 }, () => ({ type: 'paragraph', children: [{ text: 'x'.repeat(5000) }] })) } }
    expect(lexicalToPlainText(big, 1000).length).toBeLessThanOrEqual(1000)
  })
})

describe('parseSearchParams', () => {
  it('requires q, trims it and caps its length at 200', () => {
    expect(p('').ok).toBe(false)
    expect(p('q=%20%20').ok).toBe(false)
    const ok = p('q=%20%20hello%20%20world%20')
    expect(ok.ok && ok.params.q).toBe('hello world')
    expect(p(`q=${'a'.repeat(200)}`).ok).toBe(true)
    expect(p(`q=${'a'.repeat(201)}`).ok).toBe(false)
  })
  it('the page-size ceiling defaults to 20 and follows SEARCH_MAX_LIMIT (1 to 100); the count cap defaults to 1000', () => {
    expect(SEARCH_MAX_LIMIT).toBe(20)
    expect(searchMaxLimit({})).toBe(20)
    expect(searchMaxLimit({ SEARCH_MAX_LIMIT: '35' })).toBe(35)
    expect(searchMaxLimit({ SEARCH_MAX_LIMIT: '5000' })).toBe(100)
    for (const bad of ['', 'abc', '0', '-3', '2.5']) expect(searchMaxLimit({ SEARCH_MAX_LIMIT: bad })).toBe(20)
    expect(searchCountCap({})).toBe(1000)
    expect(searchCountCap({ SEARCH_COUNT_CAP: '50' })).toBe(50)
    expect(searchCountCap({ SEARCH_COUNT_CAP: '99999' })).toBe(10000)
    expect(searchCountCap({ SEARCH_COUNT_CAP: '0' })).toBe(1000)
  })
  it('clamps limit and page and validates year', () => {
    const r = p('q=x&limit=9999&page=9999999')
    expect(r.ok && r.params.limit).toBe(SEARCH_MAX_LIMIT)
    expect(r.ok && r.params.page).toBe(SEARCH_MAX_PAGE)
    const d = p('q=x&limit=-1&page=abc')
    expect(d.ok && [d.params.limit, d.params.page]).toEqual([10, 1])
    expect(p('q=x&year=2024').ok).toBe(true)
    expect(p('q=x&year=24').ok).toBe(false)
    expect(p('q=x&year=2024abc').ok).toBe(false)
  })
})

describe('sanitizeQuery and cleanSnippet', () => {
  it('removes control characters and keeps operators as plain text for the database', () => {
    expect(sanitizeQuery('a\u0000b\r\nc')).toBe('a b c')
    expect(sanitizeQuery("o'brien & co")).toBe("o'brien & co")
  })
  it('returns plain, capped snippets and falls back to the excerpt', () => {
    expect(cleanSnippet('<script>alert(1)</script> text', '')).toBe('script alert(1) /script text')
    expect(cleanSnippet('', 'fallback excerpt')).toBe('fallback excerpt')
    const long = cleanSnippet('word '.repeat(200), '')
    expect(long.length).toBeLessThanOrEqual(240)
    expect(long.endsWith('…')).toBe(true)
  })
})
