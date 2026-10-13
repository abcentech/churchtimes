import { describe, expect, it } from 'vitest'

import { checkRelationFilters } from '../../src/lib/queryGuards'

const check = (qs: string, path = '/api/articles') => checkRelationFilters(path, new URLSearchParams(qs))

describe('checkRelationFilters', () => {
  it('accepts numeric IDs, id lists and null', () => {
    expect(check('where[category][equals]=3').ok).toBe(true)
    expect(check('where[category][in]=1,2,3').ok).toBe(true)
    expect(check('where[or][0][category][equals]=7&where[status][equals]=published').ok).toBe(true)
    expect(check('where[featuredImage][equals]=null').ok).toBe(true)
    expect(check('where[version.category][equals]=2', '/api/articles/versions').ok).toBe(true)
    expect(check('where[event][equals]=12&where[status][equals]=pending', '/api/live-updates').ok).toBe(true)
  })

  it('rejects slugs, mixed lists and overlong numbers with the offending key', () => {
    expect(check('where[category][equals]=faith-society')).toMatchObject({ ok: false, status: 400, field: 'where[category][equals]' })
    expect(check('where[category][in]=1,news')).toMatchObject({ ok: false })
    expect(check('where[category][in][0]=news')).toMatchObject({ ok: false })
    expect(check('where[and][1][author][not_equals]=me')).toMatchObject({ ok: false })
    expect(check('where[category][equals]=99999999999999999999')).toMatchObject({ ok: false })
    expect(check('where[category][equals]=')).toMatchObject({ ok: false })
    expect(check('where[category][in]=null')).toMatchObject({ ok: false })
  })

  it('ignores other fields, nested paths, other operators and non-API paths', () => {
    expect(check('where[slug][equals]=my-story').ok).toBe(true)
    expect(check('where[category.slug][equals]=news').ok).toBe(true)
    expect(check('where[category][exists]=true').ok).toBe(true)
    expect(check('category=news').ok).toBe(true)
    expect(check('where[category][equals]=news', '/admin/collections/articles').ok).toBe(true)
  })
})
