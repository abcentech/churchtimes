import { describe, expect, it } from 'vitest'

import {
  PLACEMENT_SIZES,
  approvalProblems,
  cacheSeconds,
  checkCreativeSize,
  creativeMediaIds,
  inWindow,
  isAnimatedImage,
  liveCampaignClauses,
  missingCreatives,
  normalizeDestinationUrl,
  paymentOk,
  requirePayment,
  toPublicCampaign,
} from '../../src/lib/advertising'

const T = Date.parse('2026-10-14T12:00:00Z')

describe('placement sizes (contract C3.1 table)', () => {
  it('matches the public renderer', () => {
    expect(PLACEMENT_SIZES['homepage-billboard']).toEqual({
      desktop: { width: 970, height: 250 },
      mobile: { width: 320, height: 100 },
    })
    expect(PLACEMENT_SIZES['article-inline']).toEqual({
      desktop: { width: 728, height: 90 },
      mobile: { width: 320, height: 100 },
    })
    expect(PLACEMENT_SIZES['mobile-banner']).toEqual({ mobile: { width: 320, height: 50 } })
  })
  it('checks exact dimensions only', () => {
    expect(checkCreativeSize('mobile-banner', 'mobile', { width: 320, height: 50 })).toBeNull()
    expect(checkCreativeSize('mobile-banner', 'mobile', { width: 320, height: 100 })).toMatch(/320x50/)
    expect(checkCreativeSize('mobile-banner', 'desktop', { width: 970, height: 250 })).toMatch(/no desktop/)
    expect(checkCreativeSize('article-inline', 'desktop', { width: 729, height: 90 })).toMatch(/728x90/)
    expect(checkCreativeSize('homepage-billboard', 'desktop', {})).toMatch(/970x250/)
  })
})

describe('schedule', () => {
  it('start is inclusive and end is exclusive', () => {
    const s = '2026-10-14T12:00:00Z'
    const e = '2026-10-14T13:00:00Z'
    expect(inWindow(s, e, T - 1)).toBe(false)
    expect(inWindow(s, e, T)).toBe(true)
    expect(inWindow(s, e, Date.parse(e) - 1)).toBe(true)
    expect(inWindow(s, e, Date.parse(e))).toBe(false)
    expect(inWindow('nonsense', e, T)).toBe(false)
  })
  it('cache seconds is min(60, seconds to the next boundary), rounded down', () => {
    expect(cacheSeconds([], T)).toBe(60)
    expect(cacheSeconds([T + 3_600_000], T)).toBe(60)
    expect(cacheSeconds([T + 30_000], T)).toBe(30)
    expect(cacheSeconds([T + 30_999], T)).toBe(30)
    expect(cacheSeconds([T + 500], T)).toBe(0)
    expect(cacheSeconds([T - 5000, T + 90_000, T + 12_000], T)).toBe(12)
    expect(cacheSeconds([T], T)).toBe(60) // a boundary at "now" is already past
  })
})

describe('destination URL', () => {
  it('accepts only absolute https without credentials', () => {
    expect(normalizeDestinationUrl('https://example.test/offer?a=1')).toBe('https://example.test/offer?a=1')
    expect(normalizeDestinationUrl('  https://Example.TEST  ')).toBe('https://example.test/') // the stored value is the normalised href
    for (const bad of [
      'http://example.test',
      'javascript:alert(1)',
      'https://user:pw@example.test',
      '//example.test',
      '/relative',
      'https://exa mple.test',
      '',
      `https://example.test/${'a'.repeat(500)}`,
      42,
      null,
    ]) {
      expect(normalizeDestinationUrl(bad), String(bad)).toBeNull()
    }
  })
})

describe('payment and approval gate', () => {
  it('defaults to requiring payment', () => {
    expect(requirePayment({})).toBe(true)
    expect(requirePayment({ ADS_REQUIRE_PAYMENT: 'true' })).toBe(true)
    expect(requirePayment({ ADS_REQUIRE_PAYMENT: 'nope' })).toBe(true)
    expect(requirePayment({ ADS_REQUIRE_PAYMENT: 'FALSE' })).toBe(false)
    expect(paymentOk('paid', true)).toBe(true)
    expect(paymentOk('waived', true)).toBe(true)
    expect(paymentOk('invoiced', true)).toBe(false)
    expect(paymentOk('unpaid', false)).toBe(true)
  })
  const creatives = { homepageBillboard: { desktop: 1, mobile: 2 }, mobileBanner: { mobile: 3 } }
  it('reports missing creatives per selected placement', () => {
    expect(missingCreatives(['homepage-billboard', 'mobile-banner'], creatives)).toEqual([])
    expect(missingCreatives(['article-inline'], creatives)).toEqual(['article-inline desktop', 'article-inline mobile'])
    expect(missingCreatives(['homepage-billboard'], { homepageBillboard: { mobile: 2 } })).toEqual(['homepage-billboard desktop'])
  })
  it('lists every problem that blocks approval', () => {
    const ok = { rightsConfirmed: true, paymentStatus: 'paid', placements: ['mobile-banner'], creatives }
    expect(approvalProblems(ok, true)).toEqual([])
    expect(approvalProblems({ ...ok, rightsConfirmed: false }, true)).toHaveLength(1)
    expect(approvalProblems({ ...ok, paymentStatus: 'unpaid' }, true)).toHaveLength(1)
    expect(approvalProblems({ ...ok, paymentStatus: 'unpaid' }, false)).toEqual([])
    expect(approvalProblems({ ...ok, placements: [] }, true).length).toBeGreaterThan(0)
    expect(approvalProblems({ ...ok, placements: ['article-inline'] }, true)[0]).toMatch(/Missing creatives/)
  })
  it('only counts creatives of the selected placements for media access', () => {
    expect(creativeMediaIds(creatives, ['mobile-banner'])).toEqual([3])
    expect(creativeMediaIds(creatives).sort()).toEqual([1, 2, 3])
    expect(creativeMediaIds({ homepageBillboard: { desktop: { id: 7 } } })).toEqual([7])
  })
})

describe('liveCampaignClauses', () => {
  it('builds the same predicate for a query and for the media join', () => {
    const q = liveCampaignClauses('', T, true)
    expect(q).toContainEqual({ status: { equals: 'approved' } })
    expect(q).toContainEqual({ startsAt: { less_than_equal: '2026-10-14T12:00:00.000Z' } })
    expect(q).toContainEqual({ endsAt: { greater_than: '2026-10-14T12:00:00.000Z' } })
    expect(q).toContainEqual({ paymentStatus: { in: ['paid', 'waived'] } })
    expect(liveCampaignClauses('x.', T, false).some((c) => 'x.paymentStatus' in c)).toBe(false)
    expect(liveCampaignClauses('x.', T, false)[0]).toEqual({ 'x.status': { equals: 'approved' } })
  })
})

describe('animated image detection', () => {
  const png = (chunks: string[]) => {
    const parts: number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    for (const c of chunks) parts.push(0, 0, 0, 0, ...[...c].map((x) => x.charCodeAt(0)), 0, 0, 0, 0)
    return Uint8Array.from(parts)
  }
  it('detects APNG', () => {
    expect(isAnimatedImage(png(['IHDR', 'acTL', 'IDAT', 'IEND']))).toBe(true)
    expect(isAnimatedImage(png(['IHDR', 'IDAT', 'acTL', 'IEND']))).toBe(false) // acTL must precede IDAT
    expect(isAnimatedImage(png(['IHDR', 'IDAT', 'IEND']))).toBe(false)
  })
  const webp = (type: string, payload: number[]) => {
    const body = [...[...'WEBP'].map((c) => c.charCodeAt(0)), ...[...type].map((c) => c.charCodeAt(0)), payload.length, 0, 0, 0, ...payload]
    return Uint8Array.from([...[...'RIFF'].map((c) => c.charCodeAt(0)), body.length, 0, 0, 0, ...body])
  }
  it('detects animated WebP', () => {
    expect(isAnimatedImage(webp('VP8X', [0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(true)
    expect(isAnimatedImage(webp('VP8X', [0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(false)
    expect(isAnimatedImage(webp('ANIM', [0, 0, 0, 0, 0, 0]))).toBe(true)
    expect(isAnimatedImage(webp('VP8 ', [0, 0, 0, 0]))).toBe(false)
  })
  it('never treats JPEG or junk as animated', () => {
    expect(isAnimatedImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe(false)
    expect(isAnimatedImage(new Uint8Array(0))).toBe(false)
  })
})

describe('toPublicCampaign', () => {
  const media = new Map([
    ['1', { filename: 'd.webp', width: 970, height: 250 }],
    ['2', { filename: 'm one.webp', width: 320, height: 100 }],
  ])
  const base = {
    id: 5,
    sponsor: 'Example advertiser',
    alt: 'Offer',
    destinationUrl: 'https://example.test/offer',
    startsAt: '2026-10-14T00:00:00.000Z',
    endsAt: new Date('2026-10-31T00:00:00Z'),
    priority: 10,
    placements: ['homepage-billboard'],
    creatives: { homepageBillboard: { desktop: 1, mobile: 2 } },
    // staff-only data that must never be copied
    advertiser: 9,
    paymentStatus: 'paid',
    notes: 'secret',
    approvedBy: 3,
    contactEmail: 'a@example.test',
  }
  it('copies the whitelist only and builds absolute src', () => {
    const out = toPublicCampaign(base, media, 'https://cms.example.test')!
    expect(out).toEqual({
      id: 'ac_5',
      status: 'active',
      sponsor: 'Example advertiser',
      alt: 'Offer',
      destinationUrl: 'https://example.test/offer',
      startsAt: '2026-10-14T00:00:00.000Z',
      endsAt: '2026-10-31T00:00:00.000Z',
      priority: 10,
      placements: ['homepage-billboard'],
      creatives: {
        'homepage-billboard': {
          desktop: { src: 'https://cms.example.test/api/media/file/d.webp', width: 970, height: 250 },
          mobile: { src: 'https://cms.example.test/api/media/file/m%20one.webp', width: 320, height: 100 },
        },
      },
    })
    expect(JSON.stringify(out)).not.toMatch(/paid|secret|a@example|approvedBy|"advertiser"|paymentStatus|contactEmail/)
  })
  it('re-checks the destination address and skips a campaign that has a bad one', () => {
    for (const destinationUrl of ['http://example.test/', 'javascript:alert(1)', 'https://u:p@example.test/', '']) {
      expect(toPublicCampaign({ ...base, destinationUrl }, media, 'https://x.test'), destinationUrl).toBeNull()
    }
  })
  it('can leave out the start clause to find upcoming boundaries', () => {
    const withStart = liveCampaignClauses('', T, true)
    const upcoming = liveCampaignClauses('', T, true, { includeUpcoming: true })
    expect(withStart.some((c) => 'startsAt' in c)).toBe(true)
    expect(upcoming.some((c) => 'startsAt' in c)).toBe(false)
    expect(upcoming).toHaveLength(withStart.length - 1)
  })
  it('drops a campaign whose creative is missing instead of delivering it broken', () => {
    expect(toPublicCampaign({ ...base, creatives: { homepageBillboard: { desktop: 1 } } }, media, 'https://x.test')).toBeNull()
    expect(toPublicCampaign({ ...base, placements: [] }, media, 'https://x.test')).toBeNull()
  })
})
