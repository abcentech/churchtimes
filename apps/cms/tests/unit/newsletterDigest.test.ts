import { describe, expect, it } from 'vitest'

import {
  digestSubject,
  digestWindowStart,
  lagosHour,
  normaliseDigestSettings,
  normaliseDigestStory,
  renderDigestHtml,
  renderDigestText,
  selectDigestStories,
  type DigestContent,
  type DigestStory,
} from '../../src/lib/newsletterDigest'

const story = (id: number, publishedAt: string, extra: Partial<DigestStory> = {}): DigestStory => ({
  id: String(id),
  slug: `story-${id}`,
  title: `Story ${id}`,
  excerpt: `Excerpt ${id}`,
  publishedAt,
  category: 'Church',
  ...extra,
})

const links = { unsubscribePageUrl: 'https://churchtimesnigeria.net/newsletter/unsubscribe?token=u1.5.abc' }

describe('normaliseDigestSettings', () => {
  it('is fully OFF with safe defaults when the global is missing or malformed', () => {
    expect(normaliseDigestSettings(null)).toEqual({
      enabled: false,
      dailyDigestEnabled: false,
      sendHourLagos: 6,
      dailySendCap: 100,
      fromName: 'Church Times Nigeria',
      replyTo: '',
      maxStoriesPerDigest: 6,
      includeDevotional: false,
    })
    const odd = normaliseDigestSettings({ enabled: 'true', sendHourLagos: 24, dailySendCap: -3, maxStoriesPerDigest: 21, fromName: 'A\r\nB "<x>"' })
    expect(odd.enabled).toBe(false)
    expect(odd.sendHourLagos).toBe(6)
    expect(odd.dailySendCap).toBe(100)
    expect(odd.maxStoriesPerDigest).toBe(6)
    expect(odd.fromName).toBe('A B x')
  })

  it('keeps valid values, including a cap of 0', () => {
    const s = normaliseDigestSettings({ enabled: true, dailyDigestEnabled: true, sendHourLagos: 0, dailySendCap: 0, maxStoriesPerDigest: 20 })
    expect(s).toMatchObject({ enabled: true, dailyDigestEnabled: true, sendHourLagos: 0, dailySendCap: 0, maxStoriesPerDigest: 20 })
  })
})

describe('story selection', () => {
  it('whitelists article rows and drops unusable ones', () => {
    expect(normaliseDigestStory({ id: 1, slug: 'Bad Slug', title: 'x', publishedAt: '2026-10-30T00:00:00Z' })).toBeNull()
    expect(normaliseDigestStory({ id: 1, slug: 'ok', title: '', publishedAt: '2026-10-30T00:00:00Z' })).toBeNull()
    expect(normaliseDigestStory({ id: 1, slug: 'ok', title: 'T', publishedAt: 'nope' })).toBeNull()
    expect(
      normaliseDigestStory({ id: 9, slug: 'ok', title: ' T\n<b> ', excerpt: 'E', publishedAt: '2026-10-30T08:00:00+01:00', category: { title: 'Faith' }, content: { secret: 1 } }),
    ).toEqual({ id: '9', slug: 'ok', title: 'T <b>', excerpt: 'E', publishedAt: '2026-10-30T07:00:00.000Z', category: 'Faith' })
    expect(
      normaliseDigestStory({ id: 9, slug: 'ok', title: 'Ad', publishedAt: '2026-10-30T08:00:00Z', category: { title: 'Faith' }, contentType: 'sponsored' })?.category,
    ).toBe('Sponsored')
  })

  it('is deterministic: window, newest first, id tie-break, de-duplicated, capped', () => {
    const since = new Date('2026-10-29T05:00:00Z')
    const now = new Date('2026-10-30T05:00:00Z')
    const input = [
      story(1, '2026-10-29T05:00:00.000Z'), // exactly at the window start: excluded (previous issue had it)
      story(2, '2026-10-29T09:00:00.000Z'),
      story(3, '2026-10-30T04:00:00.000Z'),
      story(10, '2026-10-30T04:00:00.000Z'),
      story(4, '2026-10-30T06:00:00.000Z'), // in the future relative to now
      { ...story(5, '2026-10-29T08:00:00.000Z'), slug: 'story-2' }, // duplicate slug, older
    ]
    const a = selectDigestStories(input, since, now, 6).map((s) => s.id)
    const b = selectDigestStories([...input].reverse(), since, now, 6).map((s) => s.id)
    expect(a).toEqual(['10', '3', '2'])
    expect(b).toEqual(a)
    expect(selectDigestStories(input, since, now, 2).map((s) => s.id)).toEqual(['10', '3'])
  })

  it('window starts at the previous issue, or 24 h back, never more than 7 days back', () => {
    const now = new Date('2026-10-30T06:00:00Z')
    expect(digestWindowStart(null, now).toISOString()).toBe('2026-10-29T06:00:00.000Z')
    expect(digestWindowStart(new Date('2026-10-29T05:00:00Z'), now).toISOString()).toBe('2026-10-29T05:00:00.000Z')
    expect(digestWindowStart(new Date('2026-09-01T05:00:00Z'), now).toISOString()).toBe('2026-10-23T06:00:00.000Z')
  })

  it('computes the Lagos hour (UTC+1, no DST)', () => {
    expect(lagosHour(new Date('2026-10-30T05:00:00Z'))).toBe(6)
    expect(lagosHour(new Date('2026-10-30T23:30:00Z'))).toBe(0)
  })
})

describe('templates', () => {
  const content: DigestContent = {
    date: '2026-10-30',
    stories: [
      story(1, '2026-10-30T05:00:00.000Z', { title: 'Bishops <script>alert(1)</script> & "elders" meet', excerpt: "Ọba's <img src=x onerror=alert(1)>", category: 'News & <Views>' }),
      story(2, '2026-10-30T04:00:00.000Z', { slug: 'admin', title: 'Reserved slug story' }),
    ],
    siteUrl: 'https://churchtimesnigeria.net',
    template: '/{slug}/',
    devotional: { reference: 'John 3:16', text: 'For God so loved the world <b>', version: 'KJV' },
  }

  it('HTML escapes all CMS text, links only safe URLs and has no images, scripts or tracking', () => {
    const out = renderDigestHtml(content, links)
    expect(out).not.toMatch(/<script|<img|<b>|<[^>]*onerror=/i)
    expect(out).toContain('Bishops &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;elders&quot; meet')
    expect(out).toContain('Ọba&#39;s &lt;img src=x onerror=alert(1)&gt;')
    expect(out).toContain('News &amp; &lt;Views&gt;')
    expect(out).toContain('href="https://churchtimesnigeria.net/story-1/"')
    // A reserved slug can never become a link (it would hit a site route, not the article).
    expect(out).not.toContain('https://churchtimesnigeria.net/admin/')
    expect(out).toContain('href="https://churchtimesnigeria.net/newsletter/unsubscribe?token=u1.5.abc"')
    expect(out).toContain('(KJV, public domain)')
    expect(out).toContain('lang="en"')
  })

  it('plain text carries every story, the unsubscribe link and the sender identity', () => {
    const text = renderDigestText(content, links)
    expect(text).toContain('1. Bishops <script>alert(1)</script> & "elders" meet [News & <Views>]')
    expect(text).toContain('https://churchtimesnigeria.net/story-1/')
    expect(text).toContain('Unsubscribe: https://churchtimesnigeria.net/newsletter/unsubscribe?token=u1.5.abc')
    expect(text).toContain('Verse of the day (KJV, public domain)')
    expect(text).toContain('Churchtimes Agency Ltd')
  })

  it('is byte-for-byte deterministic and the subject is clamped', () => {
    expect(renderDigestHtml(content, links)).toBe(renderDigestHtml(structuredClone(content), links))
    expect(renderDigestText(content, links)).toBe(renderDigestText(structuredClone(content), links))
    expect(digestSubject(content)).toMatch(/^Church Times Nigeria daily briefing, 30 October 2026: Bishops/)
    const long = { date: '2026-10-30', stories: [story(1, '2026-10-30T05:00:00Z', { title: 'x'.repeat(400) })] }
    expect(Array.from(digestSubject(long)).length).toBeLessThanOrEqual(150)
    expect(digestSubject({ date: '2026-10-30', stories: [] })).toBe('Church Times Nigeria daily briefing, 30 October 2026')
  })

  it('without a public site URL, stories render as text without links', () => {
    const out = renderDigestHtml({ ...content, siteUrl: null, devotional: null }, links)
    expect(out).not.toContain('story-1/')
    expect(out).not.toContain('Verse of the day')
  })
})
