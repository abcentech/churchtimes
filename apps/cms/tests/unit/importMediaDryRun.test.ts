import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { createMediaResolver } from '../../src/import/media'
import { fakePng } from '../fixtures/uploads/tree'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-dry-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))
fs.mkdirSync(path.join(dir, '2099', '01'), { recursive: true })
for (const n of ['a.png', 'a-300x200.png', 'b-300x200.png']) fs.writeFileSync(path.join(dir, '2099', '01', n), fakePng())

const url = (n: string) => `https://old.example.test/wp-content/uploads/2099/01/${n}`
const resolver = () =>
  createMediaResolver({
    payload: { find: async () => ({ docs: [] }) } as never,
    req: {} as never,
    uploadsRoot: dir,
    oldHosts: ['old.example.test'],
    dryRun: true,
  })

describe('media resolver dry run', () => {
  it('counts an address that maps onto a media document it would already have created as reused, like a real run', async () => {
    const r = resolver()
    expect((await r.resolveUrl(url('a.png'), {})).ok).toBe(true)
    // `a-300x200.png` is on disk, but `a.png` would exist by now: the real run finds it by legacy path (candidate 2) and reuses it.
    const second = await r.resolveUrl(url('a-300x200.png'), {})
    expect(second).toMatchObject({ ok: true, created: false })
    expect(r.stats).toMatchObject({ created: 1, reused: 1 })
  })

  it('creates the variant itself when the original was not imported first (the real run does the same)', async () => {
    const r = resolver()
    expect(await r.resolveUrl(url('b-300x200.png'), {})).toMatchObject({ ok: true, created: true })
    expect(r.stats).toMatchObject({ created: 1, reused: 0 })
  })
})
