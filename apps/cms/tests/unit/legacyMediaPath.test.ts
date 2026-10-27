import { describe, expect, it } from 'vitest'

import { altFallback, candidatePaths, isValidLegacyPath, legacyPathFromUrl, resolveAlt, stripSizeSuffix } from '../../src/lib/legacyMediaPath'

describe('legacyPathFromUrl', () => {
  it('returns the path after /wp-content/uploads/', () => {
    expect(legacyPathFromUrl('https://old.example.test/wp-content/uploads/2023/10/photo.jpg')).toBe('2023/10/photo.jpg')
    expect(legacyPathFromUrl('http://www.old.example.test/wp-content/uploads/2023/10/photo-300x200.jpg')).toBe('2023/10/photo-300x200.jpg')
    expect(legacyPathFromUrl('/wp-content/uploads/2019/01/a.png')).toBe('2019/01/a.png')
    expect(legacyPathFromUrl('//old.example.test/wp-content/uploads/a.png')).toBe('a.png')
  })

  it('drops the query and fragment, collapses slashes and decodes percent escapes once', () => {
    expect(legacyPathFromUrl('https://old.example.test/wp-content/uploads/2023//10/photo.jpg?ver=2#top')).toBe('2023/10/photo.jpg')
    expect(legacyPathFromUrl('https://old.example.test/wp-content/uploads/2023/10/my%20photo.jpg')).toBe('2023/10/my photo.jpg')
    expect(legacyPathFromUrl('https://old.example.test/WP-Content/Uploads/2023/Photo.JPG')).toBe('2023/Photo.JPG')
  })

  it('returns null for other URLs, empty remainders and unsafe paths', () => {
    expect(legacyPathFromUrl('https://old.example.test/about/')).toBeNull()
    expect(legacyPathFromUrl('https://old.example.test/wp-content/uploads/')).toBeNull()
    expect(legacyPathFromUrl('https://old.example.test/wp-content/uploads/../../etc/passwd')).toBeNull()
    expect(legacyPathFromUrl('https://old.example.test/wp-content/uploads/%2e%2e/x.jpg')).toBeNull()
    expect(legacyPathFromUrl('https://old.example.test/wp-content/uploads/a%5Cb.jpg')).toBeNull()
    expect(legacyPathFromUrl('https://old.example.test/wp-content/uploads/a%00b.jpg')).toBeNull()
    expect(legacyPathFromUrl('')).toBeNull()
    expect(legacyPathFromUrl(undefined)).toBeNull()
    expect(legacyPathFromUrl(42)).toBeNull()
    expect(legacyPathFromUrl(`/wp-content/uploads/${'a/'.repeat(300)}x.jpg`)).toBeNull()
  })
})

describe('stripSizeSuffix', () => {
  it('removes a WordPress size suffix before the extension', () => {
    expect(stripSizeSuffix('2023/10/photo-300x200.jpg')).toBe('2023/10/photo.jpg')
    expect(stripSizeSuffix('photo-1024x768.webp')).toBe('photo.webp')
    expect(stripSizeSuffix('2023/10/my-photo-150x150.PNG')).toBe('2023/10/my-photo.PNG')
  })

  it('removes only the final suffix', () => {
    expect(stripSizeSuffix('a-1920x1080-300x200.jpg')).toBe('a-1920x1080.jpg')
  })

  it('never touches names that merely contain digits or an x', () => {
    for (const keep of [
      'photo-2020.jpg',
      '2020/05/photo-2020.jpg',
      'photo-300.jpg',
      '300x200.jpg',
      '-300x200.jpg',
      'photo-300x200',
      'photo-300x200.jpg.bak.txt',
      'photo-300x200x5.jpg',
      'photo-x200.jpg',
      'photo300x200.jpg',
      '2023-300x200/photo.jpg',
    ]) {
      expect(stripSizeSuffix(keep), keep).toBe(keep)
    }
  })
})

describe('candidatePaths', () => {
  it('lists the exact path first, then the path without a size suffix', () => {
    expect(candidatePaths('2023/10/banner-1920x1080.jpg')).toEqual(['2023/10/banner-1920x1080.jpg', '2023/10/banner.jpg'])
    expect(candidatePaths('2023/10/photo-300x200.jpg')).toEqual(['2023/10/photo-300x200.jpg', '2023/10/photo.jpg'])
  })

  it('has a single entry when there is no suffix to strip', () => {
    expect(candidatePaths('2023/10/photo.jpg')).toEqual(['2023/10/photo.jpg'])
    expect(candidatePaths('photo-2020.jpg')).toEqual(['photo-2020.jpg'])
  })
})

describe('isValidLegacyPath', () => {
  it('accepts normalised relative paths only', () => {
    expect(isValidLegacyPath('2023/10/photo.jpg')).toBe(true)
    expect(isValidLegacyPath('photo.jpg')).toBe(true)
    for (const bad of ['', '/2023/photo.jpg', '2023//photo.jpg', '../x.jpg', 'a/../b.jpg', 'a?b.jpg', 'wp-content/uploads/a.jpg', 5, null]) {
      expect(isValidLegacyPath(bad), String(bad)).toBe(false)
    }
  })
})

describe('altFallback / resolveAlt', () => {
  it('uses the alt when present, trimmed', () => {
    expect(altFallback({ alt: '  A choir  singing ', caption: 'cap', articleTitle: 'T' })).toBe('A choir singing')
    expect(resolveAlt({ alt: 'x' }).source).toBe('alt')
  })

  it('falls back to the caption, then to "<title> photo"', () => {
    expect(altFallback({ alt: '   ', caption: 'The bishop speaks', articleTitle: 'T' })).toBe('The bishop speaks')
    expect(resolveAlt({ alt: '', caption: 'c' }).source).toBe('caption')
    expect(altFallback({ alt: '', caption: '', articleTitle: 'Harvest festival' })).toBe('Harvest festival photo')
    expect(resolveAlt({ articleTitle: 'Harvest festival' }).source).toBe('title')
    expect(altFallback({ alt: null, caption: undefined, articleTitle: undefined })).toBe('Photo')
  })

  it('trims to 300 characters', () => {
    expect(altFallback({ alt: 'a'.repeat(400) })).toHaveLength(300)
    expect(altFallback({ caption: 'b'.repeat(400) })).toHaveLength(300)
    expect(altFallback({ articleTitle: 'c'.repeat(400) })).toHaveLength(300)
  })
})
