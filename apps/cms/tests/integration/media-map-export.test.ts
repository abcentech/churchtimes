import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { runMediaMapExport } from '../../src/lib/mediaMapCli'
import { verifyMediaMapBody, type MediaMap } from '../../src/lib/mediaMapExport'
import { api, newRunId, setupFixtures, type Fixtures } from './helpers'

/**
 * Legacy media map export against a real Payload + PostgreSQL with the real media privacy rule. Synthetic media only.
 * Withdrawal: an article that stops being published makes its media private, and the next export drops the entry.
 */
const runId = newRunId()
let f: Fixtures
let png: Buffer
let tmp: string

beforeAll(async () => {
  f = await setupFixtures(runId)
  tmp = mkdtempSync(path.join(tmpdir(), 'ct-mediamap-int-'))
  png = await sharp({ create: { width: 500, height: 300, channels: 3, background: { r: 1, g: 90, b: 40 } } }).png().toBuffer()
})
afterAll(async () => {
  await f?.cleanup()
  if (tmp) rmSync(tmp, { recursive: true, force: true })
})

async function uploadMedia(label: string, legacyPath: string | null) {
  const form = new FormData()
  form.set('_payload', JSON.stringify({ alt: `${runId} ${label}` }))
  form.set('file', new Blob([new Uint8Array(png)], { type: 'image/png' }), `${runId}-${label}.png`)
  const res = await api('POST', '/api/media', { token: f.tokens.eic, body: form })
  expect(res.status).toBe(201)
  const id = res.json.doc.id as number
  if (legacyPath) {
    await f.payload.update({ collection: 'media', id, data: { legacyPath } as never, overrideAccess: true })
  }
  return id
}

const run = async (...args: string[]) => {
  const lines: string[] = []
  const code = await runMediaMapExport(f.payload, args, { out: (l) => lines.push(l), err: (l) => lines.push(l) })
  return { code, text: lines.join('\n') }
}

describe('export:media-map', () => {
  it('exports only anonymously readable media, drops a withdrawn one on re-export, and writes a private atomic file', async () => {
    const pub = await uploadMedia('pub', `2099/${runId}/published.png`)
    const draft = await uploadMedia('draft', `2099/${runId}/draft.png`)
    await uploadMedia('loose', `2099/${runId}/unreferenced.png`)
    const noPath = await uploadMedia('nopath', null)
    const live = await f.createArticle(f.tokens.eic, { featuredImage: pub, status: 'published' })
    const dr = await f.createArticle(f.tokens.reporter, { featuredImage: draft })
    const np = await f.createArticle(f.tokens.eic, { featuredImage: noPath, status: 'published' })
    expect([live.status, dr.status, np.status]).toEqual([201, 201, 201])

    const dry = await run()
    expect(dry.code).toBe(0)
    expect(dry.text).toContain('Dry run')
    expect(dry.text).not.toContain(runId)

    const aliasFile = path.join(tmp, 'aliases.json')
    writeFileSync(aliasFile, JSON.stringify([{ alias: `2099/${runId}/published-300x200.png`, path: `2099/${runId}/published.png` }]))
    const out = path.join(tmp, 'private', 'media-map.json')
    const first = await run('--out', out, '--aliases', aliasFile)
    expect(first.code).toBe(0)
    expect(first.text).not.toContain(runId)
    expect(readdirSync(path.dirname(out))).toEqual(['media-map.json'])
    const body = readFileSync(out, 'utf8')
    expect(verifyMediaMapBody(body)).toEqual({ ok: true })
    const map = JSON.parse(body) as MediaMap
    const mine = map.entries.filter((e) => e.path.startsWith(`2099/${runId}/`))
    expect(mine.map((e) => e.path)).toEqual([`2099/${runId}/published.png`])
    expect(mine[0]).toMatchObject({ mime: 'image/png' })
    expect(mine[0].file).toMatch(/^\/api\/media\/file\/.+\.png$/)
    expect(map.aliases.filter((a) => a.path.startsWith(`2099/${runId}/`))).toEqual([
      { alias: `2099/${runId}/published-300x200.png`, path: `2099/${runId}/published.png` },
    ])
    expect(body).not.toContain('unreferenced')
    expect(body).not.toContain('draft.png')

    // The listed file really is anonymously readable.
    expect((await api('GET', mine[0].file)).status).toBe(200)

    // Withdraw: the article stops being published, the media becomes private, re-export removes the entry.
    expect((await api('PATCH', `/api/articles/${live.id}`, { token: f.tokens.eic, body: { status: 'archived' } })).status).toBe(200)
    const second = await run('--out', out)
    expect(second.code).toBe(0)
    const after = JSON.parse(readFileSync(out, 'utf8')) as MediaMap
    expect(after.entries.filter((e) => e.path.startsWith(`2099/${runId}/`))).toEqual([])
    expect(after.aliases.filter((a) => a.path.startsWith(`2099/${runId}/`))).toEqual([])
    expect(after.sha256).not.toBe(map.sha256)
  })

  it('refuses an --out inside the repository', async () => {
    const r = await run('--out', path.join(process.cwd(), 'media-map.json'))
    expect(r.code).toBe(2)
  })
})
