import { describe, expect, it } from 'vitest'

import { clampLimit, DEFAULT_LIMIT, MAX_LIMIT } from '../../src/lib/clampLimit'

const run = (args: Record<string, unknown>, extra: { operation?: string; overrideAccess?: boolean } = {}) =>
  clampLimit({
    args: { overrideAccess: false, ...args },
    operation: (extra.operation ?? 'read') as never,
    collection: {} as never,
    context: {} as never,
    req: {} as never,
    overrideAccess: extra.overrideAccess ?? false,
  } as never) as Record<string, unknown>

describe('clampLimit beforeOperation hook', () => {
  it('forces pagination on when pagination=false is requested', () => {
    expect(run({ pagination: false }).pagination).toBe(true)
    expect(run({ pagination: false, limit: 5000 })).toMatchObject({ pagination: true, limit: MAX_LIMIT })
  })

  it('clamps limit into 1..MAX_LIMIT and applies the default for 0 / garbage', () => {
    expect(run({ limit: 1000 }).limit).toBe(MAX_LIMIT)
    expect(run({ limit: 100 }).limit).toBe(100)
    expect(run({ limit: 7 }).limit).toBe(7)
    expect(run({ limit: 0 }).limit).toBe(DEFAULT_LIMIT)
    expect(run({ limit: -3 }).limit).toBe(DEFAULT_LIMIT)
    expect(run({ limit: Number.NaN }).limit).toBe(DEFAULT_LIMIT)
    expect(run({ limit: 12.9 }).limit).toBe(12)
    expect(run({}).limit).toBeUndefined() // Payload's own default (10) applies
  })

  it('does not touch trusted (overrideAccess) calls', () => {
    const args = { overrideAccess: true, pagination: false, limit: 0 }
    expect(run(args, { overrideAccess: true })).toEqual(args)
  })

  it('does not touch non-read operations or single-document reads', () => {
    expect(run({ pagination: false, limit: 0 }, { operation: 'update' })).toMatchObject({ pagination: false, limit: 0 })
    expect(run({ id: 5 }).pagination).toBeUndefined()
  })
})
