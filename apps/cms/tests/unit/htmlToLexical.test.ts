import { describe, expect, it } from 'vitest'

import { extractYoutubeId, HtmlConversionError, htmlToLexical } from '../../src/import/htmlToLexical'
import { findEmbedProblem } from '../../src/lib/lexicalEmbeds'
import { baseOptions, blocks, conv, type N, plain, shape } from './htmlToLexical.helpers'

const VID = 'dQw4w9WgXcQ'

describe('extractYoutubeId', () => {
  const ok: [string, string][] = [
    [`https://www.youtube.com/embed/${VID}`, VID],
    [`https://www.youtube.com/embed/${VID}?rel=0&feature=oembed`, VID],
    [`//www.youtube.com/embed/${VID}`, VID],
    [`https://www.youtube-nocookie.com/embed/${VID}`, VID],
    [`https://youtu.be/${VID}`, VID],
    [`https://youtu.be/${VID}?t=42`, VID],
    [`https://www.youtube.com/watch?v=${VID}`, VID],
    [`https://youtube.com/watch?feature=share&v=${VID}&t=3`, VID],
    [`https://m.youtube.com/watch?v=${VID}`, VID],
    [`https://www.youtube.com/shorts/${VID}`, VID],
    ['https://youtu.be/A-_0aZ9-_zz', 'A-_0aZ9-_zz'],
  ]
  it.each(ok)('%s', (url, id) => expect(extractYoutubeId(url)).toBe(id))

  const bad = [
    `https://www.youtube.com/embed/${VID}0`, // 12 characters
    'https://www.youtube.com/embed/short',
    'https://www.youtube.com/embed/videoseries?list=PLxxxxxxxxxxx',
    `https://evil.example.test/embed/${VID}`,
    `https://www.youtube.com.evil.example.test/embed/${VID}`,
    `javascript:alert(1)//youtube.com/embed/${VID}`,
    `https://youtu.be/${VID}!`,
    'https://www.youtube.com/watch?v=bad!id!!!!!',
    '',
    42,
    null,
  ]
  it.each(bad)('rejects %s', (url) => expect(extractYoutubeId(url as string)).toBeNull())
})

describe('Gutenberg blocks', () => {
  it('keeps headings, paragraphs, lists and images (never everything as paragraphs)', () => {
    const html = `<!-- wp:heading {"level":2} --><h2 class="wp-block-heading">Harvest</h2><!-- /wp:heading -->
<!-- wp:paragraph --><p>First paragraph.</p><!-- /wp:paragraph -->
<!-- wp:list --><ul><li>one</li><li>two</li></ul><!-- /wp:list -->
<!-- wp:image {"id":5} --><figure class="wp-block-image"><img src="https://old.example.test/wp-content/uploads/2023/10/img-5.jpg" alt="Choir"/></figure><!-- /wp:image -->`
    expect(shape(html)).toEqual(['h2', 'paragraph', 'list', 'upload:5'])
  })

  it('heading levels from the block attribute and element', () => {
    expect(shape('<!-- wp:heading {"level":3} --><h3>x</h3><!-- /wp:heading -->')).toEqual(['h2']) // no skipping from nothing
    expect(shape('<h2>a</h2><h3>b</h3><h4>c</h4>')).toEqual(['h2', 'h3', 'h4'])
  })

  it('wp:more and <!--more--> are a paragraph break, never a join of words', () => {
    for (const marker of ['<!--more-->', '<!-- wp:more --><!--more--><!-- /wp:more -->', '<!--more Read on-->']) {
      const b = blocks(`<!-- wp:paragraph --><p>before</p><!-- /wp:paragraph -->${marker}<!-- wp:paragraph --><p>after</p><!-- /wp:paragraph -->`)
      expect(b.map(plain)).toEqual(['before', 'after'])
    }
    // classic: marker between two words of the same text run
    const classic = blocks('first part<!--more-->second part')
    expect(classic.map(plain)).toEqual(['first part', 'second part'])
    expect(conv('a<!--more-->b').report.moreMarkers).toBe(1)
  })

  it('wp:gallery keeps every image in order, with captions', () => {
    const html = `<!-- wp:gallery {"ids":[1,2,3]} --><figure class="wp-block-gallery has-nested-images">
<!-- wp:image {"id":1} --><figure class="wp-block-image"><img src="img-1.jpg" alt="a"/><figcaption>Cap one</figcaption></figure><!-- /wp:image -->
<!-- wp:image {"id":2} --><figure class="wp-block-image"><img src="img-2.jpg" alt="b"/></figure><!-- /wp:image -->
<!-- wp:image {"id":3} --><figure class="wp-block-image"><img src="img-3.jpg" alt="c"/></figure><!-- /wp:image -->
</figure><!-- /wp:gallery -->`
    const b = blocks(html)
    expect(shape(html)).toEqual(['upload:1', 'paragraph', 'upload:2', 'upload:3'])
    expect(plain(b[1])).toBe('Cap one')
  })

  it('old-style gallery markup (ul > li > figure)', () => {
    const html = '<!-- wp:gallery --><ul class="blocks-gallery-grid"><li><figure><img src="img-4.jpg"/></figure></li><li><figure><img src="img-5.jpg"/></figure></li></ul><!-- /wp:gallery -->'
    expect(shape(html)).toEqual(['upload:4', 'upload:5'])
  })

  it('wp:embed and core-embed/youtube produce the youtubeEmbed block', () => {
    const embed = `<!-- wp:embed {"url":"https://www.youtube.com/watch?v=${VID}","type":"video","providerNameSlug":"youtube"} --><figure class="wp-block-embed is-type-video"><div class="wp-block-embed__wrapper">https://www.youtube.com/watch?v=${VID}</div></figure><!-- /wp:embed -->`
    const old = `<!-- wp:core-embed/youtube {"url":"https://youtu.be/${VID}"} --><figure><div class="wp-block-embed__wrapper">https://youtu.be/${VID}</div></figure><!-- /wp:core-embed/youtube -->`
    const noAttr = `<!-- wp:embed --><figure><div class="wp-block-embed__wrapper">https://youtu.be/${VID}</div></figure><!-- /wp:embed -->`
    for (const html of [embed, old, noAttr]) {
      const r = conv(html)
      expect(r.root.children).toHaveLength(1)
      const block = r.root.children[0] as N
      expect(block).toMatchObject({ type: 'block', version: 2, format: '' })
      expect(block.fields).toMatchObject({ blockType: 'youtubeEmbed', videoId: VID })
      expect(block.fields.id).toMatch(/^[0-9a-f]{24}$/)
      expect(r.report.youtube).toBe(1)
    }
  })

  it('a non-YouTube wp:embed becomes a link paragraph when https, otherwise is dropped, always reported', () => {
    const tw = conv('<!-- wp:embed {"url":"https://social.example.test/post/1","providerNameSlug":"twitter"} --><figure><div class="wp-block-embed__wrapper">https://social.example.test/post/1</div></figure><!-- /wp:embed -->')
    expect(tw.root.children).toHaveLength(1)
    expect(plain(tw.root.children[0] as N)).toBe('https://social.example.test/post/1')
    expect((tw.root.children[0] as N).children[0].type).toBe('link')
    expect(tw.report.embeds.linked).toEqual([{ url: 'https://social.example.test/post/1' }])

    const bad = conv('<!-- wp:embed {"url":"javascript:alert(1)"} --><figure></figure><!-- /wp:embed -->')
    expect(bad.report.embeds.dropped).toHaveLength(1)
    expect(JSON.stringify(bad.root)).not.toContain('javascript')
    const http = conv('<!-- wp:embed {"url":"http://insecure.example.test/x"} --><figure></figure><!-- /wp:embed -->')
    expect(http.report.embeds.dropped).toHaveLength(1)
  })

  it('wp:table keeps the table', () => {
    const html = '<!-- wp:table --><figure class="wp-block-table"><table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table><figcaption>Table caption</figcaption></figure><!-- /wp:table -->'
    const r = conv(html)
    expect(shape(html)).toEqual(['table', 'paragraph'])
    expect(r.report.tables.kept).toBe(1)
  })

  it('wp:separator is dropped and reported', () => {
    const r = conv('<!-- wp:paragraph --><p>a</p><!-- /wp:paragraph --><!-- wp:separator --><hr class="wp-block-separator"/><!-- /wp:separator --><!-- wp:paragraph --><p>b</p><!-- /wp:paragraph -->')
    expect(r.root.children).toHaveLength(2)
    expect(r.report.horizontalRulesDropped).toBe(1)
  })

  it('wp:html and wp:shortcode are sanitised and shortcodes stripped', () => {
    const r = conv('<!-- wp:html --><div onclick="x()"><script>alert(1)</script><p>safe <b>text</b></p></div><!-- /wp:html --><!-- wp:shortcode -->[contact-form-7 id="12" title="Contact"]<!-- /wp:shortcode -->')
    expect(r.root.children.map(plain)).toEqual(['safe text'])
    expect(r.report.droppedElements.script).toBe(1)
    expect(r.report.shortcodesRemoved['contact-form-7']).toBe(1)
    expect(JSON.stringify(r.root)).not.toMatch(/onclick|alert/)
  })

  it('nested blocks (group > columns > column) keep their content', () => {
    const html = `<!-- wp:group --><div class="wp-block-group"><!-- wp:columns --><div class="wp-block-columns"><!-- wp:column --><div class="wp-block-column"><!-- wp:heading --><h2>Left</h2><!-- /wp:heading --><!-- wp:paragraph --><p>L text</p><!-- /wp:paragraph --></div><!-- /wp:column --><!-- wp:column --><div class="wp-block-column"><!-- wp:list --><ul><li>R item</li></ul><!-- /wp:list --></div><!-- /wp:column --></div><!-- /wp:columns --></div><!-- /wp:group -->`
    expect(shape(html)).toEqual(['h2', 'paragraph', 'list'])
  })

  it('unknown blocks fall back to their inner HTML and are listed', () => {
    const r = conv('<!-- wp:acme/fancy-box {"x":1} --><div class="box"><p>Inside <em>box</em></p></div><!-- /wp:acme/fancy-box -->')
    expect(r.root.children.map(plain)).toEqual(['Inside box'])
    expect(r.report.unknownBlocks).toEqual({ 'acme/fancy-box': 1 })
  })

  it('quote and pullquote', () => {
    const html = '<!-- wp:quote --><blockquote class="wp-block-quote"><p>Quoted words.</p><cite>Someone</cite></blockquote><!-- /wp:quote --><!-- wp:pullquote --><figure class="wp-block-pullquote"><blockquote><p>Pulled.</p></blockquote></figure><!-- /wp:pullquote -->'
    const b = blocks(html)
    expect(b.map((x) => x.type)).toEqual(['quote', 'quote'])
    expect(plain(b[0])).toBe('Quoted words.\nSomeone')
  })

  it('an unclosed block and a stray close are tolerated and reported', () => {
    const r = conv('<!-- wp:paragraph --><p>a</p><!-- /wp:paragraph --><!-- /wp:list --><!-- wp:heading --><h2>b</h2>')
    expect(r.root.children.map(plain)).toEqual(['a', 'b'])
    expect(r.report.warnings.join(' ')).toMatch(/not closed/)
  })

  it('invalid JSON in a block comment is ignored', () => {
    const r = conv('<!-- wp:paragraph {"broken": --><p>ok</p><!-- /wp:paragraph -->')
    expect(r.root.children.map(plain)).toEqual(['ok'])
  })
})

describe('classic editor', () => {
  it('blank lines are paragraphs, single newlines are line breaks (no <p>)', () => {
    const b = blocks('First line\nsecond line\n\nSecond paragraph\r\n\r\nThird')
    expect(b.map((x) => x.type)).toEqual(['paragraph', 'paragraph', 'paragraph'])
    expect(b[0].children.map((c: N) => c.type)).toEqual(['text', 'linebreak', 'text'])
    expect(plain(b[0])).toBe('First line\nsecond line')
    expect(plain(b[2])).toBe('Third')
  })

  it('mixed text and block elements', () => {
    expect(shape('Intro text\n\n<h3>Heading</h3>\nMore text\n<ul>\n<li>x</li>\n</ul>')).toEqual(['paragraph', 'h2', 'paragraph', 'list'])
  })

  it('with <p> elements, whitespace between them adds nothing', () => {
    expect(shape('<p>a</p>\n\n<p>b</p>\n')).toEqual(['paragraph', 'paragraph'])
  })

  it('newlines inside text with inline tags keep the words apart', () => {
    const b = blocks('one <b>two</b>\nthree')
    expect(plain(b[0])).toBe('one two\nthree')
  })

  it('whitespace is collapsed without joining words', () => {
    const b = blocks('<p>  many   spaces\t\there  and <i>some</i> <b>words</b>  </p>')
    expect(plain(b[0])).toBe('many spaces here and some words')
  })

  it('in Gutenberg documents newlines inside text are plain whitespace', () => {
    const b = blocks('<!-- wp:paragraph --><p>wrapped\ntext</p><!-- /wp:paragraph -->')
    expect(plain(b[0])).toBe('wrapped text')
  })

  it('[caption] keeps the image and its caption text, markers removed', () => {
    const r = conv('<p>[caption id="attachment_9" align="alignnone" width="300"]<a href="https://example.test/full"><img src="img-9.jpg" alt="Pic"/></a> The caption words[/caption]</p>')
    expect(shape('<p>[caption id="a" width="300"]<img src="img-9.jpg"/> The caption words[/caption]</p>')).toEqual(['upload:9', 'paragraph'])
    expect(r.report.shortcodesRemoved.caption).toBe(2)
    expect(JSON.stringify(r.root)).not.toContain('[caption')
    expect(JSON.stringify(r.root)).not.toContain('[/caption')
  })
})

describe('elements', () => {
  const headingCases: [string, string[]][] = [
    ['<h1>a</h1>', ['h2']],
    ['<h2>a</h2><h3>b</h3><h4>c</h4>', ['h2', 'h3', 'h4']],
    ['<h5>a</h5>', ['h2']],
    ['<h2>a</h2><h5>b</h5>', ['h2', 'h3']],
    ['<h2>a</h2><h6>b</h6><h4>c</h4>', ['h2', 'h3', 'h4']],
    ['<h3>a</h3><h2>b</h2>', ['h2', 'h2']],
    ['<h1>a</h1><h4>b</h4>', ['h2', 'h3']],
  ]
  it.each(headingCases)('headings %s', (html, expected) => expect(shape(html)).toEqual(expected))

  it('headings normalisation is counted', () => {
    expect(conv('<h1>a</h1><h6>b</h6>').report.headingsNormalised).toBeGreaterThanOrEqual(2)
  })

  const formatCases: [string, number][] = [
    ['<b>x</b>', 1], ['<strong>x</strong>', 1], ['<i>x</i>', 2], ['<em>x</em>', 2],
    ['<s>x</s>', 4], ['<del>x</del>', 4], ['<strike>x</strike>', 4], ['<u>x</u>', 8],
    ['<code>x</code>', 16], ['<sub>x</sub>', 32], ['<sup>x</sup>', 64],
    ['<strong><em>x</em></strong>', 3], ['<b><i><u>x</u></i></b>', 11],
    ['<strong><em><s><u><code><sub>x</sub></code></u></s></em></strong>', 63],
    ['<em><sup>x</sup></em>', 66],
  ]
  it.each(formatCases)('format %s', (html, format) => {
    const b = blocks(`<p>${html}</p>`)
    expect(b[0].children).toHaveLength(1)
    expect(b[0].children[0]).toMatchObject({ type: 'text', text: 'x', format })
  })

  it('adjacent runs with the same format are merged, different ones kept', () => {
    const b = blocks('<p>a <b>b</b><b> c</b> d</p>')
    expect(b[0].children.map((c: N) => [c.text, c.format])).toEqual([['a ', 0], ['b c', 1], [' d', 0]])
  })

  it('links: custom linkType, newTab from target, formatting kept inside', () => {
    const b = blocks('<p>see <a href="https://example.test/a" target="_blank" rel="noopener"><strong>this</strong> page</a>.</p>')
    const link = b[0].children[1]
    expect(link).toMatchObject({ type: 'link', fields: { url: 'https://example.test/a', newTab: true, linkType: 'custom' } })
    expect(link.children.map((c: N) => [c.text, c.format])).toEqual([['this', 1], [' page', 0]])
    const same = blocks('<p><a href="https://example.test/b">x</a></p>')
    expect(same[0].children[0].fields.newTab).toBe(false)
  })

  it('mailto and root-relative links survive', () => {
    const b = blocks('<p><a href="mailto:editor@example.test">m</a> <a href="/about/">r</a></p>')
    expect(b[0].children.filter((c: N) => c.type === 'link').map((c: N) => c.fields.url)).toEqual(['mailto:editor@example.test', '/about/'])
  })

  it('lists: ordered start, nesting, inline formatting', () => {
    const r = conv('<ol start="3"><li>one <b>b</b><ul><li>nested a</li><li>nested b<ol><li>deep</li></ol></li></ul></li><li>two</li></ol>')
    const list = r.root.children[0] as N
    expect(list).toMatchObject({ type: 'list', listType: 'number', tag: 'ol', start: 3 })
    expect(list.children.map((c: N) => c.type)).toEqual(['listitem', 'listitem', 'listitem'])
    expect(list.children[0].children.map((c: N) => c.type)).toEqual(['text', 'text'])
    const nested = list.children[1].children[0]
    expect(nested).toMatchObject({ type: 'list', listType: 'bullet' })
    expect(nested.children).toHaveLength(3)
    expect(list.children.map((c: N) => c.value)).toEqual([1, 2, 3])
  })

  it('lists nested deeper than the limit are flattened and reported', () => {
    let html = 'x'
    for (let i = 0; i < 12; i++) html = `<ul><li>level ${i}${html === 'x' ? '' : html}</li></ul>`
    const r = conv(html)
    expect(r.report.listsFlattened).toBeGreaterThan(0)
    expect(plain(r.root)).toContain('level 0')
    expect(plain(r.root)).toContain('level 11')
  })

  it('an image inside a list item is kept after the list', () => {
    expect(shape('<ul><li>text<img src="img-8.jpg"/></li></ul>')).toEqual(['list', 'upload:8'])
  })

  it('blockquote keeps paragraphs joined by line breaks and drops empty ones', () => {
    const b = blocks('<blockquote><p>one</p><p>two</p><p>&nbsp;</p></blockquote><blockquote></blockquote>')
    expect(b).toHaveLength(1)
    expect(plain(b[0])).toBe('one\ntwo')
  })

  it('br becomes a linebreak, at most two in a row, none at the edges', () => {
    const b = blocks('<p><br>a<br><br><br><br>b<br></p>')
    expect(b[0].children.map((c: N) => c.type)).toEqual(['text', 'linebreak', 'linebreak', 'text'])
  })

  it('hr is dropped and reported', () => {
    const r = conv('<p>a</p><hr><p>b</p>')
    expect(r.root.children).toHaveLength(2)
    expect(r.report.horizontalRulesDropped).toBe(1)
  })

  it('pre keeps its lines as code-formatted text', () => {
    const b = blocks('<pre>line one\n  line two</pre>')
    expect(plain(b[0])).toBe('line one\nline two')
    expect(b[0].children[0].format & 16).toBe(16)
  })

  it('unknown elements are flattened and listed; known inline wrappers are silent', () => {
    const r = conv('<p>a <span style="color:red">b</span> <weird-tag>c</weird-tag> <font size="3">d</font></p>')
    expect(plain(r.root.children[0] as N)).toBe('a b c d')
    expect(r.report.unknownElements).toEqual({ 'weird-tag': 1 })
  })

  it('definition lists become paragraphs', () => {
    expect(shape('<dl><dt>Term</dt><dd>Meaning</dd></dl>')).toEqual(['paragraph', 'paragraph'])
  })

  const dropped = ['script', 'style', 'object', 'form', 'noscript', 'svg', 'video', 'audio', 'textarea', 'canvas', 'button', 'select']
  it.each(dropped)('<%s> is dropped with its contents and reported', (tag) => {
    const r = conv(`<p>before</p><${tag}>SECRET-INNER</${tag}><p>after</p>`)
    expect(r.root.children.map(plain)).toEqual(['before', 'after'])
    expect(r.report.droppedElements[tag] ?? r.report.embeds.dropped.length).toBeTruthy()
    expect(JSON.stringify(r.root)).not.toContain('SECRET-INNER')
  })

  it('input and embed elements are dropped', () => {
    const r = conv('<p>a<input type="text" value="x"></p><embed src="https://files.example.test/x.swf">')
    expect(r.root.children.map(plain)).toEqual(['a', 'https://files.example.test/x.swf'])
    expect(r.report.droppedElements.input).toBe(1)
    expect(r.report.embeds.linked.length + r.report.embeds.dropped.length).toBe(1)
  })
})

describe('entities and empty blocks', () => {
  const entityCases: [string, string][] = [
    ['&#8220;quoted&#8221;', '“quoted”'],
    ['&#x2019;s', '’s'],
    ['&rsquo;&lsquo;&ldquo;&rdquo;', '’‘“”'],
    ['a&nbsp;b', 'a b'],
    ['fish &amp; chips &lt;3', 'fish & chips <3'],
    ['&hellip;&mdash;&ndash;', '…—–'],
    ['&eacute;&Eacute;&ntilde;', 'éÉñ'],
    ['&#8217;&#038;', '’&'],
    ['&zzzz; &', '&zzzz; &'],
  ]
  it.each(entityCases)('%s', (input, expected) => {
    const b = blocks(`<p>${input}</p>`)
    expect(plain(b[0])).toBe(expected)
  })

  it('counts decoded entities and never leaves an entity-encoded tag as markup', () => {
    const r = conv('<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp;amp; &#8220;x&#8221;</p>')
    expect(r.report.entitiesDecoded).toBe(7)
    expect(plain(r.root.children[0] as N)).toBe('<script>alert(1)</script> &amp; “x”')
  })

  it('&nbsp;-only and empty paragraphs are dropped and counted', () => {
    const r = conv('<p>&nbsp;</p><p></p><p> \n </p><p>real</p><p>&nbsp;&nbsp;</p><h2>&nbsp;</h2>')
    expect(r.root.children.map(plain)).toEqual(['real'])
    expect(r.report.emptyBlocksDropped).toBe(5)
  })

  it('an empty document converts to one empty paragraph and says so', () => {
    for (const html of ['', '   \n  ', '<p></p>', '<!-- only a comment -->']) {
      const r = conv(html)
      expect(r.root.children).toHaveLength(1)
      expect(r.report.warnings.join(' ')).toMatch(/empty/)
    }
  })

  it('stray comments and CDATA are dropped without leaking text', () => {
    const r = conv('<p>a<!-- hidden --> b<![CDATA[ leak ]]></p><!-- wp:unknown-thing --><!-- [if IE]> x <![endif]-->')
    expect(plain(r.root.children[0] as N)).not.toMatch(/hidden/)
    expect(r.report.commentsDropped).toBeGreaterThan(0)
  })
})

describe('video', () => {
  const iframe = (src: string, extra = '') => `<iframe width="560" height="315" src="${src}" ${extra} allowfullscreen></iframe>`
  const sources = [
    `https://www.youtube.com/embed/${VID}`,
    `https://www.youtube.com/embed/${VID}?feature=oembed&rel=0`,
    `//www.youtube.com/embed/${VID}?start=3`,
    `https://www.youtube-nocookie.com/embed/${VID}`,
    `https://youtu.be/${VID}`,
    `https://www.youtube.com/watch?v=${VID}&t=5`,
  ]
  it.each(sources)('iframe %s becomes a youtubeEmbed block', (src) => {
    const r = conv(`<p>before</p>${iframe(src, 'title="A talk"')}<p>after</p>`)
    expect(shape(`<p>before</p>${iframe(src)}<p>after</p>`)).toEqual(['paragraph', `yt:${VID}`, 'paragraph'])
    expect((r.root.children[1] as N).fields.title).toBe('A talk')
    expect(r.report.youtube).toBe(1)
  })

  it('an iframe inside a paragraph splits the paragraph around the block', () => {
    expect(shape(`<p>text one ${iframe(`https://youtu.be/${VID}`)} text two</p>`)).toEqual(['paragraph', `yt:${VID}`, 'paragraph'])
  })

  it('a bad video id does not produce a block (and the link fallback applies)', () => {
    const r = conv(iframe('https://www.youtube.com/embed/tooshort'))
    expect(r.root.children.every((c: N) => c.type !== 'block')).toBe(true)
    expect(r.report.embeds.linked).toHaveLength(1)
  })

  it('a title with markup or over 120 characters is not stored', () => {
    const r1 = conv(iframe(`https://youtu.be/${VID}`, 'title="&lt;b&gt;x&lt;/b&gt;"'))
    expect((r1.root.children[0] as N).fields.title).toBeUndefined()
    const r2 = conv(iframe(`https://youtu.be/${VID}`, `title="${'x'.repeat(130)}"`))
    expect((r2.root.children[0] as N).fields.title).toBeUndefined()
  })

  const other = [
    ['https://player.vimeo.example.test/video/123', true],
    ['https://www.facebook.example.test/plugins/video.php?href=x', true],
    ['http://insecure.example.test/frame', false],
    ['javascript:alert(1)', false],
    ['data:text/html,<script>alert(1)</script>', false],
    ['', false],
    ['//cdn.example.test/frame', true],
  ] as const
  it.each(other)('other iframe %s', (src, linked) => {
    const r = conv(`<p>x</p>${iframe(src)}`)
    expect(r.report.embeds.linked.length).toBe(linked ? 1 : 0)
    expect(r.report.embeds.dropped.length).toBe(linked ? 0 : 1)
    expect(JSON.stringify(r.root)).not.toMatch(/javascript:|data:text/)
    expect(r.root.children.every((c: N) => c.type !== 'block')).toBe(true)
    if (linked) expect(plain(r.root.children[1] as N)).toMatch(/^https:\/\//)
  })

  it('nested and repeated iframes are each handled', () => {
    const html = `<div><div>${iframe(`https://youtu.be/${VID}`)}<iframe src="https://youtu.be/aaaaaaaaaaa"><iframe src="https://evil.example.test/x"></iframe></iframe></div></div>`
    const r = conv(html)
    expect(r.report.youtube).toBe(2)
  })

  it('[youtube] shortcodes in every form', () => {
    const forms = [
      `[youtube https://www.youtube.com/watch?v=${VID}]`,
      `[youtube]https://youtu.be/${VID}[/youtube]`,
      `[youtube=https://youtu.be/${VID}]`,
      `[youtube id="${VID}"]`,
      `[youtube url="https://www.youtube.com/embed/${VID}"]`,
      `[embed]https://www.youtube.com/watch?v=${VID}[/embed]`,
      `[embed width="600"]https://youtu.be/${VID}[/embed]`,
      `[youtube ${VID}]`,
      `[YOUTUBE_PLACEHOLDER]`.replace('YOUTUBE_PLACEHOLDER', 'youtube https://youtu.be/' + VID),
    ]
    for (const form of forms) {
      for (const wrap of [`<p>${form}</p>`, form]) {
        expect(shape(wrap), form).toEqual([`yt:${VID}`])
      }
    }
  })

  it('a youtube shortcode with a bad id is not turned into a block', () => {
    const r = conv('<p>[youtube https://youtu.be/short]</p>')
    expect(r.root.children.every((c: N) => c.type !== 'block')).toBe(true)
    expect(JSON.stringify(r.root)).not.toContain('[youtube')
  })

  it('bare YouTube URLs on their own line', () => {
    expect(shape(`<p>https://www.youtube.com/watch?v=${VID}</p>`)).toEqual([`yt:${VID}`])
    expect(shape(`<p><a href="https://youtu.be/${VID}">https://youtu.be/${VID}</a></p>`)).toEqual([`yt:${VID}`])
    expect(shape(`Intro\n\nhttps://youtu.be/${VID}\n\nOutro`)).toEqual(['paragraph', `yt:${VID}`, 'paragraph'])
    // in the middle of a sentence it stays a link/text
    expect(shape(`<p>watch https://youtu.be/${VID} now</p>`)).toEqual(['paragraph'])
  })

  it('old object/embed markup with a YouTube source is converted', () => {
    const r = conv(`<object width="425" height="344"><param name="movie" value="https://www.youtube.com/v/${VID}"/><embed src="https://www.youtube.com/v/${VID}" type="application/x-shockwave-flash"></embed></object>`)
    expect(r.report.youtube).toBe(1)
    expect((r.root.children[0] as N).fields.videoId).toBe(VID)
  })

  it('block ids are deterministic and every block passes the real validator', () => {
    const html = `${iframe(`https://youtu.be/${VID}`)}${iframe('https://youtu.be/aaaaaaaaaaa')}`
    const a = conv(html)
    const b = conv(html)
    expect(JSON.stringify(a.root)).toBe(JSON.stringify(b.root))
    expect(findEmbedProblem(a.content)).toBeNull()
    const ids = a.root.children.map((c: N) => c.fields.id)
    expect(new Set(ids).size).toBe(2)
  })
})

describe('images', () => {
  it('a resolved image is an upload node in the accepted shape', () => {
    const r = conv('<p><img src="https://old.example.test/wp-content/uploads/2024/01/img-12.jpg" alt="x"></p>')
    expect(r.root.children).toEqual([{ type: 'upload', id: expect.stringMatching(/^[0-9a-f]{24}$/), relationTo: 'media', value: 12, version: 3, fields: null, format: '' }])
    expect(r.report.images.resolved).toBe(1)
  })

  it('passes src, alt and caption to resolveImage', () => {
    const calls: unknown[] = []
    conv('<figure><img src="img-1.jpg" alt="  An   alt "><figcaption>The <b>caption</b></figcaption></figure>', {
      resolveImage: (src, ctx) => {
        calls.push([src, ctx.alt, ctx.caption])
        return { mediaId: 1 }
      },
    })
    expect(calls).toEqual([['img-1.jpg', 'An alt', 'The caption']])
  })

  it('captions stay as a following paragraph with their formatting', () => {
    const b = blocks('<figure><img src="img-3.jpg"/><figcaption>Caption <a href="https://example.test/c">link</a></figcaption></figure>')
    expect(b.map((x) => x.type)).toEqual(['upload', 'paragraph'])
    expect(b[1].children[1].type).toBe('link')
  })

  it('an unresolved image becomes its alt text and caption, and is reported', () => {
    const r = conv('<figure><img src="https://old.example.test/missing.jpg" alt="Alt words"><figcaption>Cap words</figcaption></figure>')
    expect(r.root.children.map(plain)).toEqual(['Alt words', 'Cap words'])
    expect(r.report.images.unresolved).toEqual([{ src: 'https://old.example.test/missing.jpg', reason: 'resolveImage returned no media' }])
    // alt equal to the caption is not repeated; no text at all leaves only the report
    expect(conv('<figure><img src="missing.jpg" alt="Same"><figcaption>Same</figcaption></figure>').root.children.map(plain)).toEqual(['Same'])
    const none = conv('<p>text</p><img src="missing.jpg">')
    expect(none.root.children.map(plain)).toEqual(['text'])
    expect(none.report.images.unresolved).toHaveLength(1)
  })

  it('lazy-loaded and srcset images are read, data: and javascript: sources are never resolved', () => {
    const seen: string[] = []
    const resolveImage = (src: string) => {
      seen.push(src)
      return null
    }
    conv('<img data-src="lazy-1.jpg" src="data:image/gif;base64,R0lGOD"><img srcset="set-2.jpg 1x, set-3.jpg 2x"><img src="data:image/png;base64,AAAA"><img src="javascript:alert(1)">', { resolveImage })
    expect(seen).toEqual(['lazy-1.jpg', 'set-2.jpg'])
  })

  it('a resolver that throws or returns a bad id counts as unresolved', () => {
    for (const bad of [() => { throw new Error('boom') }, () => ({ mediaId: 0 }), () => ({ mediaId: 1.5 }), () => ({ mediaId: 2147483648 }), () => ({ mediaId: '3' as unknown as number })]) {
      const r = conv('<img src="a.jpg" alt="x">', { resolveImage: bad })
      expect(r.report.images.unresolved).toHaveLength(1)
      expect(JSON.stringify(r.root)).not.toContain('"upload"')
    }
  })

  it('an image wrapped in a link keeps the image and drops the link wrapper', () => {
    expect(shape('<p><a href="https://example.test/big.jpg"><img src="img-2.jpg"/></a></p>')).toEqual(['upload:2'])
  })
})

describe('tables', () => {
  const cell = (c: N) => ({ hs: c.headerState, cs: c.colSpan, rs: c.rowSpan, text: plain(c) })

  it('thead th gives headerState 1, body cells 0, standard shape', () => {
    const r = conv('<table><thead><tr><th>Parish</th><th>Members</th></tr></thead><tbody><tr><td>St Example</td><td>120</td></tr></tbody></table>')
    const t = r.root.children[0] as N
    expect(t).toMatchObject({ type: 'table', version: 1 })
    expect(t.children.map((row: N) => row.type)).toEqual(['tablerow', 'tablerow'])
    expect(t.children[0].children.map(cell)).toEqual([{ hs: 1, cs: 1, rs: 1, text: 'Parish' }, { hs: 1, cs: 1, rs: 1, text: 'Members' }])
    expect(t.children[1].children.map((c: N) => c.headerState)).toEqual([0, 0])
    expect(t.children[1].children[0]).toMatchObject({ type: 'tablecell', version: 1, backgroundColor: null })
    expect(t.children[1].children[0].children[0].type).toBe('paragraph')
  })

  it('first row of th without thead is a header row', () => {
    const t = blocks('<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>')[0]
    expect(t.children[0].children.map((c: N) => c.headerState)).toEqual([1, 1])
  })

  it('first-column th is 2 and the corner cell is 3', () => {
    const t = blocks('<table><thead><tr><th>Corner</th><th>Col</th></tr></thead><tbody><tr><th>Row 1</th><td>a</td></tr><tr><th>Row 2</th><td>b</td></tr></tbody></table>')[0]
    expect(t.children.map((r: N) => r.children.map((c: N) => c.headerState))).toEqual([[3, 1], [2, 0], [2, 0]])
  })

  it('colSpan and rowSpan are kept (capped at 20) and ragged rows are padded', () => {
    const t = blocks('<table><tr><td colspan="2">wide</td><td rowspan="2">tall</td></tr><tr><td>a</td><td>b</td></tr><tr><td colspan="99">huge</td></tr><tr><td>solo</td></tr></table>')[0]
    expect(t.children[0].children.slice(0, 2).map(cell).map((c: N) => [c.cs, c.rs])).toEqual([[2, 1], [1, 2]])
    expect(t.children[1].children.slice(0, 2).map((c: N) => plain(c))).toEqual(['a', 'b'])
    expect(t.children[2].children[0].colSpan).toBe(20)
    // every row is padded to the grid width (20 columns, the widest row), minus slots covered by a span
    expect(t.children[3].children).toHaveLength(20)  })

  it('cells keep links, formatting and images; headings become paragraphs; lists become paragraphs', () => {
    const t = blocks('<table><tr><td><b>bold</b> <a href="https://example.test/x">l</a></td><td><img src="img-4.jpg"></td><td><h3>H</h3><ul><li>x</li><li>y</li></ul></td></tr></table>')[0]
    const [a, b, c] = t.children[0].children
    expect(a.children[0].children.map((n: N) => n.type)).toEqual(['text', 'text', 'link'])
    expect(b.children[0].type).toBe('upload')
    expect(c.children.map((n: N) => n.type)).toEqual(['paragraph', 'paragraph', 'paragraph'])
  })

  it('a table caption is kept as a paragraph before the table', () => {
    expect(shape('<table><caption>Numbers</caption><tr><td>1</td></tr></table>')).toEqual(['paragraph', 'table'])
  })

  it('tables of more than 100 rows or 20 columns are flattened to paragraphs and reported', () => {
    const rows = Array.from({ length: 101 }, (_, i) => `<tr><td>r${i}</td><td>v</td></tr>`).join('')
    const r = conv(`<table>${rows}</table>`)
    expect(r.root.children).toHaveLength(101)
    expect(plain(r.root.children[0] as N)).toBe('r0 | v')
    expect(r.report.tables.flattened).toEqual([{ reason: 'more than 100 rows' }])
    const wide = conv(`<table><tr>${'<td>c</td>'.repeat(21)}</tr></table>`)
    expect(wide.report.tables.flattened[0].reason).toMatch(/columns/)
    expect(wide.root.children[0].type).toBe('paragraph')
    const spanWide = conv('<table><tr><td colspan="15">a</td><td colspan="15">b</td></tr></table>')
    expect(spanWide.report.tables.flattened).toHaveLength(1)
  })

  it('nested tables are flattened inside the cell', () => {
    const r = conv('<table><tr><td>outer<table><tr><td>in1</td><td>in2</td></tr></table></td></tr></table>')
    const t = r.root.children[0] as N
    expect(plain(t)).toContain('in1 | in2')
    expect(r.report.tables.flattened).toEqual([{ reason: 'nested table inside a table cell' }])
  })

  it('empty tables are dropped', () => {
    const r = conv('<p>a</p><table></table><table><tr></tr></table>')
    expect(r.root.children).toHaveLength(1)
  })
})

describe('links, shortcodes, schemes', () => {
  it('unsafe and unknown schemes become plain text', () => {
    const hrefs = [
      'javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)', 'jav&#x09;ascript:alert(1)',
      'data:text/html;base64,AAAA', 'vbscript:msgbox(1)', 'ftp://files.example.test/x', 'tel:+100000', 'file:///etc/passwd',
      '//evil.example.test/x', '#anchor', 'relative/path', '', 'https://user:pass@example.test/x', 'https://exa mple.test',
    ]
    for (const href of hrefs) {
      const r = conv(`<p>before <a href="${href}">LINKTEXT</a> after</p>`)
      expect(JSON.stringify(r.root), href).not.toMatch(/"type":"link"/)
      expect(plain(r.root.children[0] as N), href).toBe('before LINKTEXT after')
    }
  })

  it('links to the old site are rewritten through the slug map and reported when unmapped', () => {
    const r = conv('<p><a href="https://old.example.test/my-post/">a</a> <a href="https://www.old.example.test/unknown-post/">b</a> <a href="https://old.example.test/category/news/">c</a> <a href="https://old.example.test/?p=12">d</a></p>')
    const urls = (r.root.children[0] as N).children.filter((c: N) => c.type === 'link').map((c: N) => c.fields.url)
    expect(urls[0]).toBe('/article/my-post-2')
    expect(r.report.links.rewritten).toBe(1)
    expect(r.report.links.unmapped.map((u) => u.reason)).toHaveLength(3)
  })

  it('articlePath is configurable', () => {
    const r = conv('<p><a href="https://old.example.test/harvest-news/">a</a></p>', { articlePath: (s) => `/news/${s}` })
    expect((r.root.children[0] as N).children[0].fields.url).toBe('/news/harvest-news')
  })

  it('shortcodes are removed and listed; look-alikes in the copy stay', () => {
    const r = conv('<p>Text [gallery ids="1,2,3"] more [contact-form-7 id="5"] and [sic] and [Video] and [1].</p><p>[penci_slider id="3"]</p>')
    expect(plain(r.root.children[0] as N)).toBe('Text more and [sic] and [Video] and [1].')
    expect(r.report.shortcodesRemoved).toEqual({ gallery: 1, 'contact-form-7': 1, penci_slider: 1 })
    expect(r.root.children).toHaveLength(1) // the second paragraph became empty
  })

  it('extra known shortcodes can be supplied', () => {
    const r = conv('<p>a [custom_box] b</p>', { knownShortcodes: ['custom_box'] })
    expect(plain(r.root.children[0] as N)).toBe('a b')
  })

  it('a shortcode pair split across elements is removed at both ends', () => {
    const r = conv('<p>[box type="x"]<strong>inside</strong> text</p><p>more[/box]</p>')
    expect(r.root.children.map(plain)).toEqual(['inside text', 'more'])
  })

  it('attributes never carry over: no style, class, onerror, srcdoc', () => {
    const r = conv('<p style="x" onclick="a()" class="c" data-x="1">t<img src="img-1.jpg" onerror="alert(1)"></p>')
    const json = JSON.stringify(r.root)
    expect(json).not.toMatch(/onclick|onerror|alert|"class"/)
  })
})

describe('limits', () => {
  it('rejects input above the limit', () => {
    expect(() => htmlToLexical('x'.repeat(101), baseOptions({ maxInputBytes: 100 }))).toThrow(HtmlConversionError)
    expect(() => htmlToLexical('<p>é</p>'.repeat(30), baseOptions({ maxInputBytes: 100 }))).toThrow(/limit/)
    // default limit is 5 MB
    expect(() => htmlToLexical('a'.repeat(5 * 1024 * 1024 + 1), baseOptions())).toThrow(HtmlConversionError)
  })

  it('rejects output above the node limit, never truncating silently', () => {
    const html = '<p>x</p>'.repeat(60)
    expect(() => htmlToLexical(html, baseOptions({ maxNodes: 50 }))).toThrowError(/nodes/)
    try {
      htmlToLexical(html, baseOptions({ maxNodes: 50 }))
    } catch (e) {
      expect((e as HtmlConversionError).code).toBe('too-many-nodes')
    }
  })

  it.each(['div', 'blockquote', 'span', 'b', 'ul', 'ol', 'section', 'figure', 'i', 'em', 'center'])(
    '10,000-deep <%s> nesting is refused quickly, never parsed or silently accepted',
    (tag) => {
      const html = `${`<${tag}>`.repeat(10_000)}deep text${`</${tag}>`.repeat(10_000)}<p>after</p>`
      const started = Date.now()
      expect(() => htmlToLexical(html, baseOptions())).toThrowError(HtmlConversionError)
      try {
        htmlToLexical(html, baseOptions())
      } catch (e) {
        expect((e as HtmlConversionError).code).toBe('too-deep')
      }
      expect(Date.now() - started).toBeLessThan(2000)
    },
  )

  it('10,000 unclosed tags, deep lists and nested Gutenberg blocks are refused too', () => {
    for (const html of [
      '<div><p><b>'.repeat(10_000),
      `${'<ul><li>x'.repeat(10_000)}${'</li></ul>'.repeat(10_000)}`,
      `${'<!-- wp:group --><div>'.repeat(10_000)}t${'</div><!-- /wp:group -->'.repeat(10_000)}`,
      // stray end tags and raw-text elements must not hide the depth
      `${'<div>'.repeat(300)}</span></span><script></div></div></div></script>${'<div>'.repeat(300)}x`,
    ]) {
      expect(() => htmlToLexical(html, baseOptions())).toThrowError(/nests elements|deep/)
    }
  })

  it.each(['div', 'blockquote', 'span', 'b', 'ul', 'ol', 'table', 'section', 'figure'])(
    '300-deep <%s> nesting (past the 64 level limit) is flattened to text, reported, and valid',
    (tag) => {
      const html = `${`<${tag}>`.repeat(300)}deep text${`</${tag}>`.repeat(300)}<p>after</p>`
      const r = conv(html)
      expect(plain(r.root)).toContain('after')
      if (tag !== 'table') expect(r.report.deepNestingFlattened + r.report.listsFlattened).toBeGreaterThan(0)
    },
  )

  it('deep list items and Gutenberg group blocks within the parse limit are flattened', () => {
    const lists = conv(`${'<ul><li>x'.repeat(200)}${'</li></ul>'.repeat(200)}`)
    expect(plain(lists.root)).toContain('x')
    const groups = conv(`${'<!-- wp:group --><div>'.repeat(200)}t${'</div><!-- /wp:group -->'.repeat(200)}`)
    expect(plain(groups.root)).toContain('t')
  })

  it('deeply nested lists and blockquotes stay within the body depth rule', () => {
    const lists = `${'<ul><li>x'.repeat(200)}${'</li></ul>'.repeat(200)}`
    const r = conv(lists)
    expect(plain(r.root)).toContain('x')
    const quotes = conv(`${'<blockquote>'.repeat(300)}text${'</blockquote>'.repeat(300)}`)
    expect(plain(quotes.root)).toBe('text')
  })

  it('text exactly at the depth boundary is kept', () => {
    const html = `${'<div>'.repeat(63)}kept${'</div>'.repeat(63)}`
    expect(plain(conv(html).root)).toBe('kept')
  })

  it('maxDepth can be lowered but not raised above 64', () => {
    const html = `${'<div>'.repeat(10)}t${'</div>'.repeat(10)}`
    expect(conv(html, { maxDepth: 3 }).report.deepNestingFlattened).toBe(1)
    expect(conv(`${'<div>'.repeat(70)}t${'</div>'.repeat(70)}`, { maxDepth: 1000 }).report.deepNestingFlattened).toBe(1)
  })

  it('a huge table is flattened and a huge flat document converts', () => {
    const rows = Array.from({ length: 3000 }, (_, i) => `<tr><td>${i}</td></tr>`).join('')
    const r = conv(`<table>${rows}</table>`, { maxNodes: 100_000 })
    expect(r.report.tables.flattened).toHaveLength(1)
    const many = conv('<p>word</p>'.repeat(2000))
    expect(many.root.children).toHaveLength(2000)
  })
})

describe('adversarial input', () => {
  const cases: [string, string][] = [
    ['script tag', '<p>a</p><script>alert(1)</script><p>b</p>'],
    ['script in attribute', '<p title="<script>alert(1)</script>">a</p>'],
    ['onerror', '<img src=x onerror=alert(1)>'],
    ['onload svg', '<svg onload=alert(1)><circle/></svg><p>a</p>'],
    ['javascript link', '<a href="javascript:alert(1)">x</a>'],
    ['javascript link entity-encoded', '<a href="&#106;avascript:alert(1)">x</a>'],
    ['data link', '<a href="data:text/html,<script>alert(1)</script>">x</a>'],
    ['nested iframes', '<iframe src="https://a.example.test"><iframe src="javascript:alert(1)"></iframe></iframe>'],
    ['srcdoc iframe', '<iframe srcdoc="<script>alert(1)</script>"></iframe>'],
    ['malformed tags', '<p<b>>text</b></p><div<<a>>x'],
    ['unclosed everything', '<div><p><b><i><a href="https://example.test">text'],
    ['stray close tags', '</div></p></b></table></td>text</li></ul>'],
    ['null bytes', '<p>a\u0000b</p><p>c\u0000</p><a href="java\u0000script:alert(1)">x</a>'],
    ['control characters', '<p>a\u0001\u0002\u0007b​</p>'],
    ['CDATA', '<p><![CDATA[<script>alert(1)</script>]]></p>'],
    ['comment tricks', '<!--><p>x</p><!---><!-- --!><p>y</p>'],
    ['conditional comments', '<!--[if gte mso 9]><xml><o:p></o:p></xml><![endif]--><p>z</p>'],
    ['style expression', '<p style="width:expression(alert(1))">x</p><style>@import url(javascript:alert(1))</style>'],
    ['base and meta refresh', '<base href="https://evil.example.test/"><meta http-equiv="refresh" content="0;url=javascript:alert(1)"><p>x</p>'],
    ['form with button', '<form action="https://evil.example.test"><input name=a><button>go</button></form>'],
    ['template and noscript', '<template><script>alert(1)</script></template><noscript><img src=x onerror=alert(1)></noscript>'],
    ['object data', '<object data="javascript:alert(1)"></object><embed src="javascript:alert(1)">'],
    ['mxss namespace', '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>'],
    ['table in weird places', '<td>stray cell</td><tr><th>head</th></tr><tbody>x</tbody>'],
    ['huge attribute', `<a href="https://example.test/${'a'.repeat(100_000)}">x</a>`],
    ['long url shortcode', `[youtube ${'a'.repeat(50_000)}]`],
    ['uppercase tags', '<P>A</P><H2>B</H2><UL><LI>C</LI></UL><IFRAME SRC="https://youtu.be/dQw4w9WgXcQ"></IFRAME>'],
    ['bidi and rtl', '<p>‮evil‬ text</p>'],
    ['comment with block marker inside text', '<p>--><!-- wp:html --></p>'],
    ['blocks with huge json', `<!-- wp:paragraph {"a":"${'x'.repeat(50_000)}"} --><p>t</p><!-- /wp:paragraph -->`],
    ['mismatched block names', '<!-- wp:list --><ul><li>a</li></ul><!-- /wp:paragraph -->'],
    ['block nesting storm', `${'<!-- wp:group -->'.repeat(500)}<p>x</p>${'<!-- /wp:group -->'.repeat(500)}`],
  ]
  it.each(cases)('%s', (_label, html) => {
    const r = conv(html)
    const json = JSON.stringify(r.content)
    expect(json).not.toMatch(/<script|<iframe|onerror|onload|srcdoc|"type":"embed"/i)
    expect(json).not.toMatch(/"(url|href|src)":"\s*(javascript|data|vbscript):/i)
  })

  it('null bytes never survive in any string', () => {
    expect(JSON.stringify(conv('<p>a\u0000b</p>').content)).not.toContain('\\u0000')
    expect(plain(conv('<p>a\u0000b</p>').root)).toBe('ab')
  })

  it('never throws on arbitrary garbage', () => {
    const junk = ['<', '<<<<', '&', '&#', '&#x', '<!--', '<![CDATA[', '<p', '<a href=', '\u0000\u0000', '\uD800', '<p>\uDC00</p>', '[', '[[[youtube', '<!-- wp:', '<!-- wp:x {', '</>', '<>', '<a href="']
    for (const j of junk) expect(() => conv(j), j).not.toThrow()
    expect(() => htmlToLexical(undefined as unknown as string, baseOptions())).not.toThrow()
  })
})
