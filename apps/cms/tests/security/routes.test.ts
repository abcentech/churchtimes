/**
 * Security regression: anonymous access matrix, route enumeration, error hygiene, verb tampering, GraphQL.
 * The matrix lives in routeMatrix.ts; a route without an entry fails `every route is in the matrix`.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import config from '@payload-config'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { api, newRunId, setupFixtures, type Fixtures } from '../integration/helpers'
import { anon, leaksIn } from './harness'
import { collectionMatrix, endpointMatrix, GENERIC_COLLECTION_PATHS, routeFileMatrix } from './routeMatrix'

const runId = newRunId()
let f: Fixtures
const here = path.dirname(fileURLToPath(import.meta.url))
const apiDir = path.resolve(here, '../../src/app/(payload)/api')

beforeAll(async () => {
  f = await setupFixtures(runId)
  // Payload registers a few built-in endpoints (e.g. /api/og) on the first REST request: warm up before enumerating.
  await anon('GET', '/api/access')
})
afterAll(async () => {
  await f?.cleanup()
})

type Ep = { path: string; method: string }
const sample = (p: string) =>
  p
    .replace(/:id\??/g, '999999')
    .replace(/:slug/g, 'no-such-event')
    .replace(/:filename/g, 'nope.png')
    .replace(/:key/g, 'k')
    .replace(/\/+$/, '')

/** `METHOD /api<base><path>` for every endpoint registered by the config (global + per collection), minus Payload's generic CRUD. */
async function enumerateEndpoints(): Promise<string[]> {
  const cfg = await config
  const keys: string[] = []
  for (const e of (Array.isArray(cfg.endpoints) ? cfg.endpoints : []) as Ep[]) keys.push(`${e.method.toUpperCase()} /api${e.path}`)
  for (const col of cfg.collections) {
    for (const e of (Array.isArray(col.endpoints) ? col.endpoints : []) as Ep[]) {
      // Generic CRUD is covered by the collection matrix; legacy-comments overrides GET/HEAD/OPTIONS on '/' with its own handlers.
      const customRoot = col.slug === 'legacy-comments' && e.path === '/' && ['get', 'head', 'options'].includes(e.method)
      if (GENERIC_COLLECTION_PATHS.has(e.path) && !customRoot) continue
      const p = e.path === '/' ? '' : e.path
      keys.push(`${e.method.toUpperCase()} /api/${col.slug}${p}`)
    }
  }
  return [...new Set(keys)]
}

describe('route enumeration: nothing is exposed without a matrix entry', () => {
  it('every collection has a collectionMatrix entry and vice versa', async () => {
    const cfg = await config
    const slugs: string[] = cfg.collections.map((c) => c.slug as string).sort()
    const matrixSlugs = Object.keys(collectionMatrix).sort()
    expect(slugs.filter((s) => !matrixSlugs.includes(s)), 'collections missing from routeMatrix.ts').toEqual([])
    expect(matrixSlugs.filter((s) => !slugs.includes(s)), 'stale collectionMatrix entries').toEqual([])
  })

  it('every endpoint registered by payload.config has an endpointMatrix entry and vice versa', async () => {
    const found = await enumerateEndpoints()
    const known = Object.keys(endpointMatrix)
    expect(found.filter((k) => !known.includes(k)), 'endpoints missing from routeMatrix.ts').toEqual([])
    expect(known.filter((k) => !found.includes(k)), 'stale endpointMatrix entries (route removed?)').toEqual([])
  })

  it('every Next route file under src/app/(payload)/api has a routeFileMatrix entry and vice versa', () => {
    const files: string[] = []
    const walk = (dir: string) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name)
        if (ent.isDirectory()) walk(full)
        else if (/^route\.tsx?$/.test(ent.name)) files.push(path.relative(apiDir, full).split(path.sep).join('/'))
      }
    }
    walk(apiDir)
    expect(files.filter((x) => !(x in routeFileMatrix)), 'route files missing from routeMatrix.ts').toEqual([])
    expect(Object.keys(routeFileMatrix).filter((x) => !files.includes(x)), 'stale routeFileMatrix entries').toEqual([])
  })

  it('no Next page route besides the admin and the catch-all REST handlers is mounted', () => {
    const appDir = path.resolve(here, '../../src/app')
    const routes: string[] = []
    const walk = (dir: string) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name)
        if (ent.isDirectory()) walk(full)
        else if (/^(route|page)\.tsx?$/.test(ent.name)) routes.push(path.relative(appDir, full).split(path.sep).join('/'))
      }
    }
    walk(appDir)
    const apiRoutes = routes.filter((r) => r.startsWith('(payload)/api/'))
    expect(apiRoutes.map((r) => r.replace('(payload)/api/', '')).sort()).toEqual(Object.keys(routeFileMatrix).sort())
  })
})

describe('anonymous access matrix: collections', () => {
  for (const [slug, ops] of Object.entries(collectionMatrix)) {
    it(`${slug}: anonymous find/get/count/create/update/delete/versions match the matrix`, async () => {
      const got = {
        find: (await anon('GET', `/api/${slug}`)).status,
        findById: (await anon('GET', `/api/${slug}/999999`)).status,
        count: (await anon('GET', `/api/${slug}/count`)).status,
        create: (await anon('POST', `/api/${slug}`, { body: {} })).status,
        update: (await anon('PATCH', `/api/${slug}/999999`, { body: {} })).status,
        delete: (await anon('DELETE', `/api/${slug}/999999`)).status,
        versions: (await anon('GET', `/api/${slug}/versions`)).status,
      }
      for (const [op, status] of Object.entries(got)) {
        expect(ops[op as keyof typeof ops], `${slug} ${op} answered ${status}`).toContain(status)
      }
    })
  }
})

describe('anonymous access matrix: custom and built-in endpoints', () => {
  for (const [key, entry] of Object.entries(endpointMatrix)) {
    it(`${key}`, async () => {
      const [method, pattern] = key.split(' ') as [Parameters<typeof api>[0], string]
      const body = method === 'POST' || method === 'PUT' || method === 'PATCH' ? {} : undefined
      const res = await anon(method, sample(pattern), { body })
      expect(entry.anon, `${key} answered ${res.status}: ${res.text.slice(0, 200)}`).toContain(res.status)
    })
  }

  it('route files: health, graphql, catch-all', async () => {
    const live = await import('../../src/app/(payload)/api/health/live/route')
    const res = await live.GET()
    expect(routeFileMatrix['health/live/route.ts']!.anon).toContain(res.status)
    expect(await res.text()).not.toMatch(/version|postgres|DATABASE|secret|path/i)

    const ready = await import('../../src/app/(payload)/api/health/ready/route')
    const rr = await ready.GET(new Request('http://localhost:3000/api/health/ready', { headers: { 'x-forwarded-for': '203.0.113.9' } }))
    expect(routeFileMatrix['health/ready/route.ts']!.anon).toContain(rr.status)
    const rbody = await rr.text()
    expect(leaksIn(rbody)).toEqual([])
    expect(rbody).not.toMatch(/postgres(ql)?:\/\/|password|\/media|ECONN/i)
  })
})

describe('error hygiene: no stack traces, SQL, file paths or fingerprinting headers', () => {
  const probes: Array<[string, string, unknown?]> = [
    ['GET', "/api/articles?where[slug][equals]='; drop table articles;--"],
    ['GET', '/api/articles?sort=;select pg_sleep(5)'],
    ['GET', '/api/articles?limit=-1&page=abc'],
    ['GET', '/api/articles/not-a-number'],
    ['GET', '/api/articles/1%00'],
    ['GET', '/api/articles?depth=999999'],
    ['GET', '/api/categories?where[title][like]=%00'],
    ['GET', '/api/does-not-exist'],
    ['GET', '/api/users/me?depth=abc'],
    ['POST', '/api/public/contact', 'not json'],
    ['POST', '/api/users/login', '{"email":'],
    ['GET', '/api/public/search?q=%00&page=1e309&limit=NaN'],
    ['GET', '/api/legacy-comments?article=1%27'],
    ['GET', '/api/preview/articles?token=' + 'A'.repeat(5000)],
    ['GET', '/api/media/file/..%2f..%2f.env'],
    ['GET', '/api/media/file/%2e%2e/%2e%2e/etc/passwd'],
  ]
  for (const [method, url, body] of probes) {
    it(`${method} ${url.slice(0, 60)}`, async () => {
      const res = await anon(method as never, url, {
        body,
        headers: typeof body === 'string' ? { 'content-type': 'application/json' } : {},
      })
      expect(res.status, res.text.slice(0, 200)).toBeLessThan(500)
      expect(leaksIn(res.text), res.text.slice(0, 300)).toEqual([])
      expect(res.headers.get('x-powered-by')).toBeNull()
      expect(res.headers.get('server')).toBeNull()
    })
  }
})

describe('HTTP verb tampering and method override', () => {
  it('method-override headers and query params never turn an anonymous GET/POST into a write', async () => {
    const art = await f.seedArticle({ status: 'published' })
    const victim = `/api/articles/${art.id}`
    const tries: Array<[string, string, Record<string, string>]> = [
      ['GET', victim, { 'x-http-method-override': 'DELETE' }],
      ['POST', victim, { 'x-http-method-override': 'DELETE' }],
      ['POST', victim, { 'x-http-method-override': 'PATCH', 'x-method-override': 'PATCH' }],
      ['GET', `${victim}?_method=DELETE`, {}],
      ['POST', `${victim}?_method=DELETE`, {}],
      ['POST', '/api/articles', { 'x-payload-http-method-override': 'GET' }],
      ['POST', '/api/users', { 'x-payload-http-method-override': 'GET' }],
      ['POST', '/api/subscribers', { 'x-payload-http-method-override': 'GET' }],
    ]
    for (const [m, u, h] of tries) {
      const res = await anon(m as never, u, { body: m === 'POST' ? { title: 'pwn' } : undefined, headers: h })
      expect(res.status, `${m} ${u} ${JSON.stringify(h)}`).not.toBe(204)
      expect(res.status).not.toBe(201)
      if (u.startsWith('/api/users') || u.startsWith('/api/subscribers')) {
        expect(res.status, `${u} must stay denied`).toBeGreaterThanOrEqual(400)
        expect(res.text).not.toMatch(/"docs":\[\{/)
      }
    }
    const still = await f.payload.findByID({ collection: 'articles', id: art.id, overrideAccess: true, disableErrors: true })
    expect(still, 'article survived override attempts').toBeTruthy()
    expect((still as { title: string }).title).not.toBe('pwn')
  })

  it('unknown verbs are refused', async () => {
    const unknown = await anon('PUT' as never, '/api/articles/1', { body: {} })
    expect([401, 403, 404, 405, 501]).toContain(unknown.status)
  })
})

describe('GraphQL is disabled (introspection and playground)', () => {
  it('payload.config disables GraphQL and the playground', async () => {
    const cfg = (await config) as unknown as { graphQL: { disable?: boolean; disablePlaygroundInProduction?: boolean } }
    expect(cfg.graphQL.disable).toBe(true)
  })

  it('introspection and mutations over POST /api/graphql are not served', async () => {
    const { POST } = await import('../../src/app/(payload)/api/graphql/route')
    for (const query of [
      '{ __schema { types { name } } }',
      '{ __type(name: "User") { fields { name } } }',
      '{ Articles { docs { id reviewNotes } } }',
      'mutation { createUser(data: { email: "x@x.x", password: "x", role: admin }) { id } }',
    ]) {
      const res = await POST(
        new Request('http://localhost:3000/api/graphql', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.10' },
          body: JSON.stringify({ query }),
        }),
      )
      const text = await res.text()
      expect(res.status, text.slice(0, 200)).not.toBe(200)
      expect(text).not.toMatch(/__schema|"types":\[|"fields":\[|reviewNotes|"id"/)
    }
  })
})

describe('select-field filters (was F-1)', () => {
  it('an invalid enum filter value is a 400, not a 500', async () => {
    for (const q of [
      'where[status][equals]=bogus',
      'where[status][in]=draft,bogus',
      'where[status][not_equals]=%27',
      'where[and][0][status][equals]=bogus',
      'where[category.status][equals]=bogus',
    ]) {
      const res = await anon('GET', `/api/articles?${q}`)
      expect(res.status, q).toBe(400)
    }
    expect((await anon('GET', '/api/articles?where[status][equals]=published')).status).toBe(200)
    expect((await anon('GET', '/api/live-events?where[status][in]=live,ended')).status).toBe(200)
  })

  it('the guard list contains every value of every select field named "status" in payload.config (no staff filter is refused by mistake)', async () => {
    const { STATUS_FILTER_VALUES } = await import('../../src/lib/queryGuards')
    const cfg = await config
    const missing: string[] = []
    for (const col of cfg.collections) {
      for (const field of col.flattenedFields as Array<{ name: string; type: string; options?: Array<string | { value: string }> }>) {
        if (field.name !== 'status' || field.type !== 'select') continue
        for (const o of field.options ?? []) {
          const v = typeof o === 'string' ? o : o.value
          if (!STATUS_FILTER_VALUES.has(v)) missing.push(`${col.slug}.status=${v}`)
        }
      }
    }
    expect(missing, 'add these to STATUS_FILTER_VALUES in src/lib/queryGuards.ts').toEqual([])
  })
})
