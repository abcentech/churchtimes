import { describe, expect, it } from 'vitest'

import {
  LINK_WALK_MAX_DEPTH,
  dropTemplateVariableSeo,
  resolveSlugCollisions,
  sanitizeLegacyLinks,
  stripShortcodes,
} from '../../src/lib/legacyContent'

describe('resolveSlugCollisions', () => {
  const slugs = (r: { items: { slug: string }[] }) => r.items.map((i) => i.slug)

  it('keeps valid, unique slugs and reports nothing', () => {
    const r = resolveSlugCollisions([{ slug: 'first-post' }, { slug: 'second-post' }], ['other'])
    expect(slugs(r)).toEqual(['first-post', 'second-post'])
    expect(r.renamed).toEqual([])
  })

  it('renames collisions with the store and inside the batch: -2, -3', () => {
    const r = resolveSlugCollisions([{ slug: 'news' }, { slug: 'news' }, { slug: 'news' }, { slug: 'taken' }], ['taken'])
    expect(slugs(r)).toEqual(['news', 'news-2', 'news-3', 'taken-2'])
    expect(r.renamed).toEqual([
      { old: 'news', new: 'news-2' },
      { old: 'news', new: 'news-3' },
      { old: 'taken', new: 'taken-2' },
    ])
  })

  it('never lets a duplicate steal a slug another post really owns, in either order', () => {
    const forward = resolveSlugCollisions([{ slug: 'a' }, { slug: 'a' }, { slug: 'a-2' }])
    expect(slugs(forward)).toEqual(['a', 'a-3', 'a-2'])
    expect(forward.renamed).toEqual([{ old: 'a', new: 'a-3' }])

    const reversed = resolveSlugCollisions([{ slug: 'a-2' }, { slug: 'a' }, { slug: 'a' }])
    expect(slugs(reversed)).toEqual(['a-2', 'a', 'a-3'])
    expect(reversed.renamed).toEqual([{ old: 'a', new: 'a-3' }])

    const middle = resolveSlugCollisions([{ slug: 'a' }, { slug: 'a-2' }, { slug: 'a' }, { slug: 'a-3' }, { slug: 'a' }])
    expect(slugs(middle)).toEqual(['a', 'a-2', 'a-4', 'a-3', 'a-5'])
    expect(new Set(slugs(middle)).size).toBe(5)
  })

  it('treats case collisions: a real lower-case slug always beats an upper-case one that normalises to it', () => {
    const a = resolveSlugCollisions([{ slug: 'My-Post' }, { slug: 'my-post' }])
    expect(slugs(a)).toEqual(['my-post-2', 'my-post'])
    expect(a.renamed).toEqual([{ old: 'My-Post', new: 'my-post-2' }])

    const b = resolveSlugCollisions([{ slug: 'my-post' }, { slug: 'My-Post' }])
    expect(slugs(b)).toEqual(['my-post', 'my-post-2'])

    const c = resolveSlugCollisions([{ slug: 'My-Post' }, { slug: 'MY-POST' }])
    expect(slugs(c)).toEqual(['my-post', 'my-post-2'])

    const d = resolveSlugCollisions([{ slug: 'My-Post' }], [])
    expect(slugs(d)).toEqual(['my-post'])
    expect(d.renamed).toEqual([{ old: 'My-Post', new: 'my-post' }])
  })

  it('does not let a suffixed duplicate take a slug an invalid original normalises to', () => {
    const r = resolveSlugCollisions([{ slug: 'x' }, { slug: 'x' }, { slug: 'X-2' }])
    expect(slugs(r)).toEqual(['x', 'x-3', 'x-2'])
  })

  it('normalises invalid slugs and falls back to the title, then to "article"', () => {
    const r = resolveSlugCollisions([
      { slug: 'Caf%C3%A9 Night' },
      { slug: 'under_score--double' },
      { slug: '', title: 'A Title Here' },
      { slug: '%%%' },
      { slug: '%%%' },
    ])
    expect(slugs(r)).toEqual(['caf-c3-a9-night', 'under-score-double', 'a-title-here', 'article', 'article-2'])
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
    expect(new Set(slugs(r)).size).toBe(3)
  })

  it('preserves extra properties and does not mutate its input', () => {
    const input = [{ slug: 'x', legacyId: 7 }]
    const r = resolveSlugCollisions(input, ['x'])
    expect(r.items[0]).toEqual({ slug: 'x-2', legacyId: 7 })
    expect(input[0].slug).toBe('x')
  })
})

describe('stripShortcodes', () => {
  it('removes attribute shortcodes, their paired closing tags and known bare tags, and reports each removal', () => {
    const r = stripShortcodes('Intro [caption id="a" width="300"]pic[/caption] mid [gallery] and [penci-slider] end [wpforms id="5"]')
    expect(r.text).toBe('Intro pic mid and end')
    expect(r.removed).toEqual(['caption', 'gallery', 'penci-slider', 'wpforms'])
    expect(r.count).toBe(5)
    expect(r.removals.map((x) => `${x.tag}:${x.reason}`)).toEqual([
      'caption:attributes',
      'caption:closing',
      'gallery:known',
      'penci-slider:known',
      'wpforms:attributes',
    ])
  })

  it('removes a closing tag only when it pairs with a removed opening tag', () => {
    expect(stripShortcodes('a [/caption] b').text).toBe('a [/caption] b')
    expect(stripShortcodes('a [/box] b').count).toBe(0)
    // unknown opening tag without attributes is kept, so its closing tag is kept too
    expect(stripShortcodes('[box]x[/box]').text).toBe('[box]x[/box]')
    expect(stripShortcodes('[box a=1]x[/box] [box a=2]y[/box]').text).toBe('x y')
  })

  it('leaves editorial brackets and hyphenated or numbered words alone', () => {
    for (const keep of [
      'He said [sic] twice',
      'A [laughs] moment',
      "[Editor's note] later",
      'See [1] and [12]',
      'Reference [Smith 2020]',
      'Array a[0] = [x]',
      'The [co-founder] spoke',
      'During [covid-19] closures',
      'Model [x1] and [x-1]',
      'A [Video] was shown',
      'A [Gallery] and [CAPTION] too',
      'He [said hi] twice',
    ]) {
      const r = stripShortcodes(keep)
      expect(r.text, keep).toBe(keep)
      expect(r.count, keep).toBe(0)
    }
  })

  it('matches known tags case-sensitively and accepts extra known tags', () => {
    expect(stripShortcodes('a [video] b').text).toBe('a b')
    expect(stripShortcodes('a [Video] b').text).toBe('a [Video] b')
    expect(stripShortcodes('a [donate] b', { knownTags: ['donate'] }).text).toBe('a b')
    expect(stripShortcodes('a [Donate] b', { knownTags: ['donate'] }).text).toBe('a [Donate] b')
    expect(stripShortcodes('a [my_tag foo="1" /] b').removed).toEqual(['my_tag'])
    expect(stripShortcodes('a [penci_slider] b').count).toBe(1)
    expect(stripShortcodes('a [pencil] b').count).toBe(0)
  })

  it('treats name=value, a quoted first argument and a URL argument as attributes', () => {
    expect(stripShortcodes('x [foo bar="1"] y').text).toBe('x y')
    expect(stripShortcodes("x [foo 'arg'] y").text).toBe('x y')
    expect(stripShortcodes('x [foo "arg"] y').text).toBe('x y')
    expect(stripShortcodes('x [foo https://example.test/a] y').text).toBe('x y')
    expect(stripShortcodes('x [foo bar] y').text).toBe('x [foo bar] y')
  })

  it('tidies only the whitespace touching a removed tag and leaves the rest byte for byte', () => {
    expect(stripShortcodes('  lead  [gallery]  trail  ').text).toBe('  lead   trail  ')
    expect(stripShortcodes('a  b\n\n[gallery]\n\nc   d').text).toBe('a  b\n\n\n\nc   d')
    expect(stripShortcodes('x [gallery]\ny').text).toBe('x\ny')
    expect(stripShortcodes('[gallery] start').text).toBe('start')
    expect(stripShortcodes('end [gallery]').text).toBe('end')
    expect(stripShortcodes('a[gallery]b').text).toBe('ab')
    expect(stripShortcodes('   keep   spaces   and [x]  ').text).toBe('   keep   spaces   and [x]  ')
  })

  it('handles empty and non-string input', () => {
    expect(stripShortcodes('')).toEqual({ text: '', removed: [], count: 0, removals: [] })
    expect(stripShortcodes(undefined as unknown as string)).toEqual({ text: '', removed: [], count: 0, removals: [] })
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
      ['2', 'two'],
      ['category', 'category-article'],
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

  it('writes a space inside a web address as %20 (the editor rejects an address with a space) and drops tabs and line breaks', () => {
    const out = sanitizeLegacyLinks(doc(link('https://other.example.test/a b/c d'), link(' https://other.example.test/x	y '), link('https://old.example.test/a b/')), opts)
    expect(urls(out.root)).toEqual(['https://other.example.test/a%20b/c%20d', 'https://other.example.test/xy', 'https://old.example.test/a%20b/'])
  })

  it('keeps http, https, mailto and root-relative links untouched', () => {
    const input = doc(link('https://other.example.test/a'), link('http://other.example.test/b'), link('mailto:desk@example.test'), link('/about'))
    const { root, report } = sanitizeLegacyLinks(input, opts)
    expect(root).toEqual(input)
    expect(report).toEqual({ rewritten: 0, unmapped: [], converted: [] })
  })

  it('rewrites a plain /<slug>/ link to the old host through the slug map, keeping the fragment', () => {
    const input = doc(
      link('https://old.example.test/harvest-festival/'),
      link('https://www.OLD.example.test/news#comments'),
      link('http://old.example.test/'),
      link('https://old.example.test./harvest-festival/'),
      link('https://OLD.EXAMPLE.TEST/Harvest-Festival/'),
    )
    const { root, report } = sanitizeLegacyLinks(input, opts)
    expect(urls(root)).toEqual([
      '/article/harvest-festival',
      '/article/news-2#comments',
      '/',
      '/article/harvest-festival',
      '/article/harvest-festival',
    ])
    expect(report.rewritten).toBe(5)
    expect(report.unmapped).toEqual([])
  })

  it('keeps every other old-host link as written and lists it with a reason', () => {
    const cases: [string, RegExp][] = [
      ['https://old.example.test/?p=123', /query string/],
      ['https://old.example.test/news/?utm_source=x', /query string/],
      ['https://old.example.test/category/news/', /not a single-segment/],
      ['https://old.example.test/hello/2/', /not a single-segment/],
      ['https://old.example.test/2020/05/news/', /not a single-segment/],
      ['https://old.example.test/category', /reserved WordPress/],
      ['https://old.example.test/wp-login.php', /reserved WordPress/],
      ['https://old.example.test/feed/', /reserved WordPress/],
      ['https://old.example.test/unknown-post/', /not in the slug map/],
      ['https://old.example.test/wp-content/uploads/2023/a.jpg', /not a single-segment/],
    ]
    for (const [url, reason] of cases) {
      const { root, report } = sanitizeLegacyLinks(doc(link(url)), opts)
      expect(urls(root), url).toEqual([url])
      expect(report.rewritten, url).toBe(0)
      expect(report.unmapped, url).toHaveLength(1)
      expect(report.unmapped[0].reason, url).toMatch(reason)
      expect(report.unmapped[0].url).toBe(url)
    }
  })

  it('converts every unsafe link to its plain text children', () => {
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
      'https://user:pw@old.example.test/news/',
      '',
      '   ',
    ]
    for (const url of bad) {
      const { root, report } = sanitizeLegacyLinks(doc(text('before '), link(url, 'LABEL'), text(' after')), opts)
      expect(urls(root), JSON.stringify(url)).toEqual(['text:before ', 'text:LABEL', 'text: after'])
      expect(report.converted, JSON.stringify(url)).toHaveLength(1)
    }
  })

  it('checks every URL slot of a link node: fields.url and top-level url and href', () => {
    const slots: Record<string, unknown>[] = [
      { fields: { url: '/ok' }, url: 'javascript:alert(1)' },
      { fields: { url: '/ok' }, href: 'javascript:alert(1)' },
      { fields: { url: 'javascript:alert(1)' }, url: '/ok' },
      { fields: { url: '/ok' }, url: '/ok', href: 'data:text/html,x' },
      { fields: { url: 5 } },
      { fields: { url: '/ok' }, url: { evil: true } },
    ]
    for (const s of slots) {
      const node = { type: 'link', ...s, children: [text('T')] }
      const input = { root: { type: 'root', children: [{ type: 'paragraph', children: [node] }] } }
      const { root, report } = sanitizeLegacyLinks(input, opts)
      expect((root as any).root.children[0].children, JSON.stringify(s)).toEqual([text('T')])
      expect(report.converted, JSON.stringify(s)).toHaveLength(1)
    }
    // all safe: kept, and each slot is rewritten on its own
    const ok = { type: 'autolink', fields: { url: 'https://old.example.test/news/' }, url: 'https://old.example.test/news/', href: '/x', children: [text('T')] }
    const { root, report } = sanitizeLegacyLinks({ root: { type: 'root', children: [ok] } }, opts)
    const n = (root as any).root.children[0]
    expect([n.fields.url, n.url, n.href]).toEqual(['/article/news-2', '/article/news-2', '/x'])
    expect(report.rewritten).toBe(1)
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

  it('does not pass a deep javascript: link through unchecked: the subtree is flattened and reported', () => {
    let node: Record<string, unknown> = { type: 'paragraph', children: [link('javascript:alert(1)', 'deep label'), text(' tail')] }
    for (let i = 0; i < LINK_WALK_MAX_DEPTH + 6; i++) node = { type: 'quote', children: [node] }
    const input = { root: { type: 'root', children: [node] } }
    const { root, report } = sanitizeLegacyLinks(input, opts)
    expect(JSON.stringify(root)).not.toContain('javascript:')
    expect(JSON.stringify(root)).toContain('deep label tail')
    expect(report.converted.some((c) => /nested deeper/.test(c.reason))).toBe(true)

    // a link just inside the limit is still handled normally
    let ok: Record<string, unknown> = { type: 'paragraph', children: [link('javascript:alert(1)', 'shallow')] }
    for (let i = 0; i < 10; i++) ok = { type: 'quote', children: [ok] }
    const shallow = sanitizeLegacyLinks({ root: { type: 'root', children: [ok] } }, opts)
    expect(JSON.stringify(shallow.root)).not.toContain('javascript:')
    expect(shallow.report.converted).toHaveLength(1)
    expect(shallow.report.converted[0].reason).toMatch(/javascript/)
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
