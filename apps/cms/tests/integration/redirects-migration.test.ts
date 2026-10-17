import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { migrations } from '../../src/migrations'
import { newRunId, setupFixtures, type Fixtures } from './helpers'

const runId = newRunId()
let f: Fixtures

beforeAll(async () => {
  f = await setupFixtures(runId)
})

afterAll(async () => {
  await f?.cleanup()
})

const tableExists = async (name: string): Promise<boolean> => {
  const res = (await (f.payload.db as any).drizzle.execute(
    `select to_regclass('public.${name}') as t`,
  )) as { rows: { t: string | null }[] }
  return res.rows[0].t !== null
}

describe('C7 migration 20261016_111035_redirects is reversible', () => {
  it('runs down and then up again on the test database, leaving a working redirects table', async () => {
    const entry = migrations.find((m) => m.name === '20261016_111035_redirects')
    expect(entry).toBeTruthy()
    const args = { db: (f.payload.db as any).drizzle, payload: f.payload, req: {} } as never

    expect(await tableExists('redirects')).toBe(true)
    await entry!.down(args) // used to fail: it dropped a constraint that DROP TABLE ... CASCADE had already removed
    expect(await tableExists('redirects')).toBe(false)
    await entry!.down(args) // idempotent (IF EXISTS)
    await entry!.up(args)
    expect(await tableExists('redirects')).toBe(true)

    const doc = await f.payload.create({
      collection: 'redirects',
      data: { from: `/${runId}-mig/`, to: '/', status: 301, source: 'manual' } as never,
      overrideAccess: true,
    })
    expect(doc.id).toBeTruthy()
    await f.payload.delete({ collection: 'redirects', id: doc.id, overrideAccess: true })
  })
})
