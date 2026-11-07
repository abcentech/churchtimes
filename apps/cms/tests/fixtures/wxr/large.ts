/**
 * LARGE synthetic WXR for rehearsals and process-level tests. Deterministic (seeded), generated on demand, never
 * stored in the repository. Every name, word and address is invented (example.test). Nasty inputs on purpose: nested
 * blocks, entities, scripts, shortcodes, password and draft posts, duplicate slugs, non-ASCII slugs, threaded comments,
 * spam, email-shaped text.
 */
import { wxr, type FixtureComment, type FixtureItem } from './generate'

export type LargeOptions = {
  posts: number
  /** Distinct image files (each used by many posts). */
  images: number
  /** First WordPress id used (posts, attachments and comments count up from here). */
  idBase: number
  /** Prefix for slugs and categories, so a shared database can tell the rows apart. */
  prefix: string
  seed?: number
  /** Comments per post are 0..maxComments-1 (default 5). */
  maxComments?: number
}

export const IMAGE_DIR = '2097/05'
export const imageName = (n: number): string => `img-${n}.png`

/** mulberry32 */
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

const WORDS = 'church community grace service parish bishop nigeria youth prayer synod choir harvest outreach school clinic festival'.split(' ')
const NON_ASCII = ['słuchaj', '日本語', 'señor-ñandú', 'ελληνικά', 'ọmọ-ìyá', 'emoji-🙂']

export type LargeExport = { xml: string; expected: { importablePosts: number; passwordPosts: number; draftPosts: number; attachments: number } }

export function largeWxr(o: LargeOptions): LargeExport {
  const rand = rng(o.seed ?? 20261021)
  const pick = <T,>(a: readonly T[]): T => a[Math.floor(rand() * a.length)]
  const sentence = () => Array.from({ length: 6 + Math.floor(rand() * 8) }, () => pick(WORDS)).join(' ') + '.'
  const cats = Array.from({ length: 12 }, (_, i) => ({ nicename: `${o.prefix}-cat-${i}`, name: `${o.prefix} Section ${i} &amp; more` }))
  const items: FixtureItem[] = []
  const host = 'https://old.example.test/wp-content/uploads'
  let nextId = o.idBase
  let commentId = o.idBase + 5_000_000
  let importable = 0
  let password = 0
  let draft = 0

  // Attachments: one per image, used as featured images and in bodies.
  const attachmentIds: number[] = []
  for (let n = 0; n < o.images; n++) {
    const id = nextId++
    attachmentIds.push(id)
    items.push({
      id,
      postType: 'attachment',
      status: 'inherit',
      slug: `${o.prefix}-att-${n}`,
      attachmentUrl: `${host}/${IMAGE_DIR}/${imageName(n)}`,
      meta: { _wp_attached_file: `${IMAGE_DIR}/${imageName(n)}`, _wp_attachment_image_alt: `Synthetic picture ${n}` },
    })
  }

  for (let i = 0; i < o.posts; i++) {
    const id = nextId++
    const img = Math.floor(rand() * o.images)
    const kind = i % 53 === 0 ? 'password' : i % 41 === 0 ? 'draft' : 'normal'
    let slug = `${o.prefix}-story-${i}`
    if (i % 25 === 0) slug = `${o.prefix}-dup-${i % 7}` // several posts share these
    else if (i % 17 === 0) slug = `${o.prefix}-${pick(NON_ASCII)}-${i}`
    else if (i % 61 === 0) slug = '' // no slug at all: derived from the title

    const paragraphs = Array.from({ length: 3 + Math.floor(rand() * 5) }, () => `<p>${sentence()} ${sentence()}</p>`).join('\n')
    const parts: string[] = [paragraphs]
    parts.push(`<p><img src="${host}/${IMAGE_DIR}/${imageName(img)}" alt="Synthetic picture ${img}" width="300" height="200"></p>`)
    if (i % 3 === 0) parts.push(`<p><img src="${host}/${IMAGE_DIR}/${imageName((img + 1) % o.images)}-300x200.png" alt=""></p>`)
    if (i % 5 === 0) parts.push(`[caption id="attachment_${attachmentIds[img]}" align="aligncenter" width="300"]<img src="${host}/${IMAGE_DIR}/${imageName(img)}" alt="cap"> A caption &amp; credit[/caption]`)
    if (i % 7 === 0) parts.push(`[gallery ids="${attachmentIds[img]},${attachmentIds[(img + 1) % o.images]}"]`)
    if (i % 11 === 0) parts.push('[embed]https://www.youtube.com/watch?v=dQw4w9WgXcQ[/embed]', '[unknown_shortcode foo="bar"]inner[/unknown_shortcode]')
    if (i % 13 === 0) {
      // Nested Gutenberg blocks, deeper than most editors produce.
      let open = ''
      let close = ''
      for (let d = 0; d < 8; d++) {
        open += `<!-- wp:group {"layout":{"type":"constrained"}} --><div class="wp-block-group">`
        close = `</div><!-- /wp:group -->` + close
      }
      parts.push(`${open}<!-- wp:columns --><div class="wp-block-columns"><!-- wp:column --><div class="wp-block-column"><p>${sentence()}</p></div><!-- /wp:column --></div><!-- /wp:columns -->${close}`)
    }
    if (i % 9 === 0) parts.push(`<p>Entities: &amp;amp; &#8217; &#x2014; &lt;b&gt;not bold&lt;/b&gt; &nbsp; caf&eacute; &copy; 2023</p>`)
    if (i % 19 === 0) parts.push('<script>alert("synthetic")</script><iframe src="https://evil.example.test/x"></iframe><p onclick="x()">Handler</p>')
    if (i % 23 === 0) parts.push('<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>')
    if (i % 29 === 0) parts.push(`<p><a href="https://old.example.test/${o.prefix}-story-${Math.max(0, i - 1)}/">sister</a> <a href="javascript:alert(1)">bad link</a></p>`)

    const comments: FixtureComment[] = []
    const nComments = Math.floor(rand() * (o.maxComments ?? 5))
    for (let c = 0; c < nComments; c++) {
      const cid = commentId++
      comments.push({
        id: cid,
        parent: c > 0 && rand() < 0.4 ? commentId - 2 : undefined,
        author: c % 4 === 3 ? 'someone@mail.example.test' : `Synthetic Commenter ${c}`,
        content: c % 4 === 3 ? `Write to me@mail.example.test about this. ${sentence()}` : sentence(),
        approved: c % 5 === 4 ? 'spam' : c % 7 === 6 ? '0' : '1',
      })
    }

    if (kind === 'normal') importable++
    else if (kind === 'password') password++
    else draft++
    items.push({
      id,
      slug,
      title: i % 6 === 0 ? `Synthetic story ${i} &amp; the &quot;quoted&quot; &#8217;s title` : `Synthetic story ${i}`,
      status: kind === 'draft' ? 'draft' : 'publish',
      password: kind === 'password' ? 'synthetic-secret' : undefined,
      categories: [cats[i % cats.length]],
      content: parts.join('\n'),
      excerpt: i % 4 === 0 ? `<p>${sentence()}</p>` : '',
      meta: i % 3 === 0 ? { _thumbnail_id: String(attachmentIds[img]), rank_math_title: i % 2 ? 'Title %sitename%' : 'A search title', rank_math_description: sentence() } : {},
      comments,
    })
  }
  return {
    xml: wxr(items, { channelCategories: cats.map((c, i) => ({ id: 100 + i, nicename: c.nicename, name: c.name })) }),
    expected: { importablePosts: importable, passwordPosts: password, draftPosts: draft, attachments: o.images },
  }
}
