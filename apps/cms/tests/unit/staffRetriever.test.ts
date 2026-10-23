import { describe, expect, it } from 'vitest'

import { buildOrTsQuery, deriveTerms, extractTerms, RETRIEVER_INPUT_MAX, RETRIEVER_MAX_TERMS } from '../../src/lib/staffRetriever'

describe('extractTerms', () => {
  it('drops stopwords, short words and bare numbers, ranks by frequency with title weight', () => {
    const terms = extractTerms('Synod elects bishop', 'The synod met and the bishop spoke. The bishop thanked 2024 delegates. Synod synod.')
    expect(terms.slice(0, 2)).toEqual(['synod', 'bishop'])
    expect(terms).toContain('delegates')
    expect(terms).not.toContain('the')
    expect(terms).not.toContain('and')
    expect(terms).not.toContain('2024')
    expect(terms[0]).toBe('synod')
  })
  it('is deterministic and bounded', () => {
    const body = Array.from({ length: 500 }, (_, i) => `word${i}`).join(' ')
    const t = extractTerms('', body)
    expect(t).toHaveLength(RETRIEVER_MAX_TERMS)
    expect(extractTerms('', body)).toEqual(t)
  })
})

describe('deriveTerms', () => {
  it('caps the input at 20k characters and reports truncation', () => {
    const early = 'earlyterm '.repeat(10)
    const late = 'lateterm '.repeat(5000)
    const r = deriveTerms('', early + 'x'.repeat(RETRIEVER_INPUT_MAX) + late)
    expect(r.truncated).toBe(true)
    expect(r.terms).toContain('earlyterm')
    expect(r.terms).not.toContain('lateterm')
    expect(deriveTerms('t', 'short text here').truncated).toBe(false)
  })
})

describe('buildOrTsQuery: never lets input form tsquery syntax', () => {
  it('joins clean terms with |', () => {
    expect(buildOrTsQuery(['synod', 'bishop', 'Synod'])).toBe('synod | bishop')
  })
  it.each([
    ["a' ; drop table articles; --"],
    ['foo & !bar'],
    ['(x) <-> y'],
    ['syn:* '],
    ["a' | b"],
    [String.fromCharCode(92)],
    ['$$'],
    ['x\u0000y'],
    ['foo bar'],
    [''],
  ])('drops or rejects hostile term %j', (hostile) => {
    const q = buildOrTsQuery([hostile, 'safe'])
    expect(q).toBe('safe')
    expect(q).not.toMatch(/[&!():*<>'\;$]/)
  })
  it('output only ever contains letters, digits, spaces and |', () => {
    const q = buildOrTsQuery(["it's", 'fine|x', 'ok1', 'ünï', '漢字', ...extractTerms('', "x' || ' & ! ( ) <-> :* ; -- \ nulls")])
    expect(q).toMatch(/^[\p{L}\p{N} |]*$/u)
  })
  it('returns empty for nothing usable and ignores non-strings', () => {
    expect(buildOrTsQuery([])).toBe('')
    expect(buildOrTsQuery([5 as unknown as string, null as unknown as string])).toBe('')
  })
  it('caps the number of terms', () => {
    const many = Array.from({ length: 100 }, (_, i) => `t${i}`)
    expect(buildOrTsQuery(many).split(' | ')).toHaveLength(RETRIEVER_MAX_TERMS)
  })
})
