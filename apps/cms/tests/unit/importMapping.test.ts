import { describe, expect, it } from 'vitest'

import { bylineFor, chooseCategory, cleanLegacyUrl } from '../../src/import/mapping'

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
