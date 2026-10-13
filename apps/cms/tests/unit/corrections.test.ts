import { describe, expect, it } from 'vitest'

import { reconcileCorrections } from '../../src/workflow/corrections'

const now = new Date('2026-10-13T12:00:00.000Z')
const e1 = { id: 'a1', note: 'first', correctedAt: '2026-10-01T08:00:00.000Z' }
const e2 = { id: 'a2', note: 'second', correctedAt: '2026-10-02T08:00:00.000Z' }

const run = (existing: unknown, incoming: unknown, canAmend = false) =>
  reconcileCorrections(existing, incoming, { now, canAmend })

describe('reconcileCorrections', () => {
  it('accepts an unchanged list and a pure append, with server-set correctedAt for new entries', () => {
    expect(run([e1], [e1])).toMatchObject({ ok: true, added: 0, changed: false, amended: false })
    const res = run([e1], [e1, { id: 'evil', note: 'third', correctedAt: '1999-01-01T00:00:00.000Z' }])
    expect(res).toMatchObject({ ok: true, added: 1, changed: true, amended: false })
    if (res.ok) {
      expect(res.rows[0]).toEqual(e1)
      expect(res.rows[1]).toEqual({ note: 'third', correctedAt: now.toISOString() })
    }
  })

  it('compares timestamps by instant, not by string form', () => {
    expect(run([e1], [{ ...e1, correctedAt: '2026-10-01T09:00:00+01:00' }])).toMatchObject({ ok: true, added: 0 })
  })

  it('refuses rewrite, reorder, removal, id changes and entries sent without an id', () => {
    for (const bad of [
      [{ ...e1, note: 'changed' }, e2],
      [{ ...e1, correctedAt: '2000-01-01T00:00:00.000Z' }, e2],
      [e2, e1],
      [e1],
      [],
      [{ ...e1, id: 'zz' }, e2],
      [{ note: 'first', correctedAt: e1.correctedAt }, e2],
    ]) {
      expect(run([e1, e2], bad)).toMatchObject({ ok: false })
    }
    expect(run([e1], null)).toMatchObject({ ok: false })
  })

  it('treats null / undefined as empty and rejects non-array input', () => {
    expect(run(undefined, [])).toMatchObject({ ok: true, added: 0, changed: false })
    expect(run(null, [{ note: 'x' }])).toMatchObject({ ok: true, added: 1 })
    expect(run([], 'nope')).toMatchObject({ ok: false })
    expect(run([], [1])).toMatchObject({ ok: false })
  })

  it('lets an amender rewrite or remove entries and flags it', () => {
    expect(run([e1, e2], [{ ...e1, note: 'fixed' }, e2], true)).toMatchObject({ ok: true, amended: true, changed: true })
    const removed = run([e1, e2], [], true)
    expect(removed).toMatchObject({ ok: true, amended: true, rows: [] })
    const mixed = run([e1, e2], [e2, { note: 'new' }], true)
    expect(mixed).toMatchObject({ ok: true, amended: true, added: 1 })
  })
})
