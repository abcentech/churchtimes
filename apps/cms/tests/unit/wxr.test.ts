import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { parseWxrStream, parseWpDate, readWxrFile, WxrError, type WxrItem, type WxrRecord } from '../../src/import/wxr'
import { BILLION_LAUGHS, cdata, chunked, itemXml, wxr, type FixtureItem } from '../fixtures/wxr/generate'

const collect = async (text: string, limits = {}, size = 7): Promise<WxrRecord[]> => {
  const out: WxrRecord[] = []
  for await (const r of parseWxrStream(chunked(text, size), limits)) out.push(r)
  return out
}
const items = (recs: WxrRecord[]): WxrItem[] => recs.flatMap((r) => (r.record === 'item' ? [r.item] : []))
const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p
    return 'no error'
  } catch (e) {
    return e instanceof WxrError ? e.code : `other:${String(e)}`
  }
}

describe('parseWxrStream: well-formed export', () => {
  it('yields site, channel categories, authors and typed items, across tiny chunk boundaries', async () => {
    const recs = await collect(
      wxr([
        {
          id: 10,
          title: 'Café & “quotes” \u{1F600}',
          slug: 'cafe',
          creator: 'editor_one',
          content: '<p>Hello &amp; welcome ]]> done</p>',
          excerpt: 'Short',
          categories: [
            { nicename: 'news', name: 'News' },
            { nicename: 'faith', name: 'Faith' },
          ],
          tags: [{ nicename: 'lent', name: 'Lent' }],
          meta: { _thumbnail_id: '55', other_key: 'ignored' },
        },
      ]),
    )
    expect(recs.find((r) => r.record === 'site')).toMatchObject({
      site: { wxrVersion: '1.2', baseSiteUrl: 'https://old.example.test' },
    })
    expect(recs.filter((r) => r.record === 'category')).toHaveLength(1)
    expect(recs.find((r) => r.record === 'author')).toEqual({
      record: 'author',
      author: { authorId: 2, login: 'editor_one', displayName: 'Editor One' },
    })
    const [it] = items(recs)
    expect(it).toMatchObject({
      kind: 'post',
      wpId: 10,
      title: 'Café & “quotes” \u{1F600}',
      slug: 'cafe',
      status: 'publish',
      postType: 'post',
      author: 'editor_one',
      excerptHtml: 'Short',
      thumbnailId: 55,
      hasPassword: false,
      issues: [],
      dateGmt: '2023-05-04T10:30:00.000Z',
      modifiedGmt: '2023-05-06T08:00:00.000Z',
      attachment: null,
    })
    expect(it.contentHtml).toBe('<p>Hello &amp; welcome ]]> done</p>')
    expect(it.link).toBe('https://old.example.test/cafe/')
    expect(it.categories).toEqual([
      { name: 'News', nicename: 'news' },
      { name: 'Faith', nicename: 'faith' },
    ])
    expect(it.tags).toEqual([{ name: 'Lent', nicename: 'lent' }])
  })

  it('decodes XML entities outside CDATA', async () => {
    const xml = wxr([]).replace(
      '</channel>',
      `<item><title>A &amp; B &lt;c&gt; &#233;</title><wp:post_id>1</wp:post_id><wp:post_type>post</wp:post_type></item></channel>`,
    )
    expect(items(await collect(xml))[0].title).toBe('A & B <c> é')
  })

  it('tolerates a UTF-8 BOM (bytes and string)', async () => {
    expect(items(await collect(wxr([{ id: 1 }], { bom: true })))).toHaveLength(1)
    const out: WxrRecord[] = []
    const asString = (async function* () {
      yield wxr([{ id: 2 }], { bom: true })
    })()
    for await (const r of parseWxrStream(asString)) out.push(r)
    expect(items(out)[0].wpId).toBe(2)
  })

  it('covers every status and post type', async () => {
    const statuses = ['publish', 'draft', 'private', 'pending', 'future', 'trash', 'auto-draft', 'inherit']
    const list: FixtureItem[] = statuses.map((s, n) => ({ id: n + 1, status: s }))
    list.push(
      { id: 20, postType: 'page' },
      { id: 21, postType: 'attachment', status: 'inherit' },
      { id: 22, postType: 'nav_menu_item' },
      { id: 23, postType: 'custom_thing' },
    )
    const got = items(await collect(wxr(list)))
    expect(got.slice(0, 8).map((i) => i.status)).toEqual(statuses)
    expect(got.slice(8).map((i) => i.kind)).toEqual(['page', 'attachment', 'nav_menu_item', 'other'])
    expect(got[11].postType).toBe('custom_thing')
  })

  it('reads attachments with alt text, attached file and URL', async () => {
    const [a] = items(
      await collect(
        wxr([
          {
            id: 30,
            postType: 'attachment',
            status: 'inherit',
            parent: 10,
            attachmentUrl: 'https://old.example.test/wp-content/uploads/2023/10/photo.jpg',
            meta: { _wp_attachment_image_alt: 'A synthetic photo', _wp_attached_file: '2023/10/photo.jpg' },
          },
        ]),
      ),
    )
    expect(a.attachment).toEqual({
      url: 'https://old.example.test/wp-content/uploads/2023/10/photo.jpg',
      altText: 'A synthetic photo',
      attachedFile: '2023/10/photo.jpg',
    })
    expect(a.parentId).toBe(10)
  })

  it('reads Rank Math and Yoast meta, and flags a password without keeping it', async () => {
    const [a] = items(
      await collect(
        wxr([
          {
            id: 40,
            password: 'hunter2',
            meta: {
              rank_math_title: '%title% %sep% %sitename%',
              rank_math_description: 'Plain description',
              _yoast_wpseo_title: 'Y title',
              _yoast_wpseo_metadesc: 'Y desc',
            },
          },
        ]),
      ),
    )
    expect(a.seo).toEqual({
      rankMathTitle: '%title% %sep% %sitename%',
      rankMathDescription: 'Plain description',
      yoastTitle: 'Y title',
      yoastDescription: 'Y desc',
      yoastCanonical: null,
      yoastNoindex: null,
      yoastPrimaryCategory: null,
      yoastSocialTitle: null,
      yoastSocialDescription: null,
    })
    expect(a.hasPassword).toBe(true)
    expect(JSON.stringify(a)).not.toContain('hunter2')
  })

  it('handles a missing GMT date: local-time fallback with a flag, or missing', async () => {
    const got = items(
      await collect(
        wxr([
          { id: 1, dateGmt: '0000-00-00 00:00:00', date: '2023-01-02 03:04:05', status: 'draft' },
          { id: 2, dateGmt: '0000-00-00 00:00:00', date: '0000-00-00 00:00:00' },
          { id: 3, dateGmt: '2023-02-30 00:00:00', date: '2023-02-03 00:00:00' },
        ]),
      ),
    )
    expect(got[0]).toMatchObject({ dateGmt: '2023-01-02T03:04:05.000Z', dateIssue: 'localTime', issues: ['dateLocalTime'] })
    expect(got[1]).toMatchObject({ dateGmt: null, dateIssue: 'missing', issues: ['dateMissing'] })
    expect(got[2].dateIssue).toBe('localTime')
    expect(parseWpDate('0000-00-00 00:00:00')).toBeNull()
  })
})

describe('comments: no email, url or IP in the output', () => {
  it('keeps the fields we need and drops the personal ones', async () => {
    const recs = await collect(
      wxr([
        {
          id: 50,
          comments: [
            {
              id: 1,
              author: 'Reader One',
              content: 'Nice piece',
              email: 'secret1@example.test',
              url: 'https://secret.example.test/me',
              ip: '198.51.100.99',
            },
            { id: 2, parent: 1, approved: 'spam', type: 'pingback' },
          ],
        },
      ]),
    )
    const [it] = items(recs)
    expect(it.comments).toEqual([
      {
        id: 1,
        parentId: 0,
        authorName: 'Reader One',
        content: 'Nice piece',
        dateGmt: '2023-05-05T11:00:00.000Z',
        dateIssue: null,
        approved: '1',
        type: 'comment',
      },
      expect.objectContaining({ id: 2, parentId: 1, approved: 'spam', type: 'pingback' }),
    ])
    const dump = JSON.stringify(recs)
    for (const secret of [
      'secret1@example.test',
      'secret.example.test',
      '198.51.100.99',
      '203.0.113.7',
      'commenter@example.test',
      'private@example.test',
      'editor@example.test',
    ]) {
      expect(dump).not.toContain(secret)
    }
    expect(Object.keys(it.comments[0]).sort()).toEqual([
      'approved',
      'authorName',
      'content',
      'dateGmt',
      'dateIssue',
      'id',
      'parentId',
      'type',
    ])
  })
})

describe('security', () => {
  it('rejects a DOCTYPE with entities (billion laughs) before expanding anything', async () => {
    expect(await codeOf(collect(BILLION_LAUGHS))).toBe('WXR_DOCTYPE')
    expect(await codeOf(collect(BILLION_LAUGHS, {}, 1_000_000))).toBe('WXR_DOCTYPE')
  })

  it('rejects an external-entity (XXE) sample and a bare DOCTYPE', async () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss><channel></channel></rss>`
    expect(await codeOf(collect(xxe))).toBe('WXR_DOCTYPE')
    expect(await codeOf(collect(`<!DOCTYPE rss><rss><channel></channel></rss>`))).toBe('WXR_DOCTYPE')
    expect(await codeOf(collect(`<?xml version="1.0"?><!doctype rss><rss><channel></channel></rss>`))).toBe('WXR_DOCTYPE')
  })

  it('rejects a DOCTYPE or ENTITY after the root, but allows the text inside CDATA', async () => {
    const after = wxr([]).replace('</channel>', '<!DOCTYPE x></channel>')
    expect(await codeOf(collect(after))).toBe('WXR_DOCTYPE')
    // An unquoted ENTITY declaration after the root: only parser.onsgmldeclaration catches this.
    const ent = wxr([]).replace('</channel>', '<!ENTITY x></channel>')
    expect(await codeOf(collect(ent))).toBe('WXR_DOCTYPE')
    expect(await codeOf(collect(ent, {}, 1_000_000))).toBe('WXR_DOCTYPE')
    // A quoted one is still refused (the parser never expands it).
    const quoted = wxr([]).replace('</channel>', '<!ENTITY x "y"></channel>')
    expect(await codeOf(collect(quoted))).not.toBe('no error')
    const inCdata = items(await collect(wxr([{ id: 1, content: '<!DOCTYPE html><p>x</p>' }])))
    expect(inCdata[0].contentHtml).toContain('<!DOCTYPE html>')
  })

  it('does not let a comment hide a DOCTYPE from the pre-root scan (one large chunk)', async () => {
    const xml = `<!-- <a --><!DOCTYPE r [<!ENTITY x "y">]><rss><channel></channel></rss>`
    expect(await codeOf(collect(xml, {}, 1_000_000))).toBe('WXR_DOCTYPE')
    expect(await codeOf(collect(xml, {}, 5))).toBe('WXR_DOCTYPE')
    // linear time on a comment bomb
    const t = Date.now()
    await codeOf(collect('<!--'.repeat(250_000), {}, 1_000_000))
    expect(Date.now() - t).toBeLessThan(2000)
  })

  it('rejects attribute floods fast, on item, channel and root tags', async () => {
    const attrs = (n: number) => Array.from({ length: n }, (_, i) => ` a${i}="${'x'.repeat(1024)}"`).join('')
    const t = Date.now()
    const onItem = wxr([]).replace('</channel>', `<item${attrs(50_000)}></item></channel>`)
    expect(await codeOf(collect(onItem, {}, 65536))).toBe('WXR_ITEM_TOO_LARGE')
    const onChannelRecord = wxr([]).replace('</channel>', `<wp:category${attrs(50_000)}></wp:category></channel>`)
    expect(await codeOf(collect(onChannelRecord, {}, 65536))).toBe('WXR_ITEM_TOO_LARGE')
    const inItem = wxr([]).replace('</channel>', `<item><wp:post_id${attrs(50_000)}>1</wp:post_id></item></channel>`)
    expect(await codeOf(collect(inItem, {}, 65536))).toBe('WXR_ITEM_TOO_LARGE')
    const root = `<rss${attrs(50_000)}><channel></channel></rss>`
    expect(await codeOf(collect(root, {}, 65536))).toBe('WXR_ITEM_TOO_LARGE')
    // wall clock is load-sensitive on shared runners; an unbounded parse of 200 MB of attributes would take minutes
    expect(Date.now() - t).toBeLessThan(30_000)
    // a normal number of attributes is fine, and attribute bytes count against the item size
    expect(items(await collect(wxr([{ id: 1 }])))).toHaveLength(1)
    const few = wxr([]).replace('</channel>', `<item><wp:post_id a="${'x'.repeat(3000)}">1</wp:post_id></item></channel>`)
    expect(await codeOf(collect(few, { maxItemBytes: 1000 }))).toBe('WXR_ITEM_TOO_LARGE')
  })

  it('caps the channel record size', async () => {
    const bigCat = wxr([]).replace('</channel>', `<wp:category><wp:cat_name>${'x'.repeat(100_000)}</wp:cat_name></wp:category></channel>`)
    expect(await codeOf(collect(bigCat, {}, 65536))).toBe('WXR_ITEM_TOO_LARGE')
  })

  it('drops an over-long meta value instead of truncating it, and keeps the item', async () => {
    const [it] = items(await collect(wxr([{ id: 1, meta: { rank_math_description: 'y'.repeat(40_000), rank_math_title: 'Fine' } }]), {}, 4096))
    expect(it.seo.rankMathDescription).toBeNull()
    expect(it.seo.rankMathTitle).toBe('Fine')
  })

  it('refuses an export with no root element within the first megabyte', async () => {
    expect(await codeOf(collect(' '.repeat(1_200_000), {}, 65536))).toBe('WXR_NOT_WXR')
  })

  it('refuses encodings other than UTF-8', async () => {
    const xml = wxr([{ id: 1 }])
    for (const enc of ['utf16le', 'latin1'] as const) {
      const bytes = Buffer.from(enc === 'utf16le' ? `﻿${xml}` : xml.replace('UTF-8', 'ISO-8859-1'), enc)
      const run = async () => {
        for await (const r of parseWxrStream((async function* () { yield bytes })())) void r
      }
      expect(await codeOf(run())).toBe('WXR_ENCODING')
    }
    // UTF-16 without a BOM, one byte at a time
    const noBom = Buffer.from(xml, 'utf16le')
    const tiny = async () => {
      for await (const r of parseWxrStream((async function* () { for (const b of noBom) yield Uint8Array.of(b) })())) void r
    }
    expect(await codeOf(tiny())).toBe('WXR_ENCODING')
    expect(await codeOf(collect(xml.replace('UTF-8', 'utf8')))).toBe('no error')
  })

  it('does not keep the password text', async () => {
    const [it] = items(await collect(wxr([{ id: 1, password: 'hunter2' }, { id: 2 }]), {}, 3))
    expect(it.hasPassword).toBe(true)
    expect(JSON.stringify(it)).not.toContain('hunter2')
    expect(items(await collect(wxr([{ id: 2 }])))[0].hasPassword).toBe(false)
  })

  it('rejects an oversized single item', async () => {
    const big = wxr([{ id: 1, content: 'x'.repeat(3000) }])
    expect(await codeOf(collect(big, { maxItemBytes: 1000 }, 512))).toBe('WXR_ITEM_TOO_LARGE')
    expect(items(await collect(wxr([{ id: 1, content: 'x'.repeat(500) }]), { maxItemBytes: 5000 }))).toHaveLength(1)
  })

  it('counts element spam towards the item size', async () => {
    const spam = wxr([]).replace('</channel>', `<item>${'<a/>'.repeat(2000)}</item></channel>`)
    expect(await codeOf(collect(spam, { maxItemBytes: 1000 }))).toBe('WXR_ITEM_TOO_LARGE')
  })

  it('rejects too many items, too deep nesting, and an oversized file', async () => {
    expect(await codeOf(collect(wxr([{ id: 1 }, { id: 2 }, { id: 3 }]), { maxItems: 2 }))).toBe('WXR_TOO_MANY_ITEMS')
    const bomb = `<rss><channel>${'<a>'.repeat(10_000)}`
    expect(await codeOf(collect(bomb))).toBe('WXR_TOO_DEEP')
    expect(await codeOf(collect(wxr([{ id: 1 }]), { maxFileBytes: 100 }))).toBe('WXR_FILE_TOO_LARGE')
  })

  it('error messages are the bare code (no file content)', async () => {
    let message = ''
    try {
      await collect(wxr([{ id: 1, title: 'SECRET-TITLE' }]).replace('</rss>', '<<'))
    } catch (e) {
      message = (e as Error).message
    }
    expect(message).toMatch(/^WXR_[A-Z_]+$/)
  })
})

describe('malformed input', () => {
  it('rejects malformed XML', async () => {
    expect(await codeOf(collect(wxr([{ id: 1 }]).replace('</channel>', '</wrong></channel>')))).toBe('WXR_MALFORMED')
    expect(await codeOf(collect('<rss><channel><item></channel></rss>'))).toBe('WXR_MALFORMED')
  })

  it('rejects a truncated file', async () => {
    const full = wxr([{ id: 1 }, { id: 2 }])
    expect(await codeOf(collect(full.slice(0, full.length - 30)))).toBe('WXR_TRUNCATED')
    expect(await codeOf(collect(full.slice(0, full.indexOf('</item>') - 10)))).toBe('WXR_TRUNCATED')
    expect(await codeOf(collect(full.replace('</rss>\n', '')))).toBe('WXR_TRUNCATED')
  })

  it('rejects non-WXR input', async () => {
    expect(await codeOf(collect(''))).toBe('WXR_NOT_WXR')
    expect(await codeOf(collect('hello'))).toBe('WXR_NOT_WXR')
    expect(await codeOf(collect('<html><body></body></html>'))).toBe('WXR_NOT_WXR')
  })

  it('ignores unknown elements safely', async () => {
    const xml = wxr([]).replace(
      '</channel>',
      `<foo:bar xmlns:foo="x"><nested>1</nested></foo:bar><item><wp:post_id>9</wp:post_id><weird>z</weird><wp:post_type>post</wp:post_type><wp:term>t</wp:term></item></channel>`,
    )
    expect(items(await collect(xml))[0]).toMatchObject({ wpId: 9, kind: 'post' })
  })
})

describe('readWxrFile', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wxr-test-'))
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('streams a file from disk', async () => {
    const f = path.join(dir, 'a.xml')
    fs.writeFileSync(f, wxr([{ id: 1 }, { id: 2 }]))
    const out: WxrRecord[] = []
    for await (const r of readWxrFile(f)) out.push(r)
    expect(items(out).map((i) => i.wpId)).toEqual([1, 2])
  })

  it('refuses a missing file, a directory and an oversized file with short codes', async () => {
    expect(await codeOf(readWxrFile(path.join(dir, 'nope.xml')).next())).toBe('WXR_UNREADABLE')
    expect(await codeOf(readWxrFile(dir).next())).toBe('WXR_UNREADABLE')
    const f = path.join(dir, 'b.xml')
    fs.writeFileSync(f, wxr([{ id: 1 }]))
    expect(await codeOf(readWxrFile(f, { maxFileBytes: 50 }).next())).toBe('WXR_FILE_TOO_LARGE')
  })

  it('reads a few thousand items from disk', async () => {
    const f = path.join(dir, 'c.xml')
    const head = wxr([]).split('</channel>')[0]
    const fd = fs.openSync(f, 'w')
    fs.writeSync(fd, head)
    for (let i = 1; i <= 3000; i++) fs.writeSync(fd, itemXml({ id: i, content: `<p>${cdata('x').length}</p>` }))
    fs.writeSync(fd, '</channel></rss>')
    fs.closeSync(fd)
    let n = 0
    for await (const r of readWxrFile(f)) if (r.record === 'item') n += 1
    expect(n).toBe(3000)
  })
})
