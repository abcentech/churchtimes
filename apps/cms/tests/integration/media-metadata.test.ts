import fs from 'node:fs'
import path from 'node:path'

import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { api, newRunId, setupFixtures, type Fixtures } from './helpers'

/**
 * M2: uploaded originals are re-encoded so the stored (and publicly served) file carries no EXIF / GPS,
 * orientation is applied to the pixels, and the dimension checks see the processed image.
 */
const runId = newRunId()
let f: Fixtures

beforeAll(async () => {
  f = await setupFixtures(runId)
})
afterAll(async () => {
  await f?.cleanup()
})

/** True when the JPEG has an APP1 "Exif" segment. */
function hasExifSegment(buf: Buffer): boolean {
  let i = 2
  while (i + 4 < buf.length && buf[i] === 0xff) {
    const marker = buf[i + 1]
    if (marker === 0xda) return false
    const len = buf.readUInt16BE(i + 2)
    if (marker === 0xe1 && buf.subarray(i + 4, i + 10).toString('latin1') === 'Exif\0\0') return true
    i += 2 + len
  }
  return false
}

async function upload(buf: Buffer, name: string, mime: string) {
  const fd = new FormData()
  fd.set('_payload', JSON.stringify({ alt: `${runId} metadata` }))
  fd.set('file', new Blob([new Uint8Array(buf)], { type: mime }), name)
  const res = await api('POST', '/api/media', { token: f.tokens.reporter, body: fd })
  expect(res.status).toBe(201)
  f.created.media.push(res.json.doc.id)
  const row = (await f.payload.findByID({ collection: 'media', id: res.json.doc.id, depth: 0, overrideAccess: true })) as unknown as {
    filename: string
    width: number
    height: number
    filesize: number
  }
  const dir = (f.payload.collections.media.config.upload as { staticDir: string }).staticDir
  return { row, stored: fs.readFileSync(path.resolve(dir, row.filename)) }
}

const gpsExif = {
  IFD0: { Make: 'SecretCam', Orientation: '1' },
  IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '51/1 30/1 0/1', GPSLongitudeRef: 'W', GPSLongitude: '0/1 7/1 0/1' },
}

describe('upload metadata stripping', () => {
  it('removes EXIF / GPS from a stored JPEG original and keeps its dimensions', async () => {
    const src = await sharp({ create: { width: 900, height: 500, channels: 3, background: { r: 200, g: 40, b: 40 } } })
      .jpeg()
      .withExif(gpsExif)
      .toBuffer()
    expect(hasExifSegment(src)).toBe(true) // the fixture really carries EXIF
    expect(src.includes(Buffer.from('SecretCam'))).toBe(true)

    const { row, stored } = await upload(src, `${runId}-gps.jpg`, 'image/jpeg')
    expect(hasExifSegment(stored)).toBe(false)
    expect(stored.includes(Buffer.from('SecretCam'))).toBe(false)
    const meta = await sharp(stored).metadata()
    expect(meta.exif).toBeUndefined()
    expect([meta.width, meta.height]).toEqual([900, 500])
    expect([row.width, row.height]).toEqual([900, 500]) // dimension checks read the processed image
    expect(row.filesize).toBe(stored.length)
  })

  it('applies EXIF orientation to the pixels before dropping the tag', async () => {
    const src = await sharp({ create: { width: 800, height: 400, channels: 3, background: { r: 10, g: 10, b: 200 } } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer()
    expect((await sharp(src).metadata()).orientation).toBe(6) // fixture sanity
    const { row, stored } = await upload(src, `${runId}-rot.jpg`, 'image/jpeg')
    expect(hasExifSegment(stored)).toBe(false)
    expect([row.width, row.height]).toEqual([400, 800]) // displayed orientation preserved
  })

  it('strips metadata from PNG and WebP too', async () => {
    const png = await sharp({ create: { width: 700, height: 300, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .png()
      .withExif(gpsExif)
      .toBuffer()
    const a = await upload(png, `${runId}-m.png`, 'image/png')
    expect((await sharp(a.stored).metadata()).exif).toBeUndefined()
    expect([a.row.width, a.row.height]).toEqual([700, 300])

    const webp = await sharp({ create: { width: 700, height: 300, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .webp()
      .withExif(gpsExif)
      .toBuffer()
    const b = await upload(webp, `${runId}-m.webp`, 'image/webp')
    expect((await sharp(b.stored).metadata()).exif).toBeUndefined()
    expect([b.row.width, b.row.height]).toEqual([700, 300])
  })

  it('refuses an image above the 40 megapixel decode cap', async () => {
    const big = await sharp({ create: { width: 8000, height: 5200, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png({ compressionLevel: 9 }).toBuffer()
    const fd = new FormData()
    fd.set('_payload', JSON.stringify({ alt: `${runId} big` }))
    fd.set('file', new Blob([new Uint8Array(big)], { type: 'image/png' }), `${runId}-big.png`)
    const res = await api('POST', '/api/media', { token: f.tokens.reporter, body: fd })
    expect(res.status).toBe(400)
  })
})
