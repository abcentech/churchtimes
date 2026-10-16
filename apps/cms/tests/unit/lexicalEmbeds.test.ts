import { describe, expect, it } from 'vitest'

import {
  EMBED_REFUSED_MESSAGE,
  YOUTUBE_TITLE_MAX,
  collectYoutubeIds,
  findEmbedProblem,
  isYoutubeVideoId,
  validateVideoId,
  validateYoutubeTitle,
} from '../../src/lib/lexicalEmbeds'

const para = (text: string) => ({ type: 'paragraph', children: [{ type: 'text', text }] })
const youtube = (fields: Record<string, unknown>) => ({
  type: 'block',
  version: 2,
  format: '',
  fields: { blockType: 'youtubeEmbed', id: 'b1', ...fields },
})
const body = (...children: unknown[]) => ({ root: { type: 'root', children } })

describe('isYoutubeVideoId / validateVideoId', () => {
  it('accepts exactly 11 characters from [A-Za-z0-9_-]', () => {
    for (const ok of ['dQw4w9WgXcQ', 'aaaaaaaaaaa', 'A-_0aZ9-_zz', '___________', '-----------']) {
      expect(isYoutubeVideoId(ok), ok).toBe(true)
      expect(validateVideoId(ok), ok).toBe(true)
    }
  })

  it('rejects other lengths, other characters and non-strings', () => {
    const bad: unknown[] = [
      '',
      'short',
      'dQw4w9WgXcQ1',
      'dQw4w9WgXc',
      'dQw4w9WgXc!',
      'dQw4w9 gXcQ',
      'dQw4w9WgXc\n',
      'https://youtu.be/dQw4w9WgXcQ',
      'dQw4w9WgXcé',
      undefined,
      null,
      12345678901,
      ['dQw4w9WgXcQ'],
    ]
    for (const v of bad) {
      expect(isYoutubeVideoId(v), String(v)).toBe(false)
      expect(typeof validateVideoId(v)).toBe('string')
    }
  })
})

describe('validateYoutubeTitle', () => {
  it('treats the title as optional plain text up to 120 characters', () => {
    expect(validateYoutubeTitle(undefined)).toBe(true)
    expect(validateYoutubeTitle(null)).toBe(true)
    expect(validateYoutubeTitle('')).toBe(true)
    expect(validateYoutubeTitle('Sunday service, 3 minutes')).toBe(true)
    expect(validateYoutubeTitle('a'.repeat(YOUTUBE_TITLE_MAX))).toBe(true)
    expect(validateYoutubeTitle('a'.repeat(YOUTUBE_TITLE_MAX + 1))).toMatch(/at most 120/)
  })

  it('refuses markup, control characters and non-strings', () => {
    expect(validateYoutubeTitle('<b>x</b>')).toMatch(/plain text/)
    expect(validateYoutubeTitle('a\u0000b')).toMatch(/plain text/)
    expect(validateYoutubeTitle('a\nb')).toMatch(/plain text/)
    expect(validateYoutubeTitle(5)).toMatch(/plain text/)
    expect(validateYoutubeTitle({})).toMatch(/plain text/)
  })
})

describe('findEmbedProblem', () => {
  it('accepts bodies with no embeds, with standard nodes and with valid YouTube blocks', () => {
    expect(findEmbedProblem(undefined)).toBeNull()
    expect(findEmbedProblem(null)).toBeNull()
    expect(findEmbedProblem('not a tree')).toBeNull()
    expect(findEmbedProblem(body(para('Hello')))).toBeNull()
    expect(
      findEmbedProblem(
        body(
          para('One'),
          { type: 'upload', relationTo: 'media', value: 1 },
          { type: 'table', children: [{ type: 'tablerow', children: [{ type: 'tablecell', children: [para('c')] }] }] },
          { type: 'horizontalrule' },
          { type: 'list', children: [{ type: 'listitem', children: [{ type: 'link', fields: { url: '/x' }, children: [] }] }] },
          youtube({ videoId: 'dQw4w9WgXcQ', title: 'A talk' }),
          youtube({ videoId: 'aaaaaaaaaaa' }),
        ),
      ),
    ).toBeNull()
  })

  it('refuses a malformed YouTube block', () => {
    for (const fields of [
      { videoId: 'short' },
      { videoId: 'dQw4w9WgXcQ0' },
      { videoId: '' },
      {},
      { videoId: 42 },
      { videoId: 'https://youtu.be/x' },
    ]) {
      expect(findEmbedProblem(body(youtube(fields))), JSON.stringify(fields)).toMatch(/invalid video id/)
    }
    expect(findEmbedProblem(body(youtube({ videoId: 'dQw4w9WgXcQ', title: '<script>' })))).toMatch(/plain text/)
    expect(findEmbedProblem(body(youtube({ videoId: 'dQw4w9WgXcQ', title: 'x'.repeat(121) })))).toMatch(/at most 120/)
  })

  it('refuses a raw embed node (the importer shape), iframe-like nodes and unknown embeds', () => {
    const refused = [
      { type: 'embed', embedType: 'iframe', url: 'https://evil.example.test/x' },
      { type: 'iframe', src: 'https://evil.example.test/x' },
      { type: 'youtube', videoId: 'dQw4w9WgXcQ' },
      { type: 'video', url: 'https://example.test/v.mp4' },
      { type: 'vimeoEmbed', id: '1' },
      { type: 'oembed', url: 'https://example.test' },
      { type: 'block', fields: { blockType: 'vimeoEmbed', videoId: '123' } },
      { type: 'block', fields: {} },
      { type: 'block' },
      { type: 'inlineBlock', fields: { blockType: 'youtubeEmbed', videoId: 'dQw4w9WgXcQ' } },
    ]
    for (const node of refused) {
      expect(findEmbedProblem(body(node)), JSON.stringify(node)).toBe(EMBED_REFUSED_MESSAGE)
    }
  })

  it('finds embeds nested in lists, quotes and tables, and stops at the first problem', () => {
    const nested = body({
      type: 'list',
      children: [{ type: 'listitem', children: [{ type: 'embed', url: 'https://x.example.test' }] }],
    })
    expect(findEmbedProblem(nested)).toBe(EMBED_REFUSED_MESSAGE)
    const inCell = body({
      type: 'table',
      children: [{ type: 'tablerow', children: [{ type: 'tablecell', children: [{ type: 'iframe' }] }] }],
    })
    expect(findEmbedProblem(inCell)).toBe(EMBED_REFUSED_MESSAGE)
    expect(findEmbedProblem(body({ type: 'embed' }, youtube({ videoId: 'bad' })))).toBe(EMBED_REFUSED_MESSAGE)
  })

  it('is bounded: a pathologically deep tree does not throw', () => {
    let deep: Record<string, unknown> = { type: 'paragraph' }
    for (let i = 0; i < 500; i++) deep = { type: 'quote', children: [deep] }
    expect(() => findEmbedProblem({ root: deep })).not.toThrow()
  })
})

describe('collectYoutubeIds', () => {
  it('lists distinct valid ids in document order', () => {
    expect(
      collectYoutubeIds(
        body(youtube({ videoId: 'dQw4w9WgXcQ' }), para('x'), youtube({ videoId: 'aaaaaaaaaaa' }), youtube({ videoId: 'dQw4w9WgXcQ' }), youtube({ videoId: 'bad' })),
      ),
    ).toEqual(['dQw4w9WgXcQ', 'aaaaaaaaaaa'])
    expect(collectYoutubeIds(undefined)).toEqual([])
  })
})
