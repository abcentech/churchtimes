import { describe, expect, it } from 'vitest'

import { STALE_MESSAGE, captureExpectedUpdatedAt, matchesExpected, parseExpectedUpdatedAt } from '../../src/lib/expectedUpdatedAt'

const V = '2026-10-14T20:00:00.123Z'

describe('parseExpectedUpdatedAt', () => {
  it('treats absent and null as "no check"', () => {
    expect(parseExpectedUpdatedAt(undefined)).toBeUndefined()
    expect(parseExpectedUpdatedAt(null)).toBeUndefined()
  })
  it('returns epoch milliseconds for ISO strings', () => {
    expect(parseExpectedUpdatedAt(V)).toBe(Date.parse(V))
    expect(parseExpectedUpdatedAt('2026-10-14T20:00:00.123+00:00')).toBe(Date.parse(V))
  })
  it('refuses anything else with a 400', () => {
    for (const bad of ['', 'yesterday', 12345, {}, [], true, 'x'.repeat(100)]) {
      expect(() => parseExpectedUpdatedAt(bad)).toThrowError(/ISO 8601/)
    }
  })
})

describe('matchesExpected', () => {
  it('compares instants from a Date or a string', () => {
    expect(matchesExpected(new Date(V), Date.parse(V))).toBe(true)
    expect(matchesExpected(V, Date.parse(V))).toBe(true)
    expect(matchesExpected('2026-10-14T20:00:00.124Z', Date.parse(V))).toBe(false)
    expect(matchesExpected(undefined, Date.parse(V))).toBe(false)
    expect(matchesExpected('garbage', Date.parse(V))).toBe(false)
  })
})

describe('captureExpectedUpdatedAt', () => {
  const run = (args: Record<string, unknown>, operation = 'update') =>
    (captureExpectedUpdatedAt as unknown as (a: unknown) => unknown)({ args, operation, context: {} })

  it('strips the field from the body so it can never be stored, and remembers it server-side', () => {
    const req = { context: {} as Record<string, unknown> }
    const data: Record<string, unknown> = { status: 'approved', expectedUpdatedAt: V }
    run({ data, id: 7, req })
    expect(data).toEqual({ status: 'approved' })
    expect(req.context.expectedUpdatedAt).toEqual({ id: '7', at: Date.parse(V) })
  })
  it('leaves requests without the field untouched', () => {
    const req = { context: {} as Record<string, unknown> }
    const data = { status: 'approved' }
    run({ data, id: 7, req })
    expect(data).toEqual({ status: 'approved' })
    expect(req.context.expectedUpdatedAt).toBeUndefined()
  })
  it('refuses a malformed value and bulk updates, and ignores other operations', () => {
    const req = { context: {} as Record<string, unknown> }
    expect(() => run({ data: { expectedUpdatedAt: 'nope' }, id: 7, req })).toThrowError(/ISO 8601/)
    expect(() => run({ data: { expectedUpdatedAt: V }, req })).toThrowError(/bulk/)
    const data = { expectedUpdatedAt: V }
    run({ data, id: 7, req }, 'create')
    expect(data).toEqual({ expectedUpdatedAt: V })
  })
})

describe('STALE_MESSAGE', () => {
  it('is the text the newsroom shows', () => {
    expect(STALE_MESSAGE).toBe('This item changed after you opened it. Reload and review it again.')
  })
})
