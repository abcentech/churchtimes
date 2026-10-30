import { describe, expect, it, vi } from 'vitest'

import {
  BRIEF_MAX_PAGES,
  briefArticleUrl,
  buildBriefText,
  fetchBriefArticles,
  isDateKey,
  lagosDateKey,
  normaliseBriefArticle,
  parseBriefArgs,
  parseCmsUrl,
  resolveBriefConfig,
  selectBriefStories,
  whatsappPlain,
  type BriefArticle,
} from '../../src/lib/whatsappBrief'

const story = (id: number, publishedAt: string, extra: Partial<BriefArticle> = {}): BriefArticle => ({
  id: String(id),
  slug: `story-${id}`,
  title: `Story ${id}`,
  excerpt: `Excerpt ${id}`,
  publishedAt,
  ...extra,
})

describe('Lagos dates', () => {
  it('uses Africa/Lagos (UTC+1) day boundaries', () => {
    expect(lagosDateKey('2026-10-29T22:59:59Z')).toBe('2026-10-29')
    expect(lagosDateKey('2026-10-29T23:00:00Z')).toBe('2026-10-30')
    expect(lagosDateKey('2026-10-30T22:59:59Z')).toBe('2026-10-30')
    expect(lagosDateKey('nope')).toBe('')
  })

  it('validates calendar dates', () => {
    expect(isDateKey('2026-02-28')).toBe(true)
    expect(isDateKey('2026-02-30')).toBe(false)
    expect(isDateKey('2026-2-3')).toBe(false)
  })
})

describe('selectBriefStories', () => {
  const day = '2026-10-30'
  const articles = [
    story(1, '2026-10-29T23:00:00.000Z'), // 00:00 Lagos on the 30th: included
    story(2, '2026-10-30T22:59:00.000Z'), // 23:59 Lagos: included
    story(3, '2026-10-30T23:00:00.000Z'), // 00:00 Lagos on the 31st: excluded
    story(4, '2026-10-29T22:59:00.000Z'), // 23:59 Lagos on the 29th: excluded
    story(6, '2026-10-30T10:00:00.000Z'),
    story(5, '2026-10-30T10:00:00.000Z'), // same time as 6: lower id first
  ]

  it("picks the day's stories, newest first, ties by ascending id", () => {
    const { stories, fallback } = selectBriefStories(articles, day, 5)
    expect(fallback).toBe(false)
    expect(stories.map((s) => s.id)).toEqual(['2', '5', '6', '1'])
  })

  it('does not depend on input order', () => {
    const a = selectBriefStories(articles, day).stories.map((s) => s.id)
    const b = selectBriefStories([...articles].reverse(), day).stories.map((s) => s.id)
    expect(a).toEqual(b)
  })

  it('respects the limit and drops duplicate slugs', () => {
    const dup = [...articles, { ...story(99, '2026-10-30T11:00:00.000Z'), slug: 'story-2' }]
    const { stories } = selectBriefStories(dup, day, 2)
    expect(stories.map((s) => s.slug)).toEqual(['story-2', 'story-5'])
  })

  it('falls back to the latest stories up to that day when the day has fewer than three', () => {
    const thin = [story(1, '2026-10-30T09:00:00.000Z'), story(2, '2026-10-28T09:00:00.000Z'), story(3, '2026-10-31T09:00:00.000Z'), story(4, '2026-10-27T09:00:00.000Z')]
    const { stories, fallback } = selectBriefStories(thin, day, 5)
    expect(fallback).toBe(true)
    expect(stories.map((s) => s.id)).toEqual(['1', '2', '4']) // never a story from after the day
  })
})

describe('normaliseBriefArticle', () => {
  it('keeps published records with a valid slug, title and date only', () => {
    expect(normaliseBriefArticle({ id: 1, slug: 'ok', title: ' T ', excerpt: 'E', status: 'published', publishedAt: '2026-10-30T09:00:00Z' })).toEqual({
      id: '1',
      slug: 'ok',
      title: 'T',
      excerpt: 'E',
      publishedAt: '2026-10-30T09:00:00.000Z',
    })
    for (const bad of [
      { slug: 'ok', title: 'T', status: 'draft', publishedAt: '2026-10-30T09:00:00Z' },
      { slug: 'Bad Slug', title: 'T', status: 'published', publishedAt: '2026-10-30T09:00:00Z' },
      { slug: 'ok', title: '', status: 'published', publishedAt: '2026-10-30T09:00:00Z' },
      { slug: 'ok', title: 'T', status: 'published', publishedAt: 'never' },
      null,
    ]) {
      expect(normaliseBriefArticle(bad)).toBeNull()
    }
  })
})

describe('article URLs', () => {
  it('follows PUBLIC_ARTICLE_PATH_TEMPLATE and refuses reserved root slugs', () => {
    expect(briefArticleUrl('bishops-meet', 'https://example.org', '/{slug}/')).toBe('https://example.org/bishops-meet/')
    expect(briefArticleUrl('bishops-meet', 'https://example.org', '/reports/{slug}/')).toBe('https://example.org/reports/bishops-meet/')
    expect(briefArticleUrl('search', 'https://example.org', '/{slug}/')).toBe('')
    expect(briefArticleUrl('search', 'https://example.org', '/reports/{slug}/')).toBe('https://example.org/reports/search/')
    expect(briefArticleUrl('bishops-meet', null, '/{slug}/')).toBe('')
  })

  it('reads the site URL with the newsletter rules (https in production)', () => {
    expect(resolveBriefConfig({ PUBLIC_SITE_URL: 'https://example.org/', NODE_ENV: 'production' })).toEqual({
      siteUrl: 'https://example.org',
      template: '/{slug}/',
    })
    expect(resolveBriefConfig({ PUBLIC_SITE_URL: 'http://example.org', NODE_ENV: 'production' }).siteUrl).toBeNull()
    expect(resolveBriefConfig({ PUBLIC_ARTICLE_PATH_TEMPLATE: '/reports/{slug}/' }).template).toBe('/reports/{slug}/')
    expect(() => resolveBriefConfig({ PUBLIC_ARTICLE_PATH_TEMPLATE: '/x/{slug}' })).toThrow()
  })
})

describe('buildBriefText', () => {
  it('builds paste-ready WhatsApp text with numbered bold headlines, short excerpts and links', () => {
    const long = 'word '.repeat(60)
    const text = buildBriefText({
      date: '2026-10-30',
      selection: {
        fallback: false,
        stories: [story(1, '2026-10-30T09:00:00.000Z', { title: 'Bishops *meet* in _Abuja_', excerpt: long }), story(2, '2026-10-30T08:00:00.000Z', { excerpt: '' })],
      },
      siteUrl: 'https://example.org',
      template: '/{slug}/',
      whatsappUrl: 'https://chat.whatsapp.com/abc',
    })
    const lines = text.split('\n')
    expect(lines[0]).toBe('*Church Times Nigeria: Daily Brief*')
    expect(lines[1]).toBe('_30 October 2026_')
    expect(text).toContain('*1. Bishops meet in Abuja*')
    expect(text).toContain('https://example.org/story-1/')
    const excerpt = lines[lines.indexOf('*1. Bishops meet in Abuja*') + 1]!
    expect(Array.from(excerpt).length).toBeLessThanOrEqual(140)
    expect(excerpt.endsWith('…')).toBe(true)
    expect(text).toContain('Join our WhatsApp group: https://chat.whatsapp.com/abc')
    expect(text.endsWith('\n')).toBe(true)
  })

  it('says when it fell back and copes with no stories or no site URL', () => {
    const fb = buildBriefText({ date: '2026-10-30', selection: { fallback: true, stories: [story(1, '2026-10-29T09:00:00.000Z')] }, siteUrl: null, template: '/{slug}/' })
    expect(fb).toContain('here are our latest reports')
    expect(fb).not.toContain('http')
    const none = buildBriefText({ date: '2026-10-30', selection: { fallback: true, stories: [] }, siteUrl: null, template: '/{slug}/' })
    expect(none).toContain('No published stories yet.')
  })

  it('strips WhatsApp formatting characters from CMS text', () => {
    expect(whatsappPlain('*bold* _it_ ~s~ `code`')).toBe('bold it s code')
  })
})

describe('fetchBriefArticles', () => {
  const page = (docs: unknown[], hasNextPage: boolean) => new Response(JSON.stringify({ docs, hasNextPage }), { status: 200 })
  const rec = (id: number, publishedAt: string) => ({ id, slug: `s-${id}`, title: `T${id}`, status: 'published', publishedAt })

  it('reads published articles newest first and stops once a page reaches days before the date', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(page([rec(3, '2026-10-31T09:00:00Z'), rec(2, '2026-10-30T09:00:00Z')], true))
      .mockResolvedValueOnce(page([rec(1, '2026-10-29T09:00:00Z')], true))
    const out = await fetchBriefArticles('https://cms.example.org', '2026-10-30', fetchImpl)
    expect(out.map((a) => a.id)).toEqual(['3', '2', '1'])
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    const url = new URL(fetchImpl.mock.calls[0]![0] as string)
    expect(url.pathname).toBe('/api/articles')
    expect(url.searchParams.get('where[status][equals]')).toBe('published')
    expect(url.searchParams.get('sort')).toBe('-publishedAt')
    expect(url.searchParams.get('depth')).toBe('0')
  })

  it('stops after BRIEF_MAX_PAGES and fails on an HTTP error or a bad body', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => page([rec(9, '2026-10-30T09:00:00Z')], true))
    await fetchBriefArticles('https://cms.example.org', '2026-10-30', fetchImpl)
    expect(fetchImpl).toHaveBeenCalledTimes(BRIEF_MAX_PAGES)
    await expect(fetchBriefArticles('https://cms.example.org', '2026-10-30', async () => new Response('x', { status: 500 }))).rejects.toThrow('500')
    await expect(fetchBriefArticles('https://cms.example.org', '2026-10-30', async () => new Response('{}'))).rejects.toThrow('Unexpected')
  })
})

describe('parseBriefArgs', () => {
  const now = new Date('2026-10-29T23:30:00Z') // already the 30th in Lagos

  it('defaults to today in Lagos, limit 5 and CMS_PUBLIC_URL', () => {
    expect(parseBriefArgs([], now, { CMS_PUBLIC_URL: 'https://cms.example.org/' }, '/out')).toEqual({
      date: '2026-10-30',
      out: '/out',
      limit: 5,
      cmsUrl: 'https://cms.example.org',
    })
  })

  it('parses every option and rejects bad values', () => {
    expect(parseBriefArgs(['--', '--date', '2026-01-02', '--out', 'x', '--limit', '3', '--cms-url', 'http://localhost:3000'], now, {}, '/out')).toEqual({
      date: '2026-01-02',
      out: 'x',
      limit: 3,
      cmsUrl: 'http://localhost:3000',
    })
    expect(() => parseBriefArgs(['--date', '2026-13-01'], now, {}, '/o')).toThrow('YYYY-MM-DD')
    expect(() => parseBriefArgs(['--limit', '0'], now, {}, '/o')).toThrow('--limit')
    expect(() => parseBriefArgs(['--cms-url', 'http://cms.example.org'], now, {}, '/o')).toThrow('--cms-url')
    expect(() => parseBriefArgs(['--date'], now, {}, '/o')).toThrow('needs a value')
    expect(() => parseBriefArgs(['--nope', 'x'], now, {}, '/o')).toThrow('Unknown option')
  })

  it('accepts only https or loopback http CMS URLs without credentials', () => {
    expect(parseCmsUrl('https://cms.example.org/api')).toBe('https://cms.example.org')
    expect(parseCmsUrl('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000')
    expect(parseCmsUrl('https://user:pw@cms.example.org')).toBeNull()
    expect(parseCmsUrl('ftp://cms.example.org')).toBeNull()
    expect(parseCmsUrl(undefined)).toBeNull()
  })
})
