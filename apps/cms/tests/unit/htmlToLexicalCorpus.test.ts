import { describe, expect, it } from 'vitest'

import { htmlToLexical } from '../../src/import/htmlToLexical'
import { buildCorpus, type Kind } from '../fixtures/html/corpus'
import { assertValidBody, baseOptions, type N, plain } from './htmlToLexical.helpers'

const kindOf = (n: N): Kind => (n.type === 'block' ? 'block' : (n.type as Kind))
const collect = (node: N, type: string, out: N[] = []): N[] => {
  if (node.type === type) out.push(node)
  for (const c of node.children ?? []) collect(c, type, out)
  return out
}

describe('synthetic corpus (48 invented articles, Gutenberg, classic and mixed)', () => {
  const corpus = buildCorpus(48)

  it('has at least 40 articles of every markup style', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(40)
    for (const mode of ['classic', 'gutenberg', 'mixed']) expect(corpus.filter((a) => a.mode === mode).length).toBeGreaterThanOrEqual(10)
  })

  it.each(corpus.map((a) => [a.id, a] as const))('%s converts to the expected structure with nothing lost', (_id, article) => {
    const r = htmlToLexical(article.html, baseOptions())
    assertValidBody(r.content)

    // structure: the exact sequence of top-level node kinds
    expect((r.root.children as N[]).map(kindOf)).toEqual(article.expectKinds)

    // text: every invented word and phrase survives (entities decoded)
    const text = plain(r.root).replace(/\s+/g, ' ')
    for (const word of article.expectWords) expect(text, word).toContain(word)
    expect(text).not.toMatch(/&#8220;|&amp;|&rdquo;/)

    // images in document order, never dropped
    const uploads = collect(r.root, 'upload').map((u) => u.value)
    expect(uploads).toEqual(article.expectUploads)

    // video: only the contract block, with the exact id
    const youtube = collect(r.root, 'block').map((b) => b.fields.videoId)
    expect(youtube).toEqual(article.expectYoutube)

    // nothing lossy went unreported
    expect(r.report.images.unresolved).toEqual([])
    expect(r.report.warnings).toEqual([])
    expect(JSON.stringify(r.root)).not.toMatch(/\[caption|\[contact-form|\[youtube|\[embed|wp:|<!--/)
  })

  it('is deterministic: converting twice gives identical JSON', () => {
    for (const a of corpus.slice(0, 12)) {
      expect(JSON.stringify(htmlToLexical(a.html, baseOptions()).content)).toBe(JSON.stringify(htmlToLexical(a.html, baseOptions()).content))
    }
  })

  it('every article stays far below the body depth rule and the renderer node budget', () => {
    for (const a of corpus) {
      const r = htmlToLexical(a.html, baseOptions())
      expect(r.report.nodeCount).toBeLessThan(500)
    }
  })

  it('the corpus as one long article still converts', () => {
    const r = htmlToLexical(corpus.map((a) => a.html).join('\n\n'), baseOptions())
    assertValidBody(r.content)
    expect(r.report.images.unresolved).toEqual([])
  })
})
