/**
 * Synthetic corpus for the HTML to Lexical converter: invented text only, `example.test` hosts, no real content.
 * Each article is built from fragments rendered either as Gutenberg block markup or as classic-editor HTML, together
 * with the exact sequence of top-level Lexical node kinds the converter must produce and the words that must survive.
 */

export type Kind = 'heading' | 'paragraph' | 'list' | 'upload' | 'block' | 'table' | 'quote'
export type SyntheticArticle = {
  id: string
  mode: 'classic' | 'gutenberg' | 'mixed'
  html: string
  expectKinds: Kind[]
  expectWords: string[]
  expectUploads: number[]
  expectYoutube: string[]
}

type Fragment = {
  render: (style: 'g' | 'c', bare: boolean) => string
  kinds: Kind[]
  words: string[]
  uploads?: number[]
  youtube?: string[]
}

const WORDS = ['harvest', 'lantern', 'meadow', 'chorus', 'parish', 'orchard', 'granite', 'willow', 'ember', 'quill', 'saffron', 'tundra', 'velvet', 'zephyr', 'cobalt', 'thistle']
const YT = ['dQw4w9WgXcQ', 'aaaaaaaaaaa', 'A-_0aZ9-_zz', 'xX12345_-Yz']

// small seeded generator (mulberry32) so the corpus is identical on every run
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const phrase = (r: () => number, n: number, tag: string): string =>
  Array.from({ length: n }, (_, i) => `${WORDS[Math.floor(r() * WORDS.length)]}${tag}${i}`).join(' ')

function fragments(r: () => number, n: number): Fragment {
  const tag = `q${n}`
  const kind = Math.floor(r() * 14)
  const text = phrase(r, 4, tag)
  switch (kind) {
    case 0:
      return {
        kinds: ['heading'], words: [text],
        render: (s) => (s === 'g' ? `<!-- wp:heading -->\n<h2 class="wp-block-heading">${text}</h2>\n<!-- /wp:heading -->` : `<h2>${text}</h2>`),
      }
    case 1:
      return {
        kinds: ['heading'], words: [text],
        render: (s) => (s === 'g' ? `<!-- wp:heading {"level":3} -->\n<h3 class="wp-block-heading">${text}</h3>\n<!-- /wp:heading -->` : `<h3>${text}</h3>`),
      }
    case 2:
    case 3:
    case 4:
      return {
        kinds: ['paragraph'], words: [text, `&amp;`.length ? 'fish & chips' : ''],
        render: (s, bare) => {
          const inner = `${text} &#8220;quoted&#8221; fish &amp; chips <strong>${phrase(r, 1, `${tag}b`)}</strong> and <a href="https://example.test/${tag}">link${tag}</a>.`
          return s === 'g' ? `<!-- wp:paragraph -->\n<p>${inner}</p>\n<!-- /wp:paragraph -->` : bare ? inner : `<p>${inner}</p>`
        },
      }
    case 5: {
      const items = [phrase(r, 2, `${tag}i`), phrase(r, 2, `${tag}j`), phrase(r, 2, `${tag}k`)]
      const ordered = r() < 0.5
      return {
        kinds: ['list'], words: items,
        render: (s) => {
          const t = ordered ? 'ol' : 'ul'
          const body = `<${t}>${items.map((i) => `<li>${i}</li>`).join('')}</${t}>`
          return s === 'g' ? `<!-- wp:list ${ordered ? '{"ordered":true}' : ''} -->\n${body}\n<!-- /wp:list -->` : body
        },
      }
    }
    case 6: {
      const id = 100 + n
      const caption = phrase(r, 3, `${tag}c`)
      const withCaption = r() < 0.5
      return {
        kinds: withCaption ? ['upload', 'paragraph'] : ['upload'], words: withCaption ? [caption] : [], uploads: [id],
        render: (s, bare) => {
          const img = `<img src="https://old.example.test/wp-content/uploads/2024/05/img-${id}-300x200.jpg" alt="alt ${tag}" class="wp-image-${id}"/>`
          if (s === 'g') {
            return `<!-- wp:image {"id":${id}} -->\n<figure class="wp-block-image">${img}${withCaption ? `<figcaption>${caption}</figcaption>` : ''}</figure>\n<!-- /wp:image -->`
          }
          if (withCaption) return `<p>[caption id="attachment_${id}" align="alignnone" width="300"]${img} ${caption}[/caption]</p>`
          return bare ? `<p>${img}</p>` : `<p>${img}</p>`
        },
      }
    }
    case 7: {
      const ids = [200 + n, 300 + n, 400 + n]
      return {
        kinds: ['upload', 'upload', 'upload'], words: [], uploads: ids,
        render: (s) => {
          const imgs = ids.map((i) => `<img src="img-${i}.jpg" alt="g${i}"/>`)
          return s === 'g'
            ? `<!-- wp:gallery -->\n<figure class="wp-block-gallery">${imgs.map((i) => `<!-- wp:image -->\n<figure class="wp-block-image">${i}</figure>\n<!-- /wp:image -->`).join('\n')}</figure>\n<!-- /wp:gallery -->`
            : `<p>${imgs.join(' ')}</p>`
        },
      }
    }
    case 8: {
      const id = YT[Math.floor(r() * YT.length)]
      const variant = Math.floor(r() * 5)
      return {
        kinds: ['block'], words: [], youtube: [id],
        render: (s) => {
          if (s === 'g') {
            return `<!-- wp:embed {"url":"https://www.youtube.com/watch?v=${id}","type":"video","providerNameSlug":"youtube"} -->\n<figure class="wp-block-embed"><div class="wp-block-embed__wrapper">\nhttps://www.youtube.com/watch?v=${id}\n</div></figure>\n<!-- /wp:embed -->`
          }
          switch (variant) {
            case 0: return `<p><iframe width="560" height="315" src="https://www.youtube.com/embed/${id}?feature=oembed" frameborder="0" allowfullscreen></iframe></p>`
            case 1: return `<p>https://youtu.be/${id}</p>`
            case 2: return `<p>[youtube https://www.youtube.com/watch?v=${id}]</p>`
            case 3: return `<p><iframe src="//www.youtube-nocookie.com/embed/${id}"></iframe></p>`
            default: return `<p>[embed]https://www.youtube.com/watch?v=${id}[/embed]</p>`
          }
        },
      }
    }
    case 9: {
      const cells = [phrase(r, 1, `${tag}h1`), phrase(r, 1, `${tag}h2`), phrase(r, 1, `${tag}d1`), phrase(r, 1, `${tag}d2`)]
      return {
        kinds: ['table'], words: cells,
        render: (s) => {
          const t = `<table><thead><tr><th>${cells[0]}</th><th>${cells[1]}</th></tr></thead><tbody><tr><td>${cells[2]}</td><td colspan="1">${cells[3]}</td></tr></tbody></table>`
          return s === 'g' ? `<!-- wp:table -->\n<figure class="wp-block-table">${t}</figure>\n<!-- /wp:table -->` : t
        },
      }
    }
    case 10:
      return {
        kinds: ['quote'], words: [text],
        render: (s) =>
          s === 'g'
            ? `<!-- wp:quote -->\n<blockquote class="wp-block-quote"><p>${text}</p></blockquote>\n<!-- /wp:quote -->`
            : `<blockquote><p>${text}</p></blockquote>`,
      }
    case 11:
      return {
        kinds: [], words: [],
        render: (s) => (s === 'g' ? '<!-- wp:paragraph -->\n<p>&nbsp;</p>\n<!-- /wp:paragraph -->' : '<p>&nbsp;</p>'),
      }
    case 12:
      return {
        kinds: [], words: [],
        render: (s) => (s === 'g' ? '<!-- wp:shortcode -->\n[contact-form-7 id="12" title="Contact form"]\n<!-- /wp:shortcode -->' : '<p>[contact-form-7 id="12" title="Contact form"]</p>'),
      }
    default:
      return {
        kinds: ['paragraph', 'paragraph'], words: [`before${tag}`, `after${tag}`],
        render: (s) =>
          s === 'g'
            ? `<!-- wp:paragraph -->\n<p>before${tag}</p>\n<!-- /wp:paragraph -->\n\n<!-- wp:more -->\n<!--more-->\n<!-- /wp:more -->\n\n<!-- wp:paragraph -->\n<p>after${tag}</p>\n<!-- /wp:paragraph -->`
            : `<p>before${tag}</p>\n<!--more-->\n<p>after${tag}</p>`,
      }
  }
}

export function buildCorpus(count = 48): SyntheticArticle[] {
  const out: SyntheticArticle[] = []
  for (let i = 0; i < count; i++) {
    const r = rng(7919 * (i + 1))
    const mode = (['classic', 'gutenberg', 'mixed'] as const)[i % 3]
    const size = 4 + Math.floor(r() * 7)
    const parts: string[] = []
    const expectKinds: Kind[] = []
    const expectWords: string[] = []
    const expectUploads: number[] = []
    const expectYoutube: string[] = []
    for (let j = 0; j < size; j++) {
      const frag = fragments(r, i * 100 + j)
      const style: 'g' | 'c' = mode === 'gutenberg' ? 'g' : mode === 'classic' ? 'c' : r() < 0.5 ? 'g' : 'c'
      // bare (no <p>) classic text only where nothing else could be confused: pure classic documents
      parts.push(frag.render(style, mode === 'classic' && r() < 0.6))
      expectKinds.push(...frag.kinds)
      expectWords.push(...frag.words.filter(Boolean))
      expectUploads.push(...(frag.uploads ?? []))
      expectYoutube.push(...(frag.youtube ?? []))
    }
    out.push({
      id: `synthetic-${String(i + 1).padStart(2, '0')}`,
      mode,
      html: parts.join(mode === 'classic' ? '\n\n' : '\n\n'),
      expectKinds,
      expectWords,
      expectUploads,
      expectYoutube,
    })
  }
  return out
}
