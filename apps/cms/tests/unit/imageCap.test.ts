import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

import { MAX_INPUT_PIXELS, stripImageMetadata } from '../../src/collections/Media'
import { IMAGE_DEFAULT_MAX_MB, MAX_IMAGE_BYTES, imageMaxBytes } from '../../src/lib/mediaLimits'

const MB = 1024 * 1024

describe('imageMaxBytes (MEDIA_IMAGE_MAX_MB)', () => {
  it('defaults to 25 MB and the shared constant follows it', () => {
    expect(IMAGE_DEFAULT_MAX_MB).toBe(25)
    expect(imageMaxBytes({})).toBe(25 * MB)
    expect(MAX_IMAGE_BYTES).toBe(imageMaxBytes(process.env))
  })
  it('accepts whole MB from 1 to 50, clamps above, falls back to the default for junk or below 1', () => {
    expect(imageMaxBytes({ MEDIA_IMAGE_MAX_MB: '1' })).toBe(1 * MB)
    expect(imageMaxBytes({ MEDIA_IMAGE_MAX_MB: '40' })).toBe(40 * MB)
    expect(imageMaxBytes({ MEDIA_IMAGE_MAX_MB: '50' })).toBe(50 * MB)
    expect(imageMaxBytes({ MEDIA_IMAGE_MAX_MB: '999' })).toBe(50 * MB)
    expect(imageMaxBytes({ MEDIA_IMAGE_MAX_MB: '12.9' })).toBe(12 * MB)
    for (const bad of ['', 'abc', '0', '-3', '0.5']) expect(imageMaxBytes({ MEDIA_IMAGE_MAX_MB: bad }), bad).toBe(25 * MB)
  })
})

describe('a ~23 MB / 40 MP image (cap 25 MB) is processed within a sane memory budget', () => {
  it('re-saves a ~40 megapixel, ~23 MB JPEG and reports the peak RSS', async () => {
    const side = 6324 // 6324 x 6324 = 39.99 MP, just inside the 40 MP limit
    expect(side * side).toBeLessThanOrEqual(MAX_INPUT_PIXELS)
    // Smooth gradient plus mild noise, so the JPEG is large but realistic; quality is tuned to land near 25 MB.
    const raw = Buffer.alloc(side * side * 3)
    let seed = 12345
    for (let i = 0; i < raw.length; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0
      const x = (i / 3) % side
      raw[i] = ((x / side) * 200 + ((seed >>> 24) % 56)) & 255
    }
    const original = await sharp(raw, { raw: { width: side, height: side, channels: 3 } })
      .jpeg({ quality: 85, chromaSubsampling: "4:4:4" })
      .toBuffer()
    raw.fill(0)
    const mb = original.length / MB
    // eslint-disable-next-line no-console
    console.log(`[image-cap] input ${side}x${side} (${(side * side / 1e6).toFixed(1)} MP), ${mb.toFixed(1)} MB`)
    expect(original.length).toBeLessThanOrEqual(MAX_IMAGE_BYTES)
    expect(mb).toBeGreaterThan(20) // a large archive original, well above the old 10 MB cap

    let peak = process.memoryUsage().rss
    const timer = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss)
    }, 25)
    const before = process.memoryUsage().rss
    let out: Buffer
    try {
      out = await stripImageMetadata(original, 'image/jpeg')
    } finally {
      clearInterval(timer)
    }
    peak = Math.max(peak, process.memoryUsage().rss)
    const meta = await sharp(out).metadata()
    expect(meta.width).toBe(side)
    expect(meta.height).toBe(side)
    // eslint-disable-next-line no-console
    console.log(
      `[image-cap] output ${(out.length / MB).toFixed(1)} MB; rss before ${(before / MB).toFixed(0)} MB, peak ${(peak / MB).toFixed(0)} MB, ` +
        `process maxRSS ${(process.resourceUsage().maxRSS / 1024).toFixed(0)} MB`,
    )
    // 40 MP decoded is 120 MB (RGB) / 160 MB (RGBA); a budget of 1.5 GB total RSS leaves a wide margin on a small VPS.
    expect(peak).toBeLessThan(1536 * MB)
  }, 180_000)

  it('still refuses an image over 40 megapixels', async () => {
    const big = await sharp({ create: { width: 6400, height: 6400, channels: 3, background: '#888' } }).jpeg({ quality: 40 }).toBuffer()
    await expect(stripImageMetadata(big, 'image/jpeg')).rejects.toThrow()
  }, 60_000)
})
