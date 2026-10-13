import type { Article } from '../payload-types'

export type LexicalContent = Article['content']

type LexicalText = {
  type: 'text'
  text: string
  format: number
  detail: number
  mode: 'normal'
  style: string
  version: number
}

type LexicalParagraph = {
  type: 'paragraph'
  format: ''
  indent: number
  version: number
  direction: 'ltr'
  textFormat: number
  textStyle: string
  children: LexicalText[]
}

/**
 * Build a Lexical editor state with one paragraph per entry (plain text only, no HTML).
 * Empty or whitespace-only entries are dropped.
 */
export function paragraphsToLexical(paragraphs: string[]): LexicalContent {
  const children: LexicalParagraph[] = paragraphs
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((text) => ({
      type: 'paragraph',
      format: '',
      indent: 0,
      version: 1,
      direction: 'ltr',
      textFormat: 0,
      textStyle: '',
      children: [
        { type: 'text', text, format: 0, detail: 0, mode: 'normal', style: '', version: 1 },
      ],
    }))

  return {
    root: {
      type: 'root',
      format: '',
      indent: 0,
      version: 1,
      direction: 'ltr',
      children,
    },
  }
}
