import { describe, expect, it } from 'vitest'

import {
  dropTemplateVariableSeo,
  resolveSlugCollisions,
  sanitizeLegacyLinks,
  stripShortcodes,
} from '../../src/lib/legacyContent'

describe('resolveSlugCollisions', () => {
  it('keeps valid, unique slugs and reports nothing', () => {
    const r = resolveSlugCollisions([{ slug: 'first-post' }, { slug: 'second-post' }], ['other'])
    expect(r.items.map((i) => i.slug)).toEqual(['first-post', 'second-post'])
    expect(r.renamed).toEqual([])
  })

  it('renames collisions with the store and inside the batch: -2, -3', () => {
    const r = resolveSlugCollisions(
      [{ slug: 'news' }, { slug: 'news' }, { slug: 'news' }, { slug: 'taken' }, { slug: 'taken-2' }],
      ['taken'],
    )
    expect(r.items.map((i) => i.slug)).toEqual(['news', 'news-2', 'news-3', 'taken-2', 'taken-2-2'])
    expect(r.renamed).toEqual([
      { old: 'news', new: 'news-2' },
      { old: 'news', new: 'news-3' },
      { old: 'taken', new: 'taken-2' },
      { old: 'taken-2', new: 'taken-2-2' },
    ])
  })

  it('normalises invalid slugs and falls back to the title, then to "article"', () => {
    const r = resolveSlugCollisions([
      { slug: 'Caf%C3%A9 Night' },
      { slug: 'under_score--double' },
      { slug: '', title: 'A Title Here' },
      { slug: '%%%' },
      { slug: '%%%' },
    ])
    expect(r.items.map((i) => i.slug)).toEqual(['caf-c3-a9-night', 'under-score-double', 'a-title-here', 'article', 'article-2'])
    expect(r.renamed).toHaveLength(5)
    expect(r.renamed[0]).toEqual({ old: 'Caf%C3%A9 Night', new: 'caf-c3-a9-night' })
  })

  it('keeps every result within the slug rule and 160 characters', () => {
    const long = 'a'.repeat(160)
    const r = resolveSlugCollisions([{ slug: long }, { slug: long }, { slug: `${'b'.repeat(200)}` }], [])
    for (const i of r.items) {
      expect(i.slug.length).toBeLessThanOrEqual(160)
      expect(i.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    }
    expect(r.items[0].slug).toBe(long)
    expect(r.items[1].slug).toBe(`${'a'.repeat(158)}-2`)
    expect(new Set(r.items.map((i) => i.slug)).size).toBe(3)
  })

  it('preserves extra properties and does not mutate its input', () => {
    const input = [{ slug: 'x', legacyId: 7 }]
    const r = resolveSlugCollisions(input, ['x'])
    expect(r.items[0]).toEqual({ slug: 'x-2', legacyId: 7 })
    expect(input[0].slug).toBe('x')
  })
})

describe('stripShortcodes', () => {
  it('removes shortcodes with attributes, closing tags, plugin-style names and well-known bare tags', () => {
    const r = stripShortcodes('Intro [caption id="a" width="300"]pic[/caption] mid [gallery] and [penci_slider] end [wpforms id="5"]')
    expect(r.text).toBe('Intro pic mid and end')
    expect(r.removed).toEqual(['caption', 'gallery', 'penci_slider', 'wpforms'])
    expect(r.count).toBe(5)
  })

  it('reports each tag name once and counts every removed marker', () => {
    const r = stripShortcodes('[box a=1]x[/box] [box a=2]y[/box]')
    expect(r.removed).toEqual(['box'])
    expect(r.count).toBe(4)
  })

  it('leaves editorial brackets alone', () => {
    for (const keep of ['He said [sic] twice', 'A [laughs] moment', "[Editor's note] later", 'See [1] and [12]', 'Reference [Smith 2020]', 'Array a[0] = [x]']) {
      const r = stripShortcodes(keep)
      expect(r.text, keep).toBe(keep)
      expect(r.removed, keep).toEqual([])
    }
  })

  it('supports extra known bare tags and self-closing shortcodes', () => {
    expect(stripShortcodes('a [donate] b', { knownTags: ['donate'] }).text).toBe('a b')
    expect(stripShortcodes('a [my_tag foo="1" /] b').removed).toEqual(['my_tag'])
  })

  it('handles empty and non-string input', () => {
    expect(stripShortcodes('')).toEqual({ text: '', removed: [], count: 0 })
    expect(stripShortcodes(undefined as unknown as string)).toEqual({ text: '', removed: [], count: 0 })
  })
})

describe('dropTemplateVariableSeo', () => {
  it('drops values that contain %variables% and flags them', () => {
    expect(dropTemplateVariableSeo('%title% %sep% %sitename%')).toEqual({ value: null, dropped: true })
    expect(dropTemplateVariableSeo('News: %title%')).toEqual({ value: null, dropped: true })
    expect(dropTemplateVariableSeo('%excerpt%')).toEqual({ value: null, dropped: true })
  })

  it('keeps ordinary text (trimmed), including a lone percent sign', () => {
    expect(dropTemplateVariableSeo('  Church opens clinic ')).toEqual({ value: 'Church opens clinic', dropped: false })
    expect(dropTemplateVariableSeo('Giving rose by 50% this year, 20% more')).toEqual({
      value: 'Giving rose by 50% this year, 20% more',
      dropped: false,
    })
  })

  it('returns null without the flag for blanks and non-strings', () => {
    expect(dropTemplateVariableSeo('')).toEqual({ value: null, dropped: false })
    expect(dropTemplateVariableSeo('   ')).toEqual({ value: null, dropped: false })
    expect(dropTemplateVariableSeo(undefined)).toEqual({ value: null, dropped: false })
    expect(dropTemplateVariableSeo(5)).toEqual({ value: null, dropped: false })
  })
})

describe('sanitizeLegacyLinks', () => {
  const opts = {
    oldHosts: ['old.example.test'],
    slugMap: new Map([
      ['harvest-festival', 'harvest-festival'],
      ['news', 'news-2'],
    ]),
    articlePath: (slug: string) => `/article/${slug}`,
  }
  const text = (t: string) => ({ type: 'text', text: t, format: 0, version: 1 })
  const link = (url: string, label = 'label', extra: Record<string, unknown> = {}) => ({
    type: 'link',
    version: 3,
    fields: { linkType: 'custom', url, newTab: false },
    children: [text(label)],
    ...extra,
  })
  const doc = (...children: unknown[]) => ({ root: { type: 'root', children: [{ type: 'paragraph', children }] } })
  const urls = (d: any) => (d.root.children[0].children as any[]).map((n) => (n.type === 'link' ? n.fields.url : `text:${n.text}`))

  it('keeps http, https, mailto and root-relative links untouched', () => {
    const input = doc(link('https://other.example.test/a'), link('http://other.example.test/b'), link('mailto:desk@example.test'), link('/about'))
    const { root, report } = sanitizeLegacyLinks(input, opts)
    expect(root).toEqual(input)
    expect(report).toEqual({ rewritten: 0, unmapped: [], converted: [] })
  })

  it('rewrites links to the old host through the slug map, keeping the fragment', () => {
    const input = doc(
      link('https://old.example.test/harvest-festival/'),
      link('https://www.OLD.example.test/2020/05/news/#comments'),
      link('http://old.example.test/'),
    )
    const { root, report } = sanitizeLegacyLinks(input, opts)
    expect(urls(root)).toEqual(['/article/harvest-festival', '/article/news-2#comments', '/'])
    expect(report.rewritten).toBe(3)
  })

  it('keeps old-host links it cannot map, and lists them', () => {
    const input = doc(link('https://old.example.test/unknown-post/'), link('https://old.example.test/wp-content/uploads/2023/a.jpg'))
    const { root, report } = sanitizeLegacyLinks(input, opts)
    expect(urls(root)).toEqual(['https://old.example.test/unknown-post/', 'https://old.example.test/wp-content/uploads/2023/a.jpg'])
    expect(report.unmapped).toHaveLength(2)
    expect(report.rewritten).toBe(0)
  })

  it('converts every other link to its plain text children', () => {
    const bad = [
      'javascript:alert(1)',
      ' JaVaScRiPt:alert(1)',
      'java\tscript:alert(1)',
      'data:text/html,<b>x</b>',
      'vbscript:x',
      'tel:+2340000',
      'ftp://example.test/x',
      'page/relative',
      'page.html',
      '#top',
      '//evil.example.test/x',
      '/\\evil.example.test/x',
      'https://user:pw@example.test/x',
      '',
      '   ',
    ]
    for (const url of bad) {
      const { root, report } = sanitizeLegacyLinks(doc(text('before '), link(url, 'LABEL'), text(' after')), opts)
      expect(urls(root), JSON.stringify(url)).toEqual(['text:before ', 'text:LABEL', 'text: after'])
      expect(report.converted, JSON.stringify(url)).toHaveLength(1)
    }
  })

  it('walks nested nodes (lists, quotes, table cells) and unwraps nested link children in place', () => {
    const input = {
      root: {
        type: 'root',
        children: [
          { type: 'list', children: [{ type: 'listitem', children: [link('javascript:x', 'in list')] }] },
          { type: 'quote', children: [link('/ok', 'quote link')] },
          {
            type: 'table',
            children: [{ type: 'tablerow', children: [{ type: 'tablecell', children: [{ type: 'paragraph', children: [link('data:x', 'cell')] }] }] }],
          },
        ],
      },
    }
    const { root, report } = sanitizeLegacyLinks(input, opts)
    const r = root.root.children as any[]
    expect(r[0].children[0].children).toEqual([text('in list')])
    expect(r[1].children[0].fields.url).toBe('/ok')
    expect(r[2].children[0].children[0].children[0].children).toEqual([text('cell')])
    expect(report.converted).toHaveLength(2)
  })

  it('accepts the root node itself and the plain-lexical `url` property', () => {
    const rootNode = { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'link', url: 'https://old.example.test/news/', children: [text('n')] }] }] }
    const { root } = sanitizeLegacyLinks(rootNode, opts)
    expect((root.children[0] as any).children[0].url).toBe('/article/news-2')
  })

  it('does not touch other nodes, does not mutate its input, and leaves internal links alone', () => {
    const upload = { type: 'upload', relationTo: 'media', value: 4, fields: null }
    const block = { type: 'block', fields: { blockType: 'youtubeEmbed', videoId: 'dQw4w9WgXcQ', url: 'javascript:x' } }
    const internal = { type: 'link', fields: { linkType: 'internal', doc: { relationTo: 'articles', value: 3 } }, children: [text('i')] }
    const input = { root: { type: 'root', children: [upload, block, { type: 'paragraph', children: [internal, link('javascript:y')] }] } }
    const snapshot = structuredClone(input)
    const { root } = sanitizeLegacyLinks(input, opts)
    expect(input).toEqual(snapshot)
    const kids = root.root.children as any[]
    expect(kids[0]).toEqual(upload)
    expect(kids[1]).toEqual(block)
    expect(kids[2].children).toEqual([internal, text('label')])
  })

  it('accepts an object slug map and ignores prototype keys', () => {
    const o = { ...opts, slugMap: { news: 'n-2' } as Record<string, string> }
    expect(urls(sanitizeLegacyLinks(doc(link('https://old.example.test/news/')), o).root)).toEqual(['/article/n-2'])
    expect(urls(sanitizeLegacyLinks(doc(link('https://old.example.test/constructor/')), o).root)).toEqual(['https://old.example.test/constructor/'])
  })

  it('refuses a mapper that returns an unsafe path', () => {
    const o = { ...opts, articlePath: () => '//evil.example.test/x' }
    const { root, report } = sanitizeLegacyLinks(doc(link('https://old.example.test/news/')), o)
    expect(urls(root)).toEqual(['https://old.example.test/news/'])
    expect(report.unmapped).toHaveLength(1)
  })

  it('tolerates empty and malformed input', () => {
    expect(sanitizeLegacyLinks(null, opts).root).toBeNull()
    expect(sanitizeLegacyLinks({ root: {} }, opts).root).toEqual({ root: {} })
    expect(() => sanitizeLegacyLinks({ root: { children: [null, 5, 'x', { type: 'link' }] } }, opts)).not.toThrow()
  })
})
