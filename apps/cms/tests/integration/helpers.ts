import { randomBytes } from 'node:crypto'

import config from '@payload-config'
import { REST_DELETE, REST_GET, REST_OPTIONS, REST_PATCH, REST_POST } from '@payloadcms/next/routes'
import { getPayload, type Payload } from 'payload'

import { textToLexical } from '../../src/endpoints/convertSubmission'
import { migrations } from '../../src/migrations'

export const PASSWORD = 'Test-only-pass-1234!'
export const ORIGIN = 'http://localhost:3000'

/** Unique per test file run; prefixes every record so files never collide and cleanup is exact. */
export const newRunId = (): string => `t${randomBytes(4).toString('hex')}`

const handlers = {
  GET: REST_GET(config),
  // Next hands a HEAD request to the GET route handler; Payload then picks the endpoint registered for method head.
  HEAD: REST_GET(config),
  POST: REST_POST(config),
  PATCH: REST_PATCH(config),
  DELETE: REST_DELETE(config),
  OPTIONS: REST_OPTIONS(config),
}

export type ApiOptions = {
  token?: string
  body?: unknown
  headers?: Record<string, string>
}

export type ApiResult = {
  status: number
  headers: Headers
  json: any
  text: string
}

/**
 * Issue a real `Request` through the same Next route handlers the app mounts at /api/[...slug].
 * (`REST_*` expect `{ params: Promise<{ slug: string[] }> }`, the catch-all path segments.)
 */
export async function api(
  method: keyof typeof handlers,
  url: string,
  options: ApiOptions = {},
): Promise<ApiResult> {
  const u = new URL(url, ORIGIN)
  const slug = u.pathname
    .replace(/^\/api\/?/, '')
    .split('/')
    .filter(Boolean)
    .map(decodeURIComponent)

  const headers = new Headers(options.headers)
  if (options.token) headers.set('Authorization', `JWT ${options.token}`)

  let body: BodyInit | undefined
  if (options.body instanceof FormData || typeof options.body === 'string') {
    body = options.body as BodyInit
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body)
    if (!headers.has('content-type')) headers.set('content-type', 'application/json')
  }

  const request = new Request(u, { method, headers, body })
  const res = await handlers[method](request, { params: Promise.resolve({ slug }) })
  const text = await res.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { status: res.status, headers: res.headers, json, text }
}

export const lexical = (text = 'Body text for an integration test article.') => textToLexical(text)

export type Fixtures = Awaited<ReturnType<typeof setupFixtures>>

type UserKey = 'reporter' | 'reporter2' | 'sectionEditor' | 'trusted' | 'eic' | 'admin'

/**
 * Boots Payload, applies the committed migrations (idempotent), and creates categories and one
 * user per role under a unique run prefix.
 */
export async function setupFixtures(runId: string) {
  const payload: Payload = await getPayload({ config })
  // Pass the committed migrations explicitly: Payload's file loader uses a native import() that
  // cannot load the generated .ts files under vitest. Idempotent: applied migrations are skipped.
  await payload.db.migrate({ migrations: migrations as never })

  const mkCat = async (key: string) =>
    (await payload.create({
      collection: 'categories',
      data: { title: `${runId} ${key}`, slug: `${runId}-cat-${key}` },
      overrideAccess: true,
    })) as { id: number }
  const catA = await mkCat('a')
  const catB = await mkCat('b')

  const spec: Record<UserKey, { role: string; sections: number[] }> = {
    reporter: { role: 'reporter', sections: [] },
    reporter2: { role: 'reporter', sections: [] },
    sectionEditor: { role: 'section-editor', sections: [catA.id] },
    trusted: { role: 'trusted-publisher', sections: [catA.id] },
    eic: { role: 'editor-in-chief', sections: [] },
    admin: { role: 'admin', sections: [] },
  }

  const users = {} as Record<UserKey, { id: number; email: string }>
  const tokens = {} as Record<UserKey, string>
  for (const key of Object.keys(spec) as UserKey[]) {
    const email = `${runId}-${key}@test.invalid`
    const u = (await payload.create({
      collection: 'users',
      data: { email, name: `${runId} ${key}`, password: PASSWORD, ...spec[key] } as never,
      overrideAccess: true,
    })) as { id: number }
    users[key] = { id: u.id, email }
    const login = await payload.login({ collection: 'users', data: { email, password: PASSWORD } })
    tokens[key] = login.token as string
  }

  const created = { articles: [] as number[], media: [] as number[] }
  let n = 0
  const uniq = (label: string) => `${runId}-${label}-${++n}`

  /** Create an article through the real REST API as `token`. */
  const createArticle = async (
    token: string,
    data: Record<string, unknown> = {},
  ): Promise<ApiResult & { id?: number }> => {
    const label = uniq('art')
    const res = await api('POST', '/api/articles', {
      token,
      body: { title: label, slug: label, content: lexical(), category: catA.id, ...data },
    })
    const id = res.json?.doc?.id as number | undefined
    if (id) created.articles.push(id)
    return Object.assign(res, { id })
  }

  /** Create an article directly as the system (bypassing workflow), for arrange steps. */
  const seedArticle = async (data: Record<string, unknown> = {}) => {
    const label = uniq('seed')
    const doc = (await payload.create({
      collection: 'articles',
      data: {
        title: label,
        slug: label,
        content: lexical(),
        category: catA.id,
        status: 'draft',
        ...data,
      } as never,
      overrideAccess: true,
      context: { seed: true },
    })) as { id: number; slug: string }
    created.articles.push(doc.id)
    return doc
  }

  const cleanup = async () => {
    const run = async (fn: () => Promise<unknown>) => {
      try {
        await fn()
      } catch {
        // best effort
      }
    }
    const del = (collection: string, where: Record<string, unknown>) =>
      run(() => payload.delete({ collection: collection as never, where: where as never, overrideAccess: true }))
    const like = (field: string) => ({ [field]: { like: runId } })

    const userIds = Object.values(users).map((u) => u.id)
    const articleIds = (
      await payload
        .find({ collection: 'articles', where: like('slug'), limit: 1000, depth: 0, overrideAccess: true })
        .catch(() => ({ docs: [] as { id: number }[] }))
    ).docs.map((d) => d.id)

    const events = await payload
      .find({ collection: 'live-events', where: like('slug'), limit: 1000, depth: 0, overrideAccess: true })
      .catch(() => ({ docs: [] as { id: number }[] }))
    const eventIds = events.docs.map((d) => d.id)
    if (eventIds.length) await del('live-updates', { event: { in: eventIds } })
    await del('live-events', like('slug'))
    await del('submissions', like('title'))
    // legacy-comments.article is required (FK), so the comments must go before their articles.
    if (articleIds.length) await del('legacy-comments', { article: { in: articleIds } })
    await del('articles', like('slug'))
    await del('media', like('alt'))
    await del('audit-logs', {
      or: [
        { actor: { in: userIds } },
        ...(articleIds.length ? [{ and: [{ collection: { equals: 'articles' } }, { docId: { in: articleIds.map(String) } }] }] : []),
        { and: [{ collection: { in: ['live-events', 'live-updates', 'submissions', 'users'] } }, { summary: { like: runId } }] },
      ],
    })
    await del('users', like('email'))
    await del('categories', like('slug'))
    await run(() => payload.destroy())
  }

  return { payload, runId, catA, catB, users, tokens, createArticle, seedArticle, uniq, created, cleanup }
}
