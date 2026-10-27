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

const NAME = '20261019_230557_legacy_comments'

const exists = async (sqlText: string): Promise<boolean> => {
  const res = (await (f.payload.db as any).drizzle.execute(sqlText)) as { rows: { t: unknown }[] }
  return res.rows[0].t !== null && res.rows[0].t !== false
}
const tableExists = (name: string) => exists(`select to_regclass('public.${name}') as t`)
const columnExists = (table: string, column: string) =>
  exists(
    `select exists(select 1 from information_schema.columns where table_name = '${table}' and column_name = '${column}') as t`,
  )

describe('C6 migration is reversible and migrations stay in timestamp order', () => {
  it('runs down, down again, up, and down again (idempotent) and leaves a working table', async () => {
    const entry = migrations.find((m) => m.name === NAME)
    expect(entry).toBeTruthy()
    const args = { db: (f.payload.db as any).drizzle, payload: f.payload, req: {} } as never

    expect(await tableExists('legacy_comments')).toBe(true)
    await entry!.down(args) // used to fail: DROP TABLE ... CASCADE had already removed the constraint dropped afterwards
    expect(await tableExists('legacy_comments')).toBe(false)
    expect(await columnExists('payload_locked_documents_rels', 'legacy_comments_id')).toBe(false)
    await entry!.down(args) // idempotent (IF EXISTS)
    await entry!.up(args)
    expect(await tableExists('legacy_comments')).toBe(true)
    expect(await columnExists('payload_locked_documents_rels', 'legacy_comments_id')).toBe(true)

    const art = await f.seedArticle({ status: 'published', publishedAt: new Date().toISOString() })
    const doc = await f.payload.create({
      collection: 'legacy-comments',
      data: {
        article: art.id,
        authorName: 'Migration',
        content: 'works after down and up',
        commentedAt: new Date().toISOString(),
        legacyId: 8_000_000 + Math.floor(Math.random() * 1_000_000),
      } as never,
      overrideAccess: true,
    })
    expect(doc.id).toBeTruthy()
    await f.payload.delete({ collection: 'legacy-comments', id: doc.id, overrideAccess: true })

    await entry!.down(args)
    expect(await tableExists('legacy_comments')).toBe(false)
    await entry!.up(args) // leave the schema as the other tests expect it
  })

  it('lists the migrations in strictly increasing timestamp order, with this one after contact_and_newsletter', () => {
    const names = migrations.map((m) => m.name)
    expect(names).toEqual([...names].sort())
    expect(names.indexOf(NAME)).toBeGreaterThan(names.indexOf('20261019_215623_contact_and_newsletter'))
  })
})
