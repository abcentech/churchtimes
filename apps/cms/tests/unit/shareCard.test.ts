import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

import {
  BRIEF_SIZE,
  clampText,
  cleanCardText,
  escapeMarkup,
  formatLagosDate,
  OG_HEIGHT,
  OG_WIDTH,
  renderBriefCard,
  renderShareCard,
  resolveFontFile,
} from '../../src/lib/shareCard'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

describe('share card text helpers', () => {
  it('escapes every Pango markup character', () => {
    expect(escapeMarkup(`<b a="1">Tom & 'Jerry'</b>`)).toBe('&lt;b a=&quot;1&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/b&gt;')
  })

  it('folds control characters, line breaks and whitespace runs into single spaces and normalises to NFC', () => {
    expect(cleanCardText('  A\u0000B\nC\t\tD\u2028E  ')).toBe('A B C D E')
    expect(cleanCardText('e\u0323')).toBe('\u1eb9') // e + combining dot below -> \u1eb9
    expect(cleanCardText(42)).toBe('')
    expect(cleanCardText('x'.repeat(50), 10)).toHaveLength(10)
  })

  it('clamps at a word boundary with an ellipsis and leaves short text alone', () => {
    expect(clampText('Short headline', 40)).toBe('Short headline')
    const out = clampText('Bishops gather in Abuja for the national prayer summit tomorrow', 30)
    expect(out.endsWith('…')).toBe(true)
    expect(Array.from(out).length).toBeLessThanOrEqual(30)
    expect(out).toBe('Bishops gather in Abuja for…')
    // A single long word is cut, not dropped.
    expect(clampText('a'.repeat(50), 10)).toBe(`${'a'.repeat(9)}…`)
  })

  it('formats dates in Africa/Lagos (UTC+1), so 23:30 UTC is already the next day', () => {
    expect(formatLagosDate('2026-10-29T23:30:00Z')).toBe('30 October 2026')
    expect(formatLagosDate('2026-10-29T22:59:00Z')).toBe('29 October 2026')
    expect(formatLagosDate('not a date')).toBe('')
    expect(formatLagosDate(null)).toBe('')
  })

  it('finds the bundled font', () => {
    expect(resolveFontFile()).toMatch(/Newsreader-opsz-wght\.ttf$/)
  })
})

describe('renderShareCard', () => {
  it('renders a 1200x630 PNG', async () => {
    const png = await renderShareCard({ title: 'Church leaders meet in Abuja', label: 'Church & State', date: '2026-10-30T09:00:00Z' })
    expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true)
    const meta = await sharp(png).metadata()
    expect([meta.width, meta.height]).toEqual([OG_WIDTH, OG_HEIGHT])
  })

  it('is deterministic for the same input', async () => {
    const input = { title: 'Same input, same pixels', label: 'News', date: '2026-10-30T09:00:00Z' }
    const [a, b] = [await renderShareCard(input), await renderShareCard(input)]
    expect(a.equals(b)).toBe(true)
  })

  it('renders Yoruba and Igbo diacritics without throwing', async () => {
    const png = await renderShareCard({ title: 'Ọbá \u1eb9 ọ ṣ ụ ń: Ìbàdàn ọ̀rọ̀ and Ụmụahịa', label: 'Ẹ̀sìn', date: null })
    expect((await sharp(png).metadata()).width).toBe(OG_WIDTH)
  })

  it('treats markup in CMS text as plain text (no injection, no parse failure)', async () => {
    const hostile = [
      '<span foreground="red" size="99999">x</span>',
      'Unclosed <b tag & stray ampersand &amp; entity',
      '</span><span font="Sans 400">',
      "Quote ' and \" marks",
    ]
    for (const title of hostile) {
      const png = await renderShareCard({ title, label: title, date: null })
      expect((await sharp(png).metadata()).height).toBe(OG_HEIGHT)
    }
  })

  it('keeps a very long headline inside the card and falls back to the site name for an empty one', async () => {
    const long = await renderShareCard({ title: 'word '.repeat(200), label: 'x'.repeat(300), date: '2026-01-01' })
    const meta = await sharp(long).metadata()
    expect([meta.width, meta.height]).toEqual([OG_WIDTH, OG_HEIGHT])
    const empty = await renderShareCard({ title: '   ', label: null, date: null })
    expect((await sharp(empty).metadata()).width).toBe(OG_WIDTH)
  })
})

describe('renderBriefCard', () => {
  it('renders a 1080x1080 PNG with up to five headlines', async () => {
    const png = await renderBriefCard({
      date: '2026-10-30',
      headlines: ['One', 'Two <b>', 'Three & four', 'Ọ̀rọ̀ \u1eb9', 'Five', 'Six is dropped'],
      footer: 'churchtimesnigeria.net',
    })
    const meta = await sharp(png).metadata()
    expect([meta.width, meta.height]).toEqual([BRIEF_SIZE, BRIEF_SIZE])
  })

  it('renders with no headlines and long headlines', async () => {
    expect((await sharp(await renderBriefCard({ date: '2026-10-30', headlines: [] })).metadata()).width).toBe(BRIEF_SIZE)
    const long = await renderBriefCard({ date: '2026-10-30', headlines: Array(5).fill('very long headline '.repeat(20)) })
    expect((await sharp(long).metadata()).height).toBe(BRIEF_SIZE)
  })
})
