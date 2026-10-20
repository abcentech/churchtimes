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
  const res = (await (f.payload.db as any).drizzle.execute(`select to_regclass('public.${name}') as t`)) as {
    rows: { t: string | null }[]
  }
  return res.rows[0].t !== null
}

describe('C3 migration 20261020_134844_ad_campaigns is reversible', () => {
  it('runs down, down again, then up, leaving working tables', async () => {
    const entry = migrations.find((m) => m.name === '20261020_134844_ad_campaigns')
    expect(entry).toBeTruthy()
    const args = { db: (f.payload.db as any).drizzle, payload: f.payload, req: {} } as never

    for (const t of ['advertisers', 'ad_campaigns', 'ad_campaigns_placements', 'ad_campaigns_rels']) {
      expect(await tableExists(t), t).toBe(true)
    }
    await entry!.down(args)
    for (const t of ['advertisers', 'ad_campaigns', 'ad_campaigns_placements', 'ad_campaigns_rels']) {
      expect(await tableExists(t), t).toBe(false)
    }
    await entry!.down(args) // idempotent
    await entry!.up(args)
    expect(await tableExists('ad_campaigns')).toBe(true)

    const adv = await f.payload.create({
      collection: 'advertisers',
      data: { name: `${runId} migration advertiser` },
      overrideAccess: true,
    })
    const c = await f.payload.create({
      collection: 'ad-campaigns',
      data: {
        advertiser: adv.id,
        sponsor: `${runId} migration`,
        alt: 'x',
        destinationUrl: 'https://example.test/',
        placements: ['mobile-banner'],
        startsAt: new Date().toISOString(),
        endsAt: new Date(Date.now() + 3600_000).toISOString(),
      } as never,
      overrideAccess: true,
    })
    expect(c.id).toBeTruthy()
    await (f.payload.db as any).deleteMany({ collection: 'ad-campaigns', where: { id: { equals: c.id } } })
    await f.payload.delete({ collection: 'advertisers', id: adv.id, overrideAccess: true })
    await f.payload.delete({ collection: 'audit-logs', where: { summary: { like: runId } }, overrideAccess: true })
  })
})
