import { describe, expect, it } from 'vitest'

import { canonicalStringify, deepEqual } from '../../src/lib/deepEqual'

describe('canonicalStringify / deepEqual', () => {
  it('ignores object key order at every depth', () => {
    const a = { root: { type: 'root', children: [{ type: 'paragraph', version: 1, text: 'x' }], version: 1 } }
    const b = { root: { version: 1, children: [{ text: 'x', version: 1, type: 'paragraph' }], type: 'root' } }
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b))
    expect(canonicalStringify(a)).toBe(canonicalStringify(b))
    expect(deepEqual(a, b)).toBe(true)
  })

  it('keeps array order significant', () => {
    expect(deepEqual([1, 2], [2, 1])).toBe(false)
    expect(deepEqual([{ a: 1 }, { b: 2 }], [{ b: 2 }, { a: 1 }])).toBe(false)
  })

  it('distinguishes real differences', () => {
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false)
    expect(deepEqual({ a: 1 }, { a: 1, b: 1 })).toBe(false)
    expect(deepEqual('a', 'b')).toBe(false)
    expect(deepEqual(1, '1')).toBe(false)
    expect(deepEqual({ a: [] }, { a: {} })).toBe(false)
  })

  it('treats null and undefined at the top level, and undefined object values, as absence', () => {
    expect(deepEqual(undefined, null)).toBe(true)
    expect(deepEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true)
    expect(deepEqual({ a: 1, b: null }, { a: 1 })).toBe(false) // explicit null is data inside an object
    expect(deepEqual('', null)).toBe(false)
  })

  it('does not collide on keys that look like JSON syntax', () => {
    expect(deepEqual({ 'a":1,"b': 2 }, { a: 1, b: 2 })).toBe(false)
  })

  it('handles dates and non-finite numbers with JSON semantics', () => {
    expect(deepEqual(new Date('2020-01-01T00:00:00.000Z'), '2020-01-01T00:00:00.000Z')).toBe(true)
    expect(deepEqual(Number.NaN, null)).toBe(true)
  })
})
