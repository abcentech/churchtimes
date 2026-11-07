import { describe, expect, it } from 'vitest'

import {
  extractYoutubeId,
  HtmlConversionError,
  htmlToLexical,
  LINK_MAX_LENGTH,
  MAX_OPEN_SHORTCODES,
  MAX_PARSE_DEPTH,
  MAX_WARNINGS,
  redactUrl,
} from '../../src/import/htmlToLexical'
import { baseOptions, blocks, conv, type N, plain, shape } from './htmlToLexical.helpers'

const VID = 'dQw4w9WgXcQ'
const timed = <T>(fn: () => T): { value: T; ms: number } => {
  const t = Date.now()
  const value = fn()
  return { value, ms: Date.now() - t }
}
const codeOf = (fn: () => unknown): string | null => {
  try {
    fn()
    return null
  } catch (e) {
    if (e instanceof HtmlConversionError) return e.code
    throw e
  }
}

describe('review MUST 1: Gutenberg block nesting is linear, depth-limited and never a raw error', () => {
  it.each([
    ['wp:group with content', `${'<!-- wp:group -->'.repeat(3200)}x${'<!-- /wp:group -->'.repeat(3200)}`],
    ['unclosed wp:a', `${'<!-- wp:a -->'.repeat(3200)}x`],
    ['unclosed wp:group with divs', `${'<!-- wp:group --><div>'.repeat(200)}x`],
    ['mixed names closed in the wrong order', `${'<!-- wp:a --><!-- wp:b -->'.repeat(1500)}x${'<!-- /wp:a -->'.repeat(1500)}`],
    ['stray closes only', `${'<!-- /wp:group -->'.repeat(5000)}x`],
  ])('%s', (_label, html) => {
    const { value, ms } = timed(() => conv(html))
    expect(plain(value.root)).toBe('x')
    expect(ms).toBeLessThan(3000)
    expect(value.report.warnings.length).toBeLessThanOrEqual(MAX_WARNINGS + 1)
  })

  it('block nesting past the limit is flattened and counted, below it the blocks are kept', () => {
    const deep = conv(`${'<!-- wp:group -->'.repeat(200)}<p>inner</p>${'<!-- /wp:group -->'.repeat(200)}`)
    expect(deep.report.deepNestingFlattened).toBeGreaterThan(0)
    expect(plain(deep.root)).toBe('inner')
    const shallow = conv(`${'<!-- wp:group -->'.repeat(10)}<h2>h</h2><p>inner</p>${'<!-- /wp:group -->'.repeat(10)}`)
    expect(shallow.report.deepNestingFlattened).toBe(0)
    expect(shape(`${'<!-- wp:group -->'.repeat(10)}<h2>h</h2><p>inner</p>${'<!-- /wp:group -->'.repeat(10)}`)).toEqual(['h2', 'paragraph'])
  })

  it('warnings are capped', () => {
    const r = conv(`${'<!-- wp:a -->x<!-- /wp:b -->'.repeat(300)}`)
    expect(r.report.warnings.length).toBeLessThanOrEqual(MAX_WARNINGS + 1)
  })

  it('a non-limit error (a throwing slug map) is wrapped, never a raw RangeError', () => {
    const slugMap = new Proxy({}, {
      getOwnPropertyDescriptor() {
        throw new RangeError('Maximum call stack size exceeded')
      },
    })
    let caught: unknown
    try {
      htmlToLexical('<p><a href="https://old.example.test/some-post/">x</a></p>', baseOptions({ slugMap }))
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(HtmlConversionError)
    expect((caught as HtmlConversionError).code).toBe('invalid-output')
  })
})

describe('review MUST 2: depth is enforced by the real parser stack', () => {
  it('<div/> is not self-closing in HTML: 20 000 of them are refused quickly', () => {
    const { ms, value } = timed(() => codeOf(() => htmlToLexical(`${'<div/>'.repeat(20_000)}x`, baseOptions())))
    expect(value).toBe('too-deep')
    expect(ms).toBeLessThan(2000)
  })

  it('style/script inside svg or math are ordinary elements: nesting inside them still counts', () => {
    for (const wrapper of ['svg', 'math']) {
      for (const inner of ['style', 'script']) {
        const { ms, value } = timed(() => codeOf(() => htmlToLexical(`<${wrapper}><${inner}>${'<div>'.repeat(20_000)}x`, baseOptions())))
        expect(value, `${wrapper}/${inner}`).toBe('too-deep')
        expect(ms).toBeLessThan(2000)
      }
    }
  })

  it('the limit is exactly MAX_PARSE_DEPTH open elements', () => {
    expect(MAX_PARSE_DEPTH).toBe(512)
    const ok = conv(`${'<div>'.repeat(MAX_PARSE_DEPTH)}x${'</div>'.repeat(MAX_PARSE_DEPTH)}`)
    expect(plain(ok.root)).toBe('x')
    expect(ok.report.deepNestingFlattened).toBeGreaterThan(0)
    expect(codeOf(() => htmlToLexical(`${'<div>'.repeat(MAX_PARSE_DEPTH + 1)}x`, baseOptions()))).toBe('too-deep')
  })

  it('raw-text elements really are raw text in HTML: 300 + 300 nesting around a style converts (no false refusal)', () => {
    const r = conv(`${'<div>'.repeat(300)}<style>${'<div>'.repeat(300)}</style>x${'</div>'.repeat(300)}`)
    expect(plain(r.root)).toBe('x')
    const t = conv(`${'<div>'.repeat(300)}<textarea>${'<div>'.repeat(300)}</textarea>y`)
    expect(plain(t.root)).toBe('y')
  })

  it('optional end tags (unclosed p and li) do not count as nesting', () => {
    const r = conv('<p>one'.repeat(2000))
    expect(r.root.children).toHaveLength(2000)
    const li = conv(`<ul>${'<li>item'.repeat(2000)}</ul>`)
    expect((li.root.children[0] as N).children).toHaveLength(2000)
  })
})

describe('review MUST 3: shortcode tracking is bounded', () => {
  it('4000 paragraphs each opening a different shortcode tag convert quickly', () => {
    const html = Array.from({ length: 4000 }, (_, i) => `<p>[t${i} x=1]</p>`).join('')
    const { value, ms } = timed(() => conv(html, { maxNodes: 100_000 }))
    expect(ms).toBeLessThan(4000)
    expect(Object.keys(value.report.shortcodesRemoved).length).toBe(4000)
    expect(value.report.warnings.join(' ')).toContain(`${MAX_OPEN_SHORTCODES} different shortcode tags`)
  })

  it('pairs split across paragraphs still work within the cap', () => {
    const r = conv('<p>[box type="x"]a</p><p>b[/box]</p><p>[other y=1]c</p><p>d[/other]</p>')
    expect(r.root.children.map(plain)).toEqual(['a', 'b', 'c', 'd'])
  })
})

describe('review MUST 4: nothing is dropped without a trace', () => {
  it('a flattened table keeps every row and every cell', () => {
    const rows = Array.from({ length: 6000 }, (_, i) => `<tr><td>r${i}</td><td>v</td></tr>`).join('')
    const r = conv(`<table>${rows}</table>`, { maxNodes: 100_000 })
    expect(r.root.children).toHaveLength(6000)
    expect(plain(r.root.children[5999] as N)).toBe('r5999 | v')
    const wide = conv(`<table><tr>${Array.from({ length: 300 }, (_, i) => `<td>c${i}</td>`).join('')}</tr></table>`)
    expect(plain(wide.root.children[0] as N).endsWith('c299')).toBe(true)
    expect(plain(wide.root.children[0] as N).split(' | ')).toHaveLength(300)
  })

  it('a figure keeps every image, however many', () => {
    const imgs = Array.from({ length: 120 }, (_, i) => `<img src="img-${i + 1}.jpg">`).join('')
    const r = conv(`<figure>${imgs}<figcaption>Many</figcaption></figure>`)
    expect(shape(`<figure>${imgs}</figure>`).filter((s) => s.startsWith('upload'))).toHaveLength(120)
    expect(r.root.children.filter((c: N) => c.type === 'upload')).toHaveLength(120)
    expect(plain(r.root.children[120] as N)).toBe('Many')
  })

  it('other children of a figure (paragraphs, links, text) are kept in order', () => {
    const b = blocks('<figure><p>Before the picture</p><img src="img-3.jpg"><p>After the <a href="https://example.test/x">picture</a></p><figcaption>Caption</figcaption></figure>')
    expect(b.map((n) => n.type)).toEqual(['paragraph', 'upload', 'paragraph', 'paragraph'])
    expect(plain(b[0])).toBe('Before the picture')
    expect(plain(b[3])).toBe('After the picture')
    expect(plain(b[2])).toBe('Caption') // the caption follows its image directly
  })

  it('multiple figcaptions are separate paragraphs', () => {
    const b = blocks('<figure><img src="img-3.jpg"><figcaption>One</figcaption><figcaption>Two</figcaption></figure>')
    expect(b.map((n) => n.type)).toEqual(['upload', 'paragraph', 'paragraph'])
    expect(b.slice(1).map(plain)).toEqual(['One', 'Two'])
  })

  it('the caption of a non-YouTube embed becomes a paragraph after the link', () => {
    const r = conv('<!-- wp:embed {"url":"https://social.example.test/p/9"} --><figure><div class="wp-block-embed__wrapper">https://social.example.test/p/9</div><figcaption>The <b>caption</b></figcaption></figure><!-- /wp:embed -->')
    expect(r.root.children.map(plain)).toEqual(['https://social.example.test/p/9', 'The caption'])
  })

  it('a YouTube caption that cannot be a title stays as a paragraph (no title written)', () => {
    const r = conv(`<!-- wp:embed {"url":"https://youtu.be/${VID}"} --><figure><div class="wp-block-embed__wrapper">https://youtu.be/${VID}</div><figcaption>a &lt;b&gt; caption</figcaption></figure><!-- /wp:embed -->`)
    const block = r.root.children[0] as N
    expect(block.fields.title).toBeUndefined()
    expect(plain(r.root.children[1] as N)).toBe('a <b> caption')
    const long = conv(`<!-- wp:embed {"url":"https://youtu.be/${VID}"} --><figure><div class="wp-block-embed__wrapper">https://youtu.be/${VID}</div><figcaption>${'w'.repeat(130)}</figcaption></figure><!-- /wp:embed -->`)
    expect((long.root.children[0] as N).fields.title).toBeUndefined()
    expect(long.root.children).toHaveLength(2)
    const fine = conv(`<!-- wp:embed {"url":"https://youtu.be/${VID}"} --><figure><div class="wp-block-embed__wrapper">https://youtu.be/${VID}</div><figcaption>Harvest service</figcaption></figure><!-- /wp:embed -->`)
    expect((fine.root.children[0] as N).fields.title).toBe('Harvest service')
    expect(fine.root.children).toHaveLength(1)
  })

  it('a gallery over the per-figure image cap reports what it did not convert', () => {
    const imgs = Array.from({ length: 5001 }, (_, i) => `<img src="img-${(i % 90) + 1}.jpg">`).join('')
    const r = conv(`<!-- wp:gallery --><figure>${imgs}</figure><!-- /wp:gallery -->`, { maxNodes: 100_000 })
    expect(r.report.warnings.join(' ')).toMatch(/more than 5000 images/)
    expect(r.root.children.filter((c: N) => c.type === 'upload')).toHaveLength(5000)
  })
})

describe('review SHOULD', () => {
  it('control characters are stripped after parsing (text and alt)', () => {
    expect(plain(blocks('<p>a&#1;b&#xFEFF;c&#x7F;d&#x200B;</p>')[0])).toBe('abcd​')
    const seen: string[] = []
    conv('<img src="x.jpg" alt="al&#2;t">', { resolveImage: (_s, c) => (seen.push(c.alt), null) })
    expect(seen).toEqual(['alt'])
  })

  it('[embed] never takes a bare 11-character id as a video; [youtube] and [yt] may', () => {
    expect(shape('<p>[embed]hello-world[/embed]</p>')).toEqual(['paragraph']) // only the empty-body placeholder
    expect(shape('<p>[embed]dQw4w9WgXcQ[/embed]</p>')).toEqual(['paragraph'])
    expect(shape(`<p>[youtube ${VID}]</p>`)).toEqual([`yt:${VID}`])
    expect(shape(`<p>[yt ${VID}]</p>`)).toEqual([`yt:${VID}`])
    expect(shape(`<p>[youtube]${VID}[/youtube]</p>`)).toEqual([`yt:${VID}`])
    expect(shape('<p>[youtube short]</p>')).toEqual(['paragraph'])
  })

  it('an inline [youtube URL] inside a paragraph becomes a block (text kept around it)', () => {
    expect(shape(`<p>Watch this [youtube https://youtu.be/${VID}] and then read on.</p>`)).toEqual(['paragraph', `yt:${VID}`, 'paragraph'])
    const r = conv('<p>Watch [youtube https://youtu.be/short] now.</p>')
    expect(r.root.children.map(plain)).toEqual(['Watch now.'])
    expect(r.report.shortcodesRemoved.youtube).toBe(1)
    expect(conv(`<p>a [embed]https://youtu.be/${VID}[/embed] b [youtube=https://youtu.be/${VID}] c</p>`).report.youtube).toBe(2)
  })

  it('shortcode scanning is linear on hostile text', () => {
    const { ms } = timed(() => conv(`<p>${'[youtube '.repeat(30_000)}</p>`))
    expect(ms).toBeLessThan(3000)
    const spaces = timed(() => conv(`<p>[youtube${' '.repeat(100_000)}</p>`))
    expect(spaces.ms).toBeLessThan(3000)
  })

  it('report addresses carry no user info, query or fragment', () => {
    const r = conv('<p><a href="https://user:secret@old.example.test/post/?token=abc#frag">a</a> <a href="https://old.example.test/?p=12&amp;key=zzz">b</a> <a href="javascript:alert(1)?x=1">c</a></p>')
    const urls = [...r.report.links.converted, ...r.report.links.unmapped].map((e) => e.url)
    expect(urls.length).toBe(3)
    for (const u of urls) expect(u).not.toMatch(/secret|token|key=|frag|\?|#/)
    expect(redactUrl('https://u:p@example.test/a/b?x=1#y')).toBe('https://example.test/a/b')
    expect(redactUrl('//u:p@example.test/a?x')).not.toMatch(/u:p|\?/)
    const unresolved = conv('<img src="https://cdn.example.test/a.jpg?sig=SECRET">')
    expect(JSON.stringify(unresolved.report.images.unresolved)).not.toContain('SECRET')
  })

  it('a link address over the cap is dropped to text and reported', () => {
    const ok = conv(`<p><a href="https://example.test/${'a'.repeat(LINK_MAX_LENGTH - 'https://example.test/'.length)}">x</a></p>`)
    expect((ok.root.children[0] as N).children[0].type).toBe('link')
    const long = conv(`<p><a href="https://example.test/${'a'.repeat(LINK_MAX_LENGTH)}">LINKTEXT</a></p>`)
    expect(plain(long.root.children[0] as N)).toBe('LINKTEXT')
    expect(JSON.stringify(long.root)).not.toContain('"link"')
    expect(long.report.links.converted).toHaveLength(1)
    expect(long.report.links.converted[0].reason).toContain(String(LINK_MAX_LENGTH))
  })

  it('classic/freeform blocks inside a Gutenberg post get newline handling back', () => {
    const r = conv('<!-- wp:paragraph --><p>wrapped\ntext</p><!-- /wp:paragraph --><!-- wp:freeform -->First line\nsecond line\n\nSecond paragraph<!-- /wp:freeform --><!-- wp:classic -->Alpha\n\nBeta<!-- /wp:classic -->')
    expect(r.root.children.map(plain)).toEqual(['wrapped text', 'First line\nsecond line', 'Second paragraph', 'Alpha', 'Beta'])
  })

  it('shortcodes are removed from alt and caption before resolveImage', () => {
    const seen: [string, string][] = []
    const r = conv('<figure><img src="a.jpg" alt=\'[gallery ids="1,2"]Choir [sic]\'><figcaption>Cap [contact-form-7 id="1"] text</figcaption></figure>', {
      resolveImage: (_s, c) => (seen.push([c.alt, c.caption]), null),
    })
    expect(seen).toEqual([['Choir [sic]', 'Cap text']])
    expect(r.report.shortcodesRemoved.gallery).toBe(1)
    expect(JSON.stringify(r.root)).not.toMatch(/gallery|contact-form/)
  })
})

describe('safeguards that must fail the suite when removed', () => {
  const iframe = (src: string) => `<iframe src='${src}'></iframe>`

  it('credentials in an embed address (safeHttpsUrl)', () => {
    const r = conv(iframe('https://u:p@vimeo.example.test/1'))
    expect(r.report.embeds.dropped).toHaveLength(1)
    expect(r.report.embeds.linked).toHaveLength(0)
    expect(conv(iframe('https://u@vimeo.example.test/1')).report.embeds.dropped).toHaveLength(1)
  })

  it('characters outside the safe address pattern (SAFE_HTTPS_RE)', () => {
    for (const bad of ['https://example.test/x"y', 'https://example.test/x<y', 'https://example.test/x y', 'https://example.test/x\\y', 'https://example.test/x>y']) {
      const r = conv(iframe(bad))
      expect(r.report.embeds.dropped, bad).toHaveLength(1)
      expect(r.root.children.every((c: N) => c.type !== 'paragraph' || !plain(c).includes('example.test')), bad).toBe(true)
    }
    const ok = conv(iframe('https://example.test/fine?a=1&b=2'))
    expect(ok.report.embeds.linked).toHaveLength(1)
  })

  it('an embed address over 2000 characters is dropped', () => {
    const r = conv(iframe(`https://example.test/${'a'.repeat(2000)}`))
    expect(r.report.embeds.dropped).toHaveLength(1)
  })

  it('extractYoutubeId: protocol check and 2000 character cap', () => {
    expect(extractYoutubeId(`javascript://www.youtube.com/embed/${VID}`)).toBeNull()
    expect(extractYoutubeId(`ftp://www.youtube.com/embed/${VID}`)).toBeNull()
    expect(conv(`<a href="javascript://www.youtube.com/embed/${VID}">x</a>`).report.youtube).toBe(0)
    expect(shape(`<iframe src="javascript://www.youtube.com/embed/${VID}"></iframe>`)).toEqual(['paragraph'])
    const base = `https://youtu.be/${VID}?x=`
    expect(extractYoutubeId(base + 'a'.repeat(2000 - base.length))).toBe(VID)
    expect(extractYoutubeId(base + 'a'.repeat(2001 - base.length))).toBeNull()
  })

  it('YouTube block titles: markup in a caption or title never reaches the block', () => {
    const r = conv(`<!-- wp:embed {"url":"https://youtu.be/${VID}"} --><figure><figcaption>a &lt;b&gt;</figcaption></figure><!-- /wp:embed -->`)
    expect((r.root.children[0] as N).fields.title).toBeUndefined()
    const t = conv(`<iframe src="https://youtu.be/${VID}" title="&lt;i&gt;x"></iframe>`)
    expect((t.root.children[0] as N).fields.title).toBeUndefined()
  })

  it('a block comment over 20 000 characters is not a block (it is dropped and counted)', () => {
    const pad = 'x'.repeat(20_000)
    const r = conv(`<!-- wp:embed {"url":"https://youtu.be/${VID}","pad":"${pad}"} --><figure></figure><!-- /wp:embed -->`)
    expect(r.report.youtube).toBe(0)
    expect(r.report.commentsDropped).toBeGreaterThanOrEqual(1)
    const small = conv(`<!-- wp:embed {"url":"https://youtu.be/${VID}","pad":"x"} --><figure></figure><!-- /wp:embed -->`)
    expect(small.report.youtube).toBe(1)
  })

  it('<ol start> is clamped to 1 000 000 and defaults to 1', () => {
    expect((blocks('<ol start="99999999999"><li>a</li></ol>')[0] as N).start).toBe(1_000_000)
    expect((blocks('<ol start="0"><li>a</li></ol>')[0] as N).start).toBe(1)
    expect((blocks('<ol start="-4"><li>a</li></ol>')[0] as N).start).toBe(1)
    expect((blocks('<ol start="abc"><li>a</li></ol>')[0] as N).start).toBe(1)
    expect((blocks('<ol start="7"><li>a</li></ol>')[0] as N).start).toBe(7)
  })
})
