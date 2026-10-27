import { type HtmlToLexicalOptions, htmlToLexical } from '../../src/import/htmlToLexical'
import { BODY_MAX_DEPTH, findEmbedProblem } from '../../src/lib/lexicalEmbeds'
import { collectUploadNodes } from '../../src/lib/lexicalMedia'

export type N = Record<string, any>

/** `img-7.jpg` resolves to media 7; anything else does not resolve. */
export const resolveImage: HtmlToLexicalOptions['resolveImage'] = (src) => {
  const m = /img-(\d+)(?:-\d+x\d+)?\./.exec(src)
  return m ? { mediaId: Number(m[1]) } : null
}

export const baseOptions = (over: Partial<HtmlToLexicalOptions> = {}): HtmlToLexicalOptions => ({
  oldHosts: ['old.example.test'],
  slugMap: { 'harvest-news': 'harvest-news', 'my-post': 'my-post-2' },
  resolveImage,
  articleTitle: 'A synthetic article',
  ...over,
})

export const ALLOWED_TYPES = new Set([
  'root', 'paragraph', 'heading', 'quote', 'list', 'listitem', 'link', 'text', 'linebreak', 'upload', 'block',
  'table', 'tablerow', 'tablecell',
])

export function jsonDepth(value: unknown): number {
  let max = 0
  const stack: [unknown, number][] = [[value, 0]]
  while (stack.length > 0) {
    const [v, d] = stack.pop() as [unknown, number]
    if (d > max) max = d
    if (v !== null && typeof v === 'object') for (const c of Object.values(v as object)) stack.push([c, d + 1])
  }
  return max
}

/** Everything the CMS (and the public renderer) require of a converted body. */
export function assertValidBody(content: { root: N }): void {
  const problem = findEmbedProblem(content)
  if (problem) throw new Error(`embed validator: ${problem}`)
  if (jsonDepth(content) > BODY_MAX_DEPTH) throw new Error('body deeper than BODY_MAX_DEPTH')
  const stack: N[] = [content.root]
  while (stack.length > 0) {
    const n = stack.pop() as N
    if (!ALLOWED_TYPES.has(n.type)) throw new Error(`unexpected node type ${n.type}`)
    if (n.type === 'heading' && !['h2', 'h3', 'h4'].includes(n.tag)) throw new Error(`bad heading ${n.tag}`)
    if (n.type === 'text' && (typeof n.text !== 'string' || n.text === '')) throw new Error('empty or invalid text node')
    if (n.type === 'link') {
      const url = n.fields?.url
      if (typeof url !== 'string' || !/^(https?:\/\/|mailto:|\/(?!\/))/i.test(url)) throw new Error(`unsafe link ${url}`)
      if (n.fields.linkType !== 'custom') throw new Error('link without linkType custom')
    }
    if (n.type === 'upload' && (n.relationTo !== 'media' || !Number.isInteger(n.value) || n.value < 1)) throw new Error('bad upload')
    if (n.type === 'table') {
      for (const r of n.children) {
        if (r.type !== 'tablerow') throw new Error('table child is not a row')
        if (r.children.length > 20) throw new Error('row wider than 20')
        for (const c of r.children) {
          if (c.type !== 'tablecell' || ![0, 1, 2, 3].includes(c.headerState)) throw new Error('bad cell')
          if (c.colSpan < 1 || c.colSpan > 20 || c.rowSpan < 1 || c.rowSpan > 20) throw new Error('bad span')
          if (!Array.isArray(c.children) || c.children.length === 0) throw new Error('empty cell')
        }
      }
      if (n.children.length > 100) throw new Error('table taller than 100 rows')
    }
    if (n.type === 'listitem' && n.children.some((c: N) => !['text', 'linebreak', 'link', 'list'].includes(c.type))) {
      throw new Error('bad list item child')
    }
    if (Array.isArray(n.children)) for (const c of n.children) stack.push(c)
  }
  for (const u of collectUploadNodes(content)) if (u.relationTo !== 'media') throw new Error('upload outside media')
  const json = JSON.stringify(content)
  if (/"(url|href|src)":"\s*(javascript|data|vbscript):/i.test(json)) throw new Error('dangerous scheme survived')
}

export function conv(html: string, over: Partial<HtmlToLexicalOptions> = {}) {
  const result = htmlToLexical(html, baseOptions(over))
  assertValidBody(result.content)
  return result
}

export const plain = (node: N): string =>
  node.type === 'text' ? node.text : node.type === 'linebreak' ? '\n' : (node.children ?? []).map(plain).join('')

export const blocks = (html: string, over: Partial<HtmlToLexicalOptions> = {}): N[] => conv(html, over).root.children as N[]

export const shape = (html: string, over: Partial<HtmlToLexicalOptions> = {}): string[] =>
  blocks(html, over).map((b) =>
    b.type === 'heading' ? b.tag : b.type === 'block' ? `yt:${b.fields.videoId}` : b.type === 'upload' ? `upload:${b.value}` : b.type,
  )
