import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { convertWxrStats, formatConvertStats, lexicalTextLength, sourceTextLength } from '../../src/import/convertStats'
import { readWxrFile } from '../../src/import/wxr'
import { wxr, type FixtureItem } from '../fixtures/wxr/generate'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wxr-convstats-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

const run = async (items: FixtureItem[], name: string) => {
  const file = path.join(dir, name)
  fs.writeFileSync(file, wxr(items))
  return convertWxrStats(() => readWxrFile(file))
}

const YT = 'https://www.youtube.com/watch?v=abcdefghijk'

describe('convertWxrStats (rehearsal against a real export)', () => {
  it('counts shortcodes, images, tables, embeds and unknown blocks, skipping drafts and password posts', async () => {
    const { stats } = await run(
      [
        { id: 1, content: '<p>Hello world, this is a story.</p>[video mp4="https://old.test/a.mp4"][caption]<img src="https://old.test/a.png" alt="x">[/caption]' },
        { id: 2, content: '<table><tr><td>a</td><td><table><tr><td>b</td></tr></table></td></tr></table>' },
        { id: 3, status: 'draft', content: '<p>draft</p>' },
        { id: 4, password: 'pw', content: '<p>secret</p>' },
        { id: 5, content: '<!-- wp:mystery-block --><div>inside</div><!-- /wp:mystery-block -->' },
        { id: 6, content: `<iframe src="${YT.replace('watch?v=', 'embed/')}"></iframe>` },
      ],
      'a.xml',
    )
    expect(stats.publishedPosts).toBe(5)
    expect(stats.passwordProtectedSkipped).toBe(1)
    expect(stats.converted).toBe(4)
    expect(stats.shortcodesRemovedByTag).toMatchObject({ video: 1, caption: 2 })
    expect(stats.imagesUnresolved).toBe(1)
    expect(stats.tablesFlattened).toBe(1)
    expect(stats.unknownBlocks).toEqual({ 'mystery-block': 1 })
    expect(stats.youtubeBlocks).toBe(1)
    expect(stats.failedByCode).toEqual({})
  })

  it('reports input-too-large by code and writes the legacy id to the detail, never to the printed text', async () => {
    const big = `<p>${'x'.repeat(5 * 1024 * 1024 + 10)}</p>`
    const { stats, detail } = await run([{ id: 77, title: 'Private Headline', content: big }], 'big.xml')
    expect(stats.failedByCode).toEqual({ 'input-too-large': 1 })
    expect(stats.inputOverCapPosts).toBe(1)
    expect(detail.failed).toEqual([{ id: 77, code: 'input-too-large' }])
    expect(formatConvertStats(stats)).not.toContain('Private Headline')
  })

  it('flags a post that loses more than 20% of its text, but not a bare YouTube link turned into an embed', async () => {
    const text = 'Plain words that should survive the conversion unchanged. '.repeat(3)
    const { stats, detail } = await run(
      [
        { id: 10, content: `<p>${text}</p>` },
        { id: 11, content: YT },
        { id: 12, content: `<p>${text}</p><script>alert(1)</script><p>${text}</p>` },
        { id: 13, content: `<p>${text}</p>` },
      ],
      'shrink.xml',
    )
    expect(stats.textShrinkOver20Pct).toBe(0)
    expect(stats.postsWithEmptyOutput).toBe(0)
    expect(detail.textShrink).toEqual([])
  })

  it('measures text the same way on both sides', () => {
    expect(sourceTextLength('<p>a &amp; b</p><!-- c --><script>zzz</script>[caption]d[/caption]')).toBe(4)
    expect(sourceTextLength(`<p>${YT}</p>`)).toBe(0)
    expect(lexicalTextLength({ type: 'root', children: [{ type: 'paragraph', children: [{ type: 'text', text: 'a b' }, { type: 'text', text: 'c ' }] }] })).toBe(3)
  })

  it('prints counts only', async () => {
    const { stats } = await run([{ id: 1, title: 'Secret Title', slug: 'secret-slug', content: '<p>Secret body text for this post, long enough.</p><a href="https://old.test/secret-slug/">Secret link</a>' }], 'c.xml')
    const out = formatConvertStats(stats)
    for (const s of ['Secret Title', 'secret-slug', 'Secret body', 'Secret link', 'old.test']) expect(out).not.toContain(s)
    expect(out).toContain('published posts: 1')
  })
})
