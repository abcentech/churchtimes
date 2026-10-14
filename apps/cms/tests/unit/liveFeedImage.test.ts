import { describe, expect, it } from 'vitest'

import { publicImage } from '../../src/endpoints/liveEventUpdates'

const media = (over: Record<string, unknown> = {}) => ({
  id: 3,
  url: '/api/media/file/photo.jpg',
  filename: 'photo.jpg',
  alt: 'Delegates voting',
  width: 1600,
  height: 900,
  mimeType: 'image/jpeg',
  uploadedBy: 9,
  caption: 'c',
  sizes: { card: { url: '/api/media/file/photo-800.jpg' } },
  ...over,
})

describe('publicImage (live feed projection)', () => {
  it('emits exactly url, alt, width, height, mimeType', () => {
    expect(publicImage(media())).toEqual({
      url: '/api/media/file/photo.jpg',
      alt: 'Delegates voting',
      width: 1600,
      height: 900,
      mimeType: 'image/jpeg',
    })
  })

  it('keeps absolute media URLs (CMS_PUBLIC_URL set) and rejects other paths or schemes', () => {
    expect(publicImage(media({ url: 'https://cms.example.org/api/media/file/photo.jpg' }))?.url).toBe(
      'https://cms.example.org/api/media/file/photo.jpg',
    )
    for (const url of [
      'https://cms.example.org/admin/secret.jpg',
      'javascript:alert(1)',
      'data:image/png;base64,AAAA',
      'https://u:p@cms.example.org/api/media/file/photo.jpg',
      '/api/users/me',
      null,
      '',
    ]) {
      expect(publicImage(media({ url })), String(url)).toBeNull()
    }
  })

  it('returns null for unpopulated ids, non-images and missing alt; nulls bad dimensions', () => {
    expect(publicImage(5)).toBeNull()
    expect(publicImage(null)).toBeNull()
    expect(publicImage(media({ mimeType: 'image/svg+xml' }))).toBeNull()
    expect(publicImage(media({ mimeType: 'application/pdf' }))).toBeNull()
    expect(publicImage(media({ alt: '  ' }))).toBeNull()
    expect(publicImage(media({ alt: null }))).toBeNull()
    expect(publicImage(media({ width: -1, height: 1.5 }))).toMatchObject({ width: null, height: null })
  })
})
