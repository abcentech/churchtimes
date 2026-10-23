import { describe, expect, it } from 'vitest'

import { bylineFor, chooseCategory, chooseCategoryChain, cleanLegacyUrl, isCategorySlug, parseCategoryMap, resolveSeoText, validCanonical } from '../../src/import/mapping'

const t = (nicename: string) => ({ nicename, name: nicename })

describe('chooseCategory', () => {
  it('keeps the first category and counts the ones the schema cannot hold', () => {
    const c = chooseCategory([t('news'), t('sport'), t('faith')])
    expect(c.primary?.nicename).toBe('news')
    expect(c.dropped).toBe(2)
  })
  it('prefers a real category over Uncategorised and ignores duplicates and nameless terms', () => {
    const c = chooseCategory([t('uncategorised'), t('news'), t('news'), { nicename: '', name: 'x' }])
    expect(c.primary?.nicename).toBe('news')
    expect(c.dropped).toBe(1)
  })
  it('falls back to Uncategorised when it is the only one, and to nothing when there are none', () => {
    expect(chooseCategory([t('uncategorized')])).toMatchObject({ dropped: 0, primary: { nicename: 'uncategorized' } })
    expect(chooseCategory([])).toEqual({ primary: undefined, dropped: 0 })
  })
})

describe('bylineFor', () => {
  const clean = (s: string) => (s.includes('@') ? '' : s.trim())
  it('prefers the display name, falls back to the login, never keeps an email', () => {
    expect(bylineFor('ed', 'Ed Synthetic', clean)).toEqual({ key: 'ed', byline: 'Ed Synthetic' })
    expect(bylineFor('Pat Writer', undefined, clean)).toEqual({ key: 'pat writer', byline: 'Pat Writer' })
    expect(bylineFor('pat@mail.example.test', 'pat@mail.example.test', clean)).toEqual({ key: 'pat@mail.example.test', byline: '' })
    expect(bylineFor('', 'x', clean)).toBeNull()
  })
})

describe('cleanLegacyUrl', () => {
  it.each([
    ['https://old.example.test/2023/05/story/', 'https://old.example.test/2023/05/story/'],
    ['https://old.example.test/story/?utm=1#top', 'https://old.example.test/story/'],
    ['http://old.example.test:8080/a/b', 'http://old.example.test:8080/a/b'],
    ['/2023/05/story/?replytocom=3#c', '/2023/05/story/'],
    ['  /story/  ', '/story/'],
  ])('accepts %s', (input, out) => expect(cleanLegacyUrl(input)).toBe(out))

  it.each([
    '',
    'javascript:alert(1)',
    'data:text/html,x',
    'ftp://old.example.test/a',
    '//evil.example.test/a',
    'story/relative',
    '/',
    'https://old.example.test/?p=12',
    'https://user:pw@old.example.test/a',
    '/a b',
    '/a\b',
    '/a<script>',
    '/a\u0000b',
    `/${'a'.repeat(1001)}`,
  ])('refuses %j', (input) => expect(cleanLegacyUrl(input)).toBeUndefined())
})

describe('resolveSeoText (Yoast %%vars%% and Rank Math %vars%)', () => {
  const ctx = { title: 'Synthetic Story', categoryName: 'Faith', dateGmt: '2023-05-04T10:30:00.000Z', excerpt: 'A short excerpt.' }
  const y = (raw: string, max = 70) => resolveSeoText(raw, 'yoast', ctx, max)
  const r = (raw: string, max = 70) => resolveSeoText(raw, 'rankmath', ctx, max)

  it('substitutes the known Yoast variables', () => {
    expect(y('%%title%% %%page%% %%sep%% %%sitename%%')).toMatchObject({ value: 'Synthetic Story - Church Times Nigeria', status: 'ok', hadVariables: true })
    expect(y('%%primary_category%%: %%title%% (%%date%%)').value).toBe('Faith: Synthetic Story (4 May 2023)')
    expect(y('%%excerpt%%').value).toBe('A short excerpt.')
  })
  it('removes unknown variables and tidies the separators they leave', () => {
    expect(y('%%name%% %%sep%% %%title%%').value).toBe('Synthetic Story')
    expect(y('%%title%% %%sep%% %%cf_secret%% %%sep%% %%sitename%%').value).toBe('Synthetic Story - Church Times Nigeria')
    expect(y('%%sitedesc%%')).toMatchObject({ value: undefined, status: 'none' })
  })
  it('drops a value that still holds variable text afterwards', () => {
    expect(y('Title %%not closed')).toMatchObject({ value: undefined, status: 'dropped' })
    expect(y('Odd %broken% value')).toMatchObject({ value: undefined, status: 'dropped' })
    const t = resolveSeoText('%%title%%', 'yoast', { ...ctx, title: 'Pure %Silk% Story' }, 70)
    expect(t).toMatchObject({ value: undefined, status: 'dropped' })
  })
  it('resolves Rank Math single-percent variables with the same rules', () => {
    expect(r('%title% %sep% %sitename%').value).toBe('Synthetic Story - Church Times Nigeria')
    expect(r('%customfield(secret)% Plain').value).toBe('Plain')
    expect(r('50% of 60% rise').value).toBe('50% of 60% rise')
  })
  it('strips markup and decodes entities without creating markup', () => {
    expect(y('Tom &amp; Jerry &#8217;s <b>bold</b> <script>alert(1)</script>day').value).toBe('Tom & Jerry ’s bold day')
    expect(y('A &lt;b&gt; &#60;i&#62; stays text').value).toBe('A &lt;b&gt; &#60;i&#62; stays text')
    expect(y('<p>Line one</p>\n\n<p>Line   two</p>').value).toBe('Line one Line two')
    expect(y('   ')).toMatchObject({ value: undefined, status: 'none' })
    expect(y('')).toMatchObject({ value: undefined, status: 'none' })
    expect(resolveSeoText(null, 'yoast', ctx, 70)).toMatchObject({ status: 'none' })
  })
  it('keeps within the limit: drops the site suffix first, then cuts at a word with an ellipsis', () => {
    const long = { ...ctx, title: 'A fairly long synthetic headline about a thing that happened' }
    const t = resolveSeoText('%%title%% %%sep%% %%sitename%%', 'yoast', long, 70)
    expect(t.value).toBe('A fairly long synthetic headline about a thing that happened')
    expect(t.truncated).toBe(false)
    const d = y('word '.repeat(80), 200)
    expect(d.truncated).toBe(true)
    expect(d.value!.length).toBeLessThanOrEqual(200)
    expect(d.value!.endsWith('word…')).toBe(true)
    const noSpaces = y('x'.repeat(500), 70)
    expect(noSpaces.value!.length).toBe(70)
  })
  it('refuses absurdly long raw values and stays fast on percent-heavy input', () => {
    expect(y('a'.repeat(30_000))).toMatchObject({ value: undefined, status: 'dropped' })
    const t0 = Date.now()
    y('%'.repeat(5000) + 'x%'.repeat(5000))
    r('%'.repeat(5000) + '(' + ')'.repeat(5000))
    expect(Date.now() - t0).toBeLessThan(2000)
  })
})

describe('validCanonical', () => {
  const hosts = ['old.example.test']
  it('accepts https, same-site http and paths; refuses the rest', () => {
    expect(validCanonical('https://other.example.test/a/', hosts)).toBe(true)
    expect(validCanonical('http://old.example.test/a/', hosts)).toBe(true)
    expect(validCanonical('/2023/05/a/', hosts)).toBe(true)
    expect(validCanonical('http://elsewhere.example.test/a/', hosts)).toBe(false)
    expect(validCanonical('//evil.example.test/a', hosts)).toBe(false)
    expect(validCanonical('javascript:alert(1)', hosts)).toBe(false)
    expect(validCanonical('https://u:p@old.example.test/', hosts)).toBe(false)
    expect(validCanonical(null, hosts)).toBe(false)
  })
})

describe('chooseCategoryChain', () => {
  const news = t('news')
  const faith = t('faith')
  const lookups = {
    byTermId: new Map([[3, news], [7, faith], [9, t('uncategorised')]]),
    byNicename: new Map([['news', news], ['faith', faith]]),
    tagMap: { 'church-life': 'faith', 'ghost-tag': 'not-a-category' } as Record<string, string>,
  }
  const src = (o: Partial<{ categories: ReturnType<typeof t>[]; tags: ReturnType<typeof t>[]; primaryCategory: string | null }>) => ({ categories: [], tags: [], primaryCategory: null, ...o })

  it('1: a real WordPress category wins over everything', () => {
    const c = chooseCategoryChain(src({ categories: [news, faith], primaryCategory: '7', tags: [t('church-life')] }), lookups)
    expect(c).toMatchObject({ step: 'wordpress', dropped: 1, term: { nicename: 'news' } })
  })
  it('2: the Yoast primary category when there is none, resolved through the channel term ids', () => {
    expect(chooseCategoryChain(src({ primaryCategory: ' 7 ' }), lookups)).toMatchObject({ step: 'yoast-primary', term: { nicename: 'faith' }, primaryUnresolved: false })
    expect(chooseCategoryChain(src({ primaryCategory: '99' }), lookups)).toMatchObject({ step: 'fallback', primaryUnresolved: true })
    expect(chooseCategoryChain(src({ primaryCategory: 'abc' }), lookups)).toMatchObject({ step: 'fallback', primaryUnresolved: true })
    expect(chooseCategoryChain(src({ primaryCategory: '9' }), lookups)).toMatchObject({ step: 'fallback', primaryUnresolved: false })
  })
  it('3: the first tag with a map entry; a target outside the export must already exist', () => {
    expect(chooseCategoryChain(src({ tags: [t('unmapped'), t('church-life')] }), lookups)).toMatchObject({ step: 'tag-map', term: { nicename: 'faith' }, mustExist: false })
    expect(chooseCategoryChain(src({ tags: [t('ghost-tag')] }), lookups)).toMatchObject({ step: 'tag-map', term: { nicename: 'not-a-category' }, mustExist: true })
    expect(chooseCategoryChain(src({ tags: [t('church-life')], primaryCategory: '3' }), lookups).step).toBe('yoast-primary')
    expect(chooseCategoryChain(src({ tags: [t('church-life')] }), { ...lookups, tagMap: {} }).step).toBe('fallback')
    expect(chooseCategoryChain(src({ tags: [t('constructor'), t('__proto__'), t('toString')] }), lookups).step).toBe('fallback')
  })
  it('4: generic Uncategorised is kept only when nothing better applies; else the fallback', () => {
    expect(chooseCategoryChain(src({ categories: [t('uncategorized')] }), lookups).step).toBe('generic')
    expect(chooseCategoryChain(src({ categories: [t('uncategorized')], primaryCategory: '7' }), lookups)).toMatchObject({ step: 'yoast-primary', term: { nicename: 'faith' } })
    expect(chooseCategoryChain(src({}), lookups)).toMatchObject({ step: 'fallback', term: undefined })
  })
})

describe('parseCategoryMap', () => {
  it('accepts a flat object of slugs only', () => {
    expect(parseCategoryMap('{"church-life":"faith"}')).toEqual({ 'church-life': 'faith' })
    expect(parseCategoryMap('{"a":"Not A Slug"}')).toBeUndefined()
    expect(parseCategoryMap('{"a":1}')).toBeUndefined()
    expect(parseCategoryMap('[]')).toBeUndefined()
    expect(parseCategoryMap('null')).toBeUndefined()
    expect(parseCategoryMap('not json')).toBeUndefined()
    expect(parseCategoryMap('{"__proto__":"faith"}')).toBeUndefined()
    expect(isCategorySlug('news')).toBe(true)
    expect(isCategorySlug('News')).toBe(false)
  })
})
