import { describe, expect, it } from 'vitest'

import { collectUploadNodes, uploadValueId } from '../../src/lib/lexicalMedia'
import { isMediaId } from '../../src/lib/mediaChecks'

describe('collectUploadNodes', () => {
  it('finds upload nodes at any depth, in order, including duplicates', () => {
    const doc = {
      root: {
        children: [
          { type: 'paragraph', children: [{ type: 'text', text: 'hi' }] },
          { type: 'upload', relationTo: 'media', value: 1 },
          { type: 'list', children: [{ type: 'listitem', children: [{ type: 'upload', relationTo: 'media', value: { id: 2 } }] }] },
          { type: 'upload', relationTo: 'users', value: 3 },
        ],
      },
    }
    expect(collectUploadNodes(doc)).toEqual([
      { relationTo: 'media', value: 1 },
      { relationTo: 'media', value: { id: 2 } },
      { relationTo: 'users', value: 3 },
    ])
  })

  it('tolerates malformed input and very deep nesting', () => {
    expect(collectUploadNodes(null)).toEqual([])
    expect(collectUploadNodes('x')).toEqual([])
    expect(collectUploadNodes(undefined)).toEqual([])
    let deep: unknown = { type: 'upload', relationTo: 'media', value: 1 }
    for (let i = 0; i < 500; i++) deep = { children: [deep] }
    expect(collectUploadNodes(deep)).toEqual([])
  })

  it('reads ids and validates the media id range', () => {
    expect(uploadValueId(5)).toBe(5)
    expect(uploadValueId({ id: 7, alt: 'x' })).toBe(7)
    for (const ok of [1, 2147483647]) expect(isMediaId(ok)).toBe(true)
    for (const bad of [0, -1, 1.5, 2147483648, 99999999999, '5', null, undefined, NaN]) expect(isMediaId(bad)).toBe(false)
  })
})
