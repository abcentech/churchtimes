import { describe, expect, it, vi } from 'vitest'

vi.mock('../../src/lib/lexicalEmbeds', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/lexicalEmbeds')>()
  return { ...actual, findEmbedProblem: () => 'forced problem for the test' }
})

import { HtmlConversionError, htmlToLexical } from '../../src/import/htmlToLexical'

describe('the final CMS embed check', () => {
  it('a body that fails findEmbedProblem is never returned', () => {
    let caught: unknown
    try {
      htmlToLexical('<p>ok</p>', { oldHosts: [], slugMap: {}, resolveImage: () => null })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(HtmlConversionError)
    expect((caught as HtmlConversionError).code).toBe('invalid-output')
    expect((caught as Error).message).toContain('forced problem')
  })
})
