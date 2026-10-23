import { describe, expect, it } from 'vitest'

import { htmlToLexical } from '../../src/import/htmlToLexical'
import {
  AV_MIME,
  avSourceHosts,
  avKindFromPath,
  avMaxBytes,
  isSafeAvSourceUrl,
  isSafeAvUrl,
  mimeAllowedForKind,
  sniffAvMimes,
} from '../../src/lib/avMedia'
import { collectAvBlocks, collectAvMedia, findEmbedProblem } from '../../src/lib/lexicalEmbeds'
import { type N, assertValidBody, baseOptions } from './htmlToLexical.helpers'

// Legacy source addresses must be https on an allowed host (isSafeAvSourceUrl): the fixtures use these.
process.env.LEGACY_SITE_HOSTS = 'old.example.test,cdn.old.example.test'

/** `clip-5.mp4` resolves to media 5 (any extension); anything else does not resolve. */
const resolveMedia = (src: string) => {
  const m = /clip-(\d+)\./.exec(src)
  return m ? { mediaId: Number(m[1]) } : null
}
const opts = () => baseOptions({ resolveMedia })

const blocksOf = (root: N, slug = 'audioVideo'): N[] => {
  const found: N[] = []
  const walk = (n: any) => {
    if (n && typeof n === 'object') {
      if (n.type === 'block' && n.fields?.blockType === slug) found.push(n)
      for (const v of Object.values(n)) walk(v)
    }
  }
  walk(root)
  return found
}

const convert = (html: string, o = opts()) => {
  const r = htmlToLexical(html, o)
  assertValidBody(r.content)
  return r
}

describe('avMedia helpers', () => {
  it('maps extensions to kinds and refuses unsupported types', () => {
    expect(avKindFromPath('/wp-content/uploads/2023/a.MP4?x=1')).toBe('video')
    expect(avKindFromPath('a.webm')).toBe('video')
    expect(avKindFromPath('a.mp3')).toBe('audio')
    expect(avKindFromPath('a.m4a')).toBe('audio')
    expect(avKindFromPath('a.ogg')).toBe('audio')
    for (const bad of ['a.svg', 'a.html', 'a.mov', 'a.wav', 'a.m3u8', 'a', 'https://x.test/dir.mp4/page', '']) {
      expect(avKindFromPath(bad)).toBeNull()
    }
  })

  it('allows only the five documented mime types, per kind', () => {
    expect([...AV_MIME].sort()).toEqual(['audio/mp4', 'audio/mpeg', 'audio/ogg', 'video/mp4', 'video/webm'])
    expect(mimeAllowedForKind('video', 'video/mp4')).toBe(true)
    expect(mimeAllowedForKind('video', 'audio/mpeg')).toBe(false)
    expect(mimeAllowedForKind('audio', 'audio/ogg')).toBe(true)
    expect(mimeAllowedForKind('audio', 'video/webm')).toBe(false)
    expect(mimeAllowedForKind('audio', 'image/svg+xml')).toBe(false)
    expect(mimeAllowedForKind('video', 'text/html')).toBe(false)
  })

  it('sniffs magic bytes', () => {
    const bytes = (...b: number[]) => new Uint8Array([...b, ...new Array(64).fill(0)])
    const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0))
    expect(sniffAvMimes(bytes(0, 0, 0, 24, ...ascii('ftypisom')))).toEqual(['video/mp4', 'audio/mp4'])
    expect(sniffAvMimes(bytes(0, 0, 0, 24, ...ascii('ftypM4A ')))).toEqual(['audio/mp4'])
    expect(sniffAvMimes(bytes(0x1a, 0x45, 0xdf, 0xa3, ...ascii('webm')))).toEqual(['video/webm'])
    expect(sniffAvMimes(bytes(0x1a, 0x45, 0xdf, 0xa3, ...ascii('matroska')))).toEqual([])
    expect(sniffAvMimes(bytes(...ascii('ID3')))).toEqual(['audio/mpeg'])
    expect(sniffAvMimes(bytes(0xff, 0xfb))).toEqual(['audio/mpeg'])
    expect(sniffAvMimes(bytes(...ascii('OggS')))).toEqual(['audio/ogg'])
    expect(sniffAvMimes(bytes(...ascii('<svg xmlns=')))).toEqual([])
    expect(sniffAvMimes(bytes(...ascii('<script>')))).toEqual([])
    expect(sniffAvMimes(new Uint8Array(0))).toEqual([])
  })

  it('reads the size cap from MEDIA_AV_MAX_MB with a default and a ceiling', () => {
    expect(avMaxBytes({})).toBe(100 * 1024 * 1024)
    expect(avMaxBytes({ MEDIA_AV_MAX_MB: '20' })).toBe(20 * 1024 * 1024)
    expect(avMaxBytes({ MEDIA_AV_MAX_MB: '99999' })).toBe(500 * 1024 * 1024)
    expect(avMaxBytes({ MEDIA_AV_MAX_MB: 'abc' })).toBe(100 * 1024 * 1024)
    expect(avMaxBytes({ MEDIA_AV_MAX_MB: '0' })).toBe(100 * 1024 * 1024)
  })

  it('accepts only http(s) and root-relative source addresses', () => {
    expect(isSafeAvUrl('https://old.example.test/wp-content/uploads/a.mp4')).toBe(true)
    expect(isSafeAvUrl('http://old.example.test/a.mp3')).toBe(true)
    expect(isSafeAvUrl('/wp-content/uploads/a.mp4')).toBe(true)
    for (const bad of ['javascript:alert(1)', 'data:video/mp4;base64,AAAA', 'file:///etc/passwd', '//evil.test/a.mp4', 'https://u:p@x.test/a.mp4', 'https://x.test/a b.mp4', '', 'a.mp4', 'https://x.test/<a>']) {
      expect(isSafeAvUrl(bad)).toBe(false)
    }
  })
})

describe('isSafeAvSourceUrl (legacy source address)', () => {
  const hosts = ['old.example.test', 'cms.example.test']
  it('accepts https on an allowed host and /wp-content/uploads/ paths only', () => {
    expect(isSafeAvSourceUrl('https://old.example.test/wp-content/uploads/a.mp4', hosts)).toBe(true)
    expect(isSafeAvSourceUrl('https://OLD.example.test/a.mp3', hosts)).toBe(true)
    expect(isSafeAvSourceUrl('/wp-content/uploads/2020/05/a.mp4', hosts)).toBe(true)
  })
  it('refuses plain http, other hosts, other paths, traversal and unsafe forms', () => {
    for (const bad of [
      'http://old.example.test/a.mp3',
      'https://evil.example.test/a.mp3',
      'https://old.example.test.evil.test/a.mp3',
      '/api/users/me',
      '/admin',
      '/wp-content/uploads/../../etc/passwd',
      '/wp-content/uploads/%2e%2e/%2e%2e/etc/passwd',
      '/wp-content/uploads/a%2fb.mp4',
      String.raw`/wp-content/uploads/..\x.mp4`,
      '//old.example.test/a.mp3',
      'javascript:alert(1)',
      'https://u:p@old.example.test/a.mp4',
      '',
    ]) {
      expect(isSafeAvSourceUrl(bad, hosts), bad).toBe(false)
    }
  })
  it('the default host list follows LEGACY_SITE_HOSTS and CMS_PUBLIC_URL', () => {
    const env = { LEGACY_SITE_HOSTS: 'legacy.example.test', CMS_PUBLIC_URL: 'https://cms.example.test' }
    const list = avSourceHosts(env)
    expect(list).toEqual(expect.arrayContaining(['legacy.example.test', 'cms.example.test', 'www.legacy.example.test', 'churchtimesnigeria.net']))
    expect(avSourceHosts({})).not.toContain('legacy.example.test')
  })
})

describe('findEmbedProblem: audioVideo block', () => {
  const block = (fields: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    root: { type: 'root', children: [{ type: 'block', version: 2, format: '', ...extra, fields: { blockType: 'audioVideo', id: 'x', kind: 'video', title: 'T', media: 3, ...fields } }] },
  })

  it('accepts a media block, a legacy-url block and a populated media object', () => {
    expect(findEmbedProblem(block({}))).toBeNull()
    expect(findEmbedProblem(block({ media: undefined, sourceUrl: 'https://old.example.test/a.mp4' }))).toBeNull()
    expect(findEmbedProblem(block({ media: { id: 4, url: '/x' }, poster: { id: 5 }, caption: 'c', transcriptUrl: '/t/', duration: 12.5 }))).toBeNull()
  })

  it('refuses malformed blocks', () => {
    expect(findEmbedProblem(block({ kind: 'film' }))).toMatch(/kind/)
    expect(findEmbedProblem(block({ media: undefined }))).toMatch(/media file or a source/)
    expect(findEmbedProblem(block({ media: 0 }))).toMatch(/invalid media id/)
    expect(findEmbedProblem(block({ media: '3' }))).toMatch(/invalid media id/)
    expect(findEmbedProblem(block({ poster: 99999999999 }))).toMatch(/invalid poster id/)
    expect(findEmbedProblem(block({ media: undefined, sourceUrl: 'javascript:alert(1)' }))).toMatch(/source/)
    expect(findEmbedProblem(block({ transcriptUrl: 'data:text/html,x' }))).toMatch(/transcript/)
    expect(findEmbedProblem(block({ title: '' }))).toMatch(/title/)
    expect(findEmbedProblem(block({ title: '<b>x</b>' }))).toMatch(/plain text/)
    expect(findEmbedProblem(block({ caption: 'x'.repeat(501) }))).toMatch(/at most 500/)
    expect(findEmbedProblem(block({ duration: -1 }))).toMatch(/duration/)
    expect(findEmbedProblem(block({ html: '<video>' }))).toMatch(/unexpected fields/)
    expect(findEmbedProblem(block({}, { children: [{ type: 'text', text: 'x' }] }))).toMatch(/children/)
    expect(findEmbedProblem(block({}, { src: 'https://x.test/a.mp4' }))).toMatch(/children or URL/)
  })

  it('still refuses every other embed', () => {
    expect(findEmbedProblem({ root: { type: 'root', children: [{ type: 'video', src: 'x' }] } })).not.toBeNull()
    expect(findEmbedProblem({ root: { type: 'root', children: [{ type: 'block', fields: { blockType: 'vimeo' } }] } })).not.toBeNull()
    expect(findEmbedProblem({ root: { type: 'root', children: [{ type: 'inlineBlock', fields: { blockType: 'audioVideo', kind: 'audio', title: 'T', media: 1 } }] } })).not.toBeNull()
  })

  it('collects the media and poster ids', () => {
    const body = { root: { type: 'root', children: [
      { type: 'block', fields: { blockType: 'audioVideo', kind: 'video', title: 'a', media: 3, poster: 8 } },
      { type: 'block', fields: { blockType: 'audioVideo', kind: 'audio', title: 'b', media: { id: 3 } } },
      { type: 'block', fields: { blockType: 'audioVideo', kind: 'audio', title: 'c', sourceUrl: '/x.mp3' } },
    ] } }
    expect(collectAvBlocks(body)).toEqual([
      { kind: 'video', media: 3, poster: 8 },
      { kind: 'audio', media: 3 },
      { kind: 'audio' },
    ])
    expect(collectAvMedia(body)).toEqual({ media: [3], poster: [8] })
  })
})

describe('htmlToLexical: audio and video', () => {
  it('converts <video> with <source> children, a poster and a figcaption', () => {
    const r = convert(
      '<figure class="wp-block-video"><video controls poster="https://old.example.test/wp-content/uploads/img-9.jpg"><source src="https://old.example.test/wp-content/uploads/2023/clip-5.webm" type="video/webm"><source src="https://old.example.test/wp-content/uploads/2023/clip-5.mp4" type="video/mp4"></video><figcaption>Choir rehearsal</figcaption></figure>',
    )
    const [b] = blocksOf(r.root)
    expect(blocksOf(r.root)).toHaveLength(1)
    expect(b.fields).toMatchObject({ blockType: 'audioVideo', kind: 'video', media: 5, poster: 9, caption: 'Choir rehearsal', title: 'Choir rehearsal' })
    expect(b.fields.sourceUrl).toBeUndefined()
    expect(r.report.audioVideo).toEqual({ resolved: 1, unresolvedMedia: 0, unsupported: 0 })
    // the caption became the block caption, not a stray paragraph
    expect(JSON.stringify(r.root)).not.toContain('"text":"Choir rehearsal"')
  })

  it('converts <audio src> and a bare <audio><source>', () => {
    const r = convert('<p>Listen:</p><audio controls src="/wp-content/uploads/clip-2.mp3"></audio><audio><source src="/wp-content/uploads/clip-3.ogg"></audio>')
    const bs = blocksOf(r.root)
    expect(bs.map((b) => [b.fields.kind, b.fields.media])).toEqual([['audio', 2], ['audio', 3]])
    expect(bs[0].fields.title).toBe('A synthetic article')
  })

  it('maps [fvplayer], [video] and [audio] shortcodes (attributes in any quoting)', () => {
    const r = convert(
      '<p>One [fvplayer src="https://old.example.test/wp-content/uploads/clip-1.mp4" splash="https://old.example.test/wp-content/uploads/img-4.jpg" caption="Opening hymn"] two</p>' +
        "<p>[video mp4='/wp-content/uploads/clip-6.mp4' poster=/wp-content/uploads/img-7.png]</p>" +
        '<p>[audio src="/wp-content/uploads/clip-8.mp3"][/audio]</p>',
    )
    const bs = blocksOf(r.root)
    expect(bs.map((b) => [b.fields.kind, b.fields.media, b.fields.poster ?? null])).toEqual([
      ['video', 1, 4],
      ['video', 6, 7],
      ['audio', 8, null],
    ])
    expect(bs[0].fields.caption).toBe('Opening hymn')
    expect(r.report.shortcodesRemoved).toMatchObject({ fvplayer: 1, video: 1, audio: 1 })
    expect(JSON.stringify(r.root)).not.toContain('[fvplayer')
    expect(JSON.stringify(r.root)).toContain('"text":"One"')
  })

  it('keeps an unresolved file as a block with the legacy address and counts unresolved-media (no values)', () => {
    const r = convert('<p>[fvplayer src="https://old.example.test/wp-content/uploads/2020/missing.mp4"]</p><video src="//cdn.old.example.test/gone.webm"></video>')
    const bs = blocksOf(r.root)
    expect(bs).toHaveLength(2)
    expect(bs[0].fields.sourceUrl).toBe('https://old.example.test/wp-content/uploads/2020/missing.mp4')
    expect(bs[0].fields.media).toBeUndefined()
    expect(bs[1].fields.sourceUrl).toBe('https://cdn.old.example.test/gone.webm')
    expect(r.report.audioVideo).toEqual({ resolved: 0, unresolvedMedia: 2, unsupported: 0 })
    // counts only: the report object holds no address for these
    expect(JSON.stringify(r.report)).not.toContain('missing.mp4')
  })

  it('counts every file unresolved when no resolveMedia is given', () => {
    const r = convert('<video src="/wp-content/uploads/clip-5.mp4"></video>', baseOptions())
    expect(r.report.audioVideo.unresolvedMedia).toBe(1)
    expect(blocksOf(r.root)[0].fields.sourceUrl).toBe('/wp-content/uploads/clip-5.mp4')
  })

  it('leaves YouTube working and sends other players to a link, counted as unsupported', () => {
    const r = convert(
      '<p>[fvplayer src="https://www.youtube.com/watch?v=dQw4w9WgXcQ"]</p><p>[fvplayer src="https://vimeo.com/12345"]</p><video src="https://x.test/film.mov"></video><p>[video src="javascript:alert(1)"]</p>',
    )
    expect(blocksOf(r.root, 'youtubeEmbed')).toHaveLength(1)
    expect(blocksOf(r.root)).toHaveLength(0)
    expect(r.report.audioVideo.unsupported).toBe(3)
    expect(r.report.embeds.linked.map((l) => l.url)).toEqual(['https://vimeo.com/12345', 'https://x.test/film.mov'])
    expect(r.report.embeds.dropped).toHaveLength(1)
  })

  it('never carries scripts, event handlers or svg through a video element', () => {
    const r = convert('<video src="/wp-content/uploads/clip-5.mp4" onerror="alert(1)" poster="javascript:alert(1)"><script>alert(1)</script><track src="x.vtt"></video><svg><script>1</script></svg>')
    const json = JSON.stringify(r.root)
    expect(json).not.toMatch(/onerror|javascript:|<script|alert/)
    expect(blocksOf(r.root)[0].fields.poster).toBeUndefined()
  })

  it('writes the same block ids on a second run (idempotent)', () => {
    const html = '<video src="/wp-content/uploads/clip-5.mp4"></video><audio src="/wp-content/uploads/clip-2.mp3"></audio>'
    expect(JSON.stringify(convert(html).content)).toBe(JSON.stringify(convert(html).content))
  })

  it('drops a video element with no address and reports it', () => {
    const r = convert('<p>x</p><video controls></video>')
    expect(blocksOf(r.root)).toHaveLength(0)
    expect(r.report.droppedElements).toMatchObject({ video: 1 })
  })
})
