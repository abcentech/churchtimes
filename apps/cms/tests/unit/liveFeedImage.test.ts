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

describe('publicImage (800 px card variant)', () => {
  const card = (over: Record<string, unknown> = {}) => ({
    url: '/api/media/file/photo-800x450.jpg',
    width: 800,
    height: 450,
    mimeType: 'image/jpeg',
    filename: 'photo-800x450.jpg',
    ...over,
  })

  it('serves the card variant url, width, height and mimeType; alt stays the media alt', () => {
    expect(publicImage(media({ sizes: { card: card(), hero: card({ url: '/api/media/file/hero.webp', width: 1600 }) } }))).toEqual({
      url: '/api/media/file/photo-800x450.jpg',
      alt: 'Delegates voting',
      width: 800,
      height: 450,
      mimeType: 'image/jpeg',
    })
  })

  it('uses the variant mimeType, not the original one', () => {
    expect(publicImage(media({ mimeType: 'image/png', sizes: { card: card({ mimeType: 'image/webp' }) } }))?.mimeType).toBe('image/webp')
  })

  it('falls back to the original when the variant is missing, empty or unusable', () => {
    const original = { url: '/api/media/file/photo.jpg', width: 1600, height: 900, mimeType: 'image/jpeg' }
    for (const sizes of [
      undefined,
      null,
      {},
      { card: null },
      { card: {} },
      { card: { url: null, width: null, height: null, mimeType: null } },
      { card: card({ url: '/admin/secret.jpg' }) },
      { card: card({ url: 'javascript:alert(1)' }) },
      { card: card({ mimeType: 'image/svg+xml' }) },
      { thumbnail: card() },
    ]) {
      expect(publicImage(media({ sizes })), JSON.stringify(sizes)).toMatchObject(original)
    }
  })

  it('nulls bad variant dimensions but keeps the variant url', () => {
    expect(publicImage(media({ sizes: { card: card({ width: 0, height: 'x' }) } }))).toMatchObject({
      url: '/api/media/file/photo-800x450.jpg',
      width: null,
      height: null,
    })
  })

  it('still refuses media without alt or with a bad original even when a variant exists', () => {
    expect(publicImage(media({ alt: '', sizes: { card: card() } }))).toBeNull()
    expect(publicImage(media({ url: '/api/users/me', sizes: { card: card() } }))).toBeNull()
  })
})
