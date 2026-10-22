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

const consentColumns = async (): Promise<string[]> => {
  const res = (await (f.payload.db as any).drizzle.execute(
    `select column_name from information_schema.columns where table_name = 'submissions' and column_name in ('consent_at', 'consent_text_version') order by 1`,
  )) as { rows: { column_name: string }[] }
  return res.rows.map((r) => r.column_name)
}

describe('migration 20261021_110000_submission_consent is reversible', () => {
  it('runs down, down again (IF EXISTS), then up twice, leaving a working submissions table', async () => {
    const entry = migrations.find((m) => m.name === '20261021_110000_submission_consent')
    expect(entry).toBeTruthy()
    const args = { db: (f.payload.db as any).drizzle, payload: f.payload, req: {} } as never

    expect(await consentColumns()).toEqual(['consent_at', 'consent_text_version'])
    await entry!.down(args)
    expect(await consentColumns()).toEqual([])
    await entry!.down(args)
    await entry!.up(args)
    await entry!.up(args) // IF NOT EXISTS: idempotent
    expect(await consentColumns()).toEqual(['consent_at', 'consent_text_version'])
  })
})
