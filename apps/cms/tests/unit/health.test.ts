import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { beforeEach, describe, expect, it } from 'vitest'

import {
  checkDirectoryWritable,
  livenessResponse,
  readinessResponse,
  resetReadinessState,
  runReadiness,
  startupSelfCheck,
  type ReadinessProbes,
} from '../../src/lib/health'

const okProbes = (over: Partial<ReadinessProbes> = {}): ReadinessProbes => ({
  pingDatabase: async () => {},
  appliedMigrations: async () => ['a', 'b'],
  bundledMigrations: ['a', 'b'],
  checkMediaWritable: async () => {},
  timeoutMs: 100,
  ...over,
})

beforeEach(() => resetReadinessState())

describe('liveness', () => {
  it('answers without any database and with a fixed tiny body', async () => {
    const res = livenessResponse('GET')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })
  it('supports HEAD with no body and refuses other methods', async () => {
    const head = livenessResponse('HEAD')
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    expect(head.headers.get('cache-control')).toBe('no-store')
    expect(livenessResponse('POST').status).toBe(405)
  })
})

describe('readiness', () => {
  it('is ready when every probe passes; body is booleans only', async () => {
    const res = await readinessResponse('GET', 'k1', async () => okProbes())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Object.keys(body).sort()).toEqual(['database', 'media', 'migrations', 'status'])
    expect(body).toEqual({ status: 'ready', database: true, migrations: true, media: true })
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })
  it('answers 503 when the database is down and leaks no error text', async () => {
    const res = await readinessResponse('GET', 'k2', async () =>
      okProbes({ pingDatabase: async () => Promise.reject(new Error('connect ECONNREFUSED postgres://u:secret@db:5432/x')) }),
    )
    expect(res.status).toBe(503)
    const text = await res.text()
    expect(text).not.toMatch(/ECONNREFUSED|secret|postgres/)
    expect(JSON.parse(text)).toEqual({ status: 'unavailable', database: false, migrations: false, media: true })
  })
  it('answers 503 when the database hangs past the timeout', async () => {
    const res = await readinessResponse('GET', 'k3', async () => okProbes({ pingDatabase: () => new Promise(() => {}), timeoutMs: 20 }))
    expect(res.status).toBe(503)
  })
  it('answers 503 when Payload cannot boot', async () => {
    const res = await readinessResponse('GET', 'k4', async () => {
      throw new Error('boom password=hunter2')
    })
    expect(res.status).toBe(503)
    expect(await res.text()).not.toMatch(/boom|hunter2/)
  })
  it('flags pending migrations and an unwritable media directory', async () => {
    const r = await runReadiness(
      okProbes({ bundledMigrations: ['a', 'b', 'c'], checkMediaWritable: async () => Promise.reject(new Error('EACCES')) }),
    )
    expect(r).toEqual({ ok: false, database: true, migrations: false, media: false })
  })
  it('HEAD works with no body, same status', async () => {
    const res = await readinessResponse('HEAD', 'k5', async () => okProbes())
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
    expect((await readinessResponse('DELETE', 'k5', async () => okProbes())).status).toBe(405)
  })
  it('memoises for 5 s so probes are not hammered', async () => {
    let calls = 0
    const probes = async () => {
      calls++
      return okProbes()
    }
    const t = 1000
    await readinessResponse('GET', 'k6', probes, () => t)
    await readinessResponse('GET', 'k6', probes, () => t + 1000)
    expect(calls).toBe(1)
    await readinessResponse('GET', 'k6', probes, () => t + 6000)
    expect(calls).toBe(2)
  })
  it('rate limits a single client with 429 and no detail', async () => {
    let last: Response | undefined
    for (let i = 0; i < 301; i++) last = await readinessResponse('GET', 'flood', async () => okProbes())
    expect(last!.status).toBe(429)
    expect(await last!.json()).toEqual({ status: 'rate_limited' })
    expect(last!.headers.get('retry-after')).toBeTruthy()
  })
})

describe('checkDirectoryWritable', () => {
  it('passes for a temp dir and rejects for a missing one', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'health-'))
    try {
      await expect(checkDirectoryWritable(dir)).resolves.toBeUndefined()
      await expect(checkDirectoryWritable(path.join(dir, 'missing'))).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('startupSelfCheck', () => {
  it('returns counts only, never values', () => {
    const r = startupSelfCheck({ PAYLOAD_SECRET: 'x'.repeat(40), DATABASE_URL: 'postgres://u:pw@h/db' } as unknown as NodeJS.ProcessEnv)
    expect(r).toEqual({ passed: 3, total: 10 })
    expect(JSON.stringify(r)).not.toMatch(/pw|postgres/)
  })
})
