import { describe, expect, it } from 'vitest'

import { MAX_SECONDARY_CATEGORIES, categoryIds, checkSecondaryCategories } from '../../src/lib/articleCategories'

describe('checkSecondaryCategories', () => {
  it('accepts nothing, an empty list and a normal list', () => {
    expect(checkSecondaryCategories(1, undefined)).toBeNull()
    expect(checkSecondaryCategories(1, null)).toBeNull()
    expect(checkSecondaryCategories(1, [])).toBeNull()
    expect(checkSecondaryCategories(1, [2, 3])).toBeNull()
    expect(checkSecondaryCategories({ id: 1 }, [{ id: 2 }, '3'])).toBeNull()
  })
  it('allows five extras and refuses six', () => {
    expect(MAX_SECONDARY_CATEGORIES).toBe(5)
    expect(checkSecondaryCategories(1, [2, 3, 4, 5, 6])).toBeNull()
    expect(checkSecondaryCategories(1, [2, 3, 4, 5, 6, 7])).toMatch(/at most 5/)
  })
  it('refuses duplicates, the primary, and non-ids', () => {
    expect(checkSecondaryCategories(1, [2, 2])).toMatch(/repeat/)
    expect(checkSecondaryCategories(1, [2, '2'])).toMatch(/repeat/)
    expect(checkSecondaryCategories(1, [2, 1])).toMatch(/primary/)
    expect(checkSecondaryCategories('1', [{ id: 1 }])).toMatch(/primary/)
    expect(checkSecondaryCategories(1, ['news'])).toMatch(/IDs/)
    expect(checkSecondaryCategories(1, 'nope')).toMatch(/list/)
  })
  it('categoryIds normalises ids and objects', () => {
    expect(categoryIds([1, { id: 2 }, '03', null, 'x'])).toEqual(['1', '2', '3'])
    expect(categoryIds(undefined)).toEqual([])
  })
})
