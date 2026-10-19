import { describe, expect, it } from 'vitest'

import {
  ANONYMOUS_NAME,
  COMMENT_CONTENT_MAX,
  COMMENT_NAME_MAX,
  EMAIL_REDACTED,
  cleanCommentAuthorName,
  cleanCommentContent,
  toLegacyCommentData,
  toPublicComment,
  type WxrComment,
} from '../../src/lib/legacyComments'
import { parseCommentPaging } from '../../src/endpoints/publicLegacyComments'

const base: WxrComment = {
  id: '101',
  author: 'Ada Obi',
  authorEmail: 'ada@private.example',
  authorUrl: 'https://ada.example',
  authorIp: '203.0.113.9',
  date: '2019-03-04 11:11:12',
  dateGmt: '2019-03-04 10:11:12',
  content: 'Thank you for this.',
  approved: '1',
  type: '',
  parent: '0',
}

describe('toLegacyCommentData', () => {
  it('keeps an approved comment and only the allowlisted fields', () => {
    const r = toLegacyCommentData(base, 7)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data).toEqual({
      article: 7,
      authorName: 'Ada Obi',
      content: 'Thank you for this.',
      commentedAt: '2019-03-04T10:11:12.000Z',
      legacyId: 101,
      parentLegacyId: null,
      status: 'approved',
    })
    const json = JSON.stringify(r)
    expect(json).not.toContain('private.example')
    expect(json).not.toContain('203.0.113.9')
    expect(json).not.toContain('ada.example')
    expect(Object.keys(r.data).sort()).toEqual(
      ['article', 'authorName', 'commentedAt', 'content', 'legacyId', 'parentLegacyId', 'status'].sort(),
    )
  })

  it.each([
    ['0', '', 'unapproved'],
    ['', '', 'unapproved'],
    [undefined, '', 'unapproved'],
    ['spam', '', 'spam'],
    ['trash', '', 'trash'],
    ['1', 'pingback', 'pingback'],
    ['1', 'trackback', 'trackback'],
    ['1', 'review', 'other-type'],
  ])('skips approved=%s type=%s as %s', (approved, type, reason) => {
    expect(toLegacyCommentData({ ...base, approved, type }, 1)).toEqual({ ok: false, reason })
  })

  it('accepts type "comment" and numeric approved flags', () => {
    expect(toLegacyCommentData({ ...base, approved: 1, type: 'comment', id: 5 }, 1).ok).toBe(true)
  })

  it('skips a bad id, a bad date and empty text', () => {
    expect(toLegacyCommentData({ ...base, id: 'abc' }, 1)).toEqual({ ok: false, reason: 'bad-id' })
    expect(toLegacyCommentData({ ...base, id: '0' }, 1)).toEqual({ ok: false, reason: 'bad-id' })
    expect(toLegacyCommentData({ ...base, dateGmt: '0000-00-00 00:00:00', date: 'nope' }, 1)).toEqual({
      ok: false,
      reason: 'bad-date',
    })
    expect(toLegacyCommentData({ ...base, content: '<p> </p><script>x()</script>' }, 1)).toEqual({ ok: false, reason: 'empty' })
    expect(toLegacyCommentData({ ...base, content: undefined }, 1)).toEqual({ ok: false, reason: 'empty' })
  })

  it('falls back to the local date when the GMT date is the WordPress zero date, and says so', () => {
    const r = toLegacyCommentData({ ...base, dateGmt: '0000-00-00 00:00:00' }, 1)
    expect(r.ok && r.dateFromLocal).toBe(true)
    expect(r.ok && r.data.commentedAt).toBe('2019-03-04T11:11:12.000Z')
  })

  it('threads: parent id kept, a self parent or 0 dropped', () => {
    const child = toLegacyCommentData({ ...base, parent: '99' }, 1)
    expect(child.ok && child.data.parentLegacyId).toBe(99)
    const self = toLegacyCommentData({ ...base, parent: '101' }, 1)
    expect(self.ok && self.data.parentLegacyId).toBeNull()
  })

  it('reports truncation of an over-long comment instead of failing', () => {
    const r = toLegacyCommentData({ ...base, content: 'a'.repeat(COMMENT_CONTENT_MAX + 50) }, 1)
    expect(r.ok && r.truncated).toBe(true)
    expect(r.ok && r.data.content.length).toBe(COMMENT_CONTENT_MAX)
  })
})

describe('cleanCommentContent', () => {
  it('strips HTML and scripts, keeps paragraphs as line breaks, decodes common entities', () => {
    const { text } = cleanCommentContent(
      'Hello &amp; welcome<br>\n<a href="javascript:alert(1)" onclick="x()">link</a><script>alert(1)</script><img src=x onerror=alert(1)>\n\n\n\nBye &quot;now&quot; &#8217;',
    )
    expect(text).not.toMatch(/<|script|onerror|onclick|href/i)
    expect(text).toContain('Hello & welcome')
    expect(text).toContain('link')
    expect(text).toContain('"now" ’')
    expect(text).not.toMatch(/\n{3,}/)
  })

  it('never decodes angle brackets, so the output cannot contain markup', () => {
    const { text } = cleanCommentContent('&lt;script&gt;alert(1)&lt;/script&gt; &#60;b&#62; &#x3c;i&#x3e;')
    expect(text).not.toContain('<')
    expect(text).not.toContain('>')
  })

  it('redacts email addresses typed into the text', () => {
    const { text } = cleanCommentContent('Write to me at someone.name+tag@mail.example.org or ping.')
    expect(text).toBe(`Write to me at ${EMAIL_REDACTED} or ping.`)
  })

  it('removes control characters, lone surrogates and noncharacters; keeps emoji and non-Latin text', () => {
    const { text } = cleanCommentContent('ok\u{0}\u{7} \u{D800} \u{DC00} \u{FFFE} caf\u{E9} \u{1F64F} \u{627}\u{644} \u{4E2D}')
    expect(text).toContain('café')
    expect(() => encodeURIComponent(text)).not.toThrow()
    expect(text).not.toMatch(/[\u{0}-\u{8}\u{FFFE}]/u)
    expect(text).toContain('\u{1F64F}')
    expect(text).toContain('中')
  })

  it('removes bidi overrides but keeps ZWJ and ZWNJ (emoji sequences, Persian, Indic)', () => {
    const { text } = cleanCommentContent('a\u{202E}b\u{2066}c\u{200E}d \u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467} \u{645}\u{6CC}\u{200C}\u{62E}\u{648}\u{627}\u{647}\u{645}')
    expect(text).not.toMatch(/[\u{202A}-\u{202E}\u{2066}-\u{2069}\u{200E}\u{200F}]/u)
    expect(text).toContain('\u{1F468}\u{200D}\u{1F469}')
    expect(text).toContain('\u{6CC}\u{200C}\u{62E}')
    expect(cleanCommentAuthorName('\u{202E}Ada')).toBe('Ada')
  })

  it('never cuts a surrogate pair in half at the cap', () => {
    const { text, truncated } = cleanCommentContent('a'.repeat(COMMENT_CONTENT_MAX - 1) + '\u{1F64F}\u{1F64F}')
    expect(truncated).toBe(true)
    expect(text.length).toBeLessThanOrEqual(COMMENT_CONTENT_MAX)
    expect(text).not.toMatch(/[\uD800-\uDBFF]$/)
  })

  it('copes with a huge hostile value quickly', () => {
    const started = Date.now()
    const evil = '<' + 'a'.repeat(500_000) + '&#' + '9'.repeat(100_000) + '@' + 'b.'.repeat(100_000)
    const r = cleanCommentContent(evil)
    expect(r.text.length).toBeLessThanOrEqual(COMMENT_CONTENT_MAX)
    expect(r.truncated).toBe(true)
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('non-strings become empty', () => {
    expect(cleanCommentContent(null)).toEqual({ text: '', truncated: false })
    expect(cleanCommentContent({ x: 1 })).toEqual({ text: '', truncated: false })
  })
})

describe('cleanCommentAuthorName', () => {
  it('cleans and caps names', () => {
    expect(cleanCommentAuthorName('  <b>Ada</b>\n Obi  ')).toBe('Ada Obi')
    expect(cleanCommentAuthorName('x'.repeat(500)).length).toBe(COMMENT_NAME_MAX)
    expect(cleanCommentAuthorName('Ada <ada@private.example>')).toBe('Ada')
    expect(cleanCommentAuthorName('Chinedu O’Brien')).toBe('Chinedu O’Brien')
  })
  it('replaces empty names, emails and web addresses with Anonymous', () => {
    for (const n of ['', '   ', undefined, null, 'ada@private.example', 'https://spam.example/x', 'www.spam.example']) {
      expect(cleanCommentAuthorName(n)).toBe(ANONYMOUS_NAME)
    }
  })
})

describe('toPublicComment', () => {
  it('returns only the public allowlist, whatever else the row holds', () => {
    const out = toPublicComment({
      id: 3,
      legacyId: 9,
      parentLegacyId: 2,
      authorName: 'Ada',
      commentedAt: '2019-03-04T10:11:12.000Z',
      content: 'Hi <b>there</b>',
      email: 'leak@example.test',
      ip: '1.2.3.4',
      status: 'approved',
      article: 5,
    })
    expect(Object.keys(out).sort()).toEqual(['authorName', 'commentedAt', 'content', 'id', 'legacyId', 'parentLegacyId'])
    expect(out.content).toBe('Hi there')
    expect(JSON.stringify(out)).not.toMatch(/leak|1\.2\.3\.4/)
  })
})

describe('parseCommentPaging', () => {
  const p = (q: string) => parseCommentPaging(new URLSearchParams(q))
  it('defaults, clamps and ignores junk', () => {
    expect(p('')).toEqual({ limit: 50, page: 1 })
    expect(p('limit=1000&page=2')).toEqual({ limit: 100, page: 2 })
    expect(p('limit=0&page=0')).toEqual({ limit: 50, page: 1 })
    expect(p('limit=-5&page=-1')).toEqual({ limit: 50, page: 1 })
    expect(p('limit=abc&page=1e9')).toEqual({ limit: 50, page: 1 })
    expect(p('limit=99999999999&page=99999999')).toEqual({ limit: 50, page: 10000 })
  })
})
