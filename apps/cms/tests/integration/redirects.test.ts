import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { resetRedirectsCache } from '../../src/endpoints/publicRedirects'
import { runCheck, runExport, runImport } from '../../src/lib/redirectCli'
import { api, newRunId, setupFixtures, type Fixtures } from './helpers'

/**
 * Go-live C7. Everything below goes through the real REST route handlers and a real PostgreSQL (embedded), with the
 * real collection hooks. The CLI commands are called as functions with the live Payload instance (not through the
 * `payload run` process wrapper) and a captured log. No mocks.
 */

const runId = newRunId()
const ALLOWED_ORIGIN = 'http://allowed.test' // PUBLIC_SUBMISSION_ORIGINS in tests/integration/global-setup.ts
let f: Fixtures
let tmp: string

const env = process.env
const saved = {
  hosts: env.REDIRECT_ALLOWED_HOSTS,
  template: env.PUBLIC_ARTICLE_PATH_TEMPLATE,
}

beforeAll(async () => {
  env.REDIRECT_ALLOWED_HOSTS = 'www.example.test'
  delete env.PUBLIC_ARTICLE_PATH_TEMPLATE
  f = await setupFixtures(runId)
  tmp = mkdtempSync(path.join(tmpdir(), 'ct-redirects-'))
})

afterAll(async () => {
  const del = (collection: string, where: Record<string, unknown>) =>
    f?.payload.delete({ collection: collection as never, where: where as never, overrideAccess: true }).catch(() => undefined)
  await del('redirects', { from: { like: runId } })
  await del('redirects', { to: { like: runId } })
  await del('audit-logs', { collection: { equals: 'redirects' } })
  await f?.cleanup()
  if (tmp) rmSync(tmp, { recursive: true, force: true })
  for (const [key, value] of [
    ['REDIRECT_ALLOWED_HOSTS', saved.hosts],
    ['PUBLIC_ARTICLE_PATH_TEMPLATE', saved.template],
  ] as const) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
})

beforeEach(() => {
  resetRedirectsCache()
})

const p = (name: string) => `/${runId}-${name}/`
const post = (token: string | undefined, body: Record<string, unknown>) => api('POST', '/api/redirects', { token, body })
const patch = (token: string, id: number, body: Record<string, unknown>) => api('PATCH', `/api/redirects/${id}`, { token, body })
const messages = (res: { json: any }): string => JSON.stringify(res.json?.errors ?? res.json)

/** Create as editor-in-chief and return the id (fails the test when the write is refused). */
async function rule(from: string, to: string | null, extra: Record<string, unknown> = {}): Promise<number> {
  const res = await post(f.tokens.eic, { from, ...(to === null ? {} : { to }), ...extra })
  expect(res.status, messages(res)).toBe(201)
  return res.json.doc.id as number
}

const getList = (headers: Record<string, string> = {}) => api('GET', '/api/public/redirects', { headers })
const mine = (rules: any[]) => rules.filter((r) => String(r.from).includes(runId) || String(r.to ?? '').includes(runId))

describe('C7 redirects collection: access', () => {
  it('anonymous callers cannot read, create, update or delete', async () => {
    const id = await rule(p('acc'), '/')
    expect((await api('GET', '/api/redirects')).status).toBe(403)
    expect((await api('GET', `/api/redirects/${id}`)).status).toBe(403)
    expect((await post(undefined, { from: p('anon'), to: '/' })).status).toBe(403)
    expect((await api('PATCH', `/api/redirects/${id}`, { body: { to: '/x/' } })).status).toBe(403)
    expect((await api('DELETE', `/api/redirects/${id}`)).status).toBe(403)
  })

  it('every staff role can read; only admin and editor-in-chief can write', async () => {
    const id = await rule(p('staff'), '/')
    for (const role of ['reporter', 'sectionEditor', 'trusted', 'eic', 'admin'] as const) {
      const res = await api('GET', `/api/redirects/${id}`, { token: f.tokens[role] })
      expect(res.status, role).toBe(200)
    }
    for (const role of ['reporter', 'reporter2', 'sectionEditor', 'trusted'] as const) {
      expect((await post(f.tokens[role], { from: p(`no-${role}`), to: '/' })).status, `create ${role}`).toBe(403)
      expect((await patch(f.tokens[role], id, { note: 'x' })).status, `update ${role}`).toBe(403)
      expect((await api('DELETE', `/api/redirects/${id}`, { token: f.tokens[role] })).status, `delete ${role}`).toBe(403)
    }
    const byAdmin = await post(f.tokens.admin, { from: p('by-admin'), to: '/' })
    expect(byAdmin.status).toBe(201)
    expect((await patch(f.tokens.admin, byAdmin.json.doc.id, { note: 'admin edit' })).status).toBe(200)
    expect((await api('DELETE', `/api/redirects/${byAdmin.json.doc.id}`, { token: f.tokens.eic })).status).toBe(200)
  })
})

describe('C7 redirects collection: write validation', () => {
  it('stores canonical paths, defaults status and source, and clears `to` for a 410', async () => {
    const res = await post(f.tokens.eic, { from: `/${runId}-Caf%c3%a9`, to: `/${runId}-dest`, note: ' <b>old</b> page ' })
    expect(res.status, messages(res)).toBe(201)
    expect(res.json.doc).toMatchObject({ from: `/${runId}-Caf%C3%A9/`, to: `/${runId}-dest/`, status: 301, source: 'manual', note: 'old page' })

    const gone = await post(f.tokens.eic, { from: p('gone'), to: '/ignored/', status: 410 })
    expect(gone.status, messages(gone)).toBe(201)
    expect(gone.json.doc.to).toBeNull()
    const back = await patch(f.tokens.eic, gone.json.doc.id, { status: 302 })
    expect(back.status).toBe(400)
    expect(messages(back)).toMatch(/is required for a 301 or 302/)
  })

  it('accepts an https target on an allowed host and refuses other hosts, http, queries and non-paths', async () => {
    expect((await post(f.tokens.eic, { from: p('ext'), to: 'https://WWW.example.test/Page' })).json.doc.to).toBe('https://www.example.test/Page/')
    for (const to of ['https://evil.example.test/', 'http://www.example.test/', '//www.example.test/', 'https://www.example.test/?a=1', 'javascript:alert(1)', 'relative/path/']) {
      const res = await post(f.tokens.eic, { from: p(`bad-${Math.abs(hash(to))}`), to })
      expect(res.status, to).toBe(400)
    }
  })

  it('refuses malformed `from` values', async () => {
    for (const from of ['/', 'no-slash', 'https://example.test/a/', '/a/../b/', '/a/?x=1', '/a/#f', '/cat/*', '/a\\b/', '/a%0D%0Ab/', '/a//b/', '']) {
      const res = await post(f.tokens.eic, { from, to: '/x/' })
      expect(res.status, JSON.stringify(from)).toBe(400)
    }
    expect((await post(f.tokens.eic, { from: p('st'), to: '/x/', status: 307 })).status).toBe(400)
    expect((await post(f.tokens.eic, { from: p('src'), to: '/x/', source: 'other' })).status).toBe(400)
    expect((await post(f.tokens.eic, { from: p('nt'), to: '/x/', note: { a: 1 } })).status).toBe(400)
  })

  it('treats two spellings of one address as a duplicate and names the existing rule', async () => {
    const id = await rule(`/${runId}-dup-caf%c3%a9`, '/x/')
    const again = await post(f.tokens.eic, { from: `/${runId}-dup-café/`, to: '/y/' })
    expect(again.status).toBe(400)
    expect(messages(again)).toContain(`rule #${id}`)
  })
})

describe('C7 redirects collection: loops and chains are refused at write time, naming the rule', () => {
  it('refuses a self-loop and a two-rule loop', async () => {
    const self = await post(f.tokens.eic, { from: p('self'), to: p('self') })
    expect(self.status).toBe(400)
    expect(messages(self)).toMatch(/Loop/)

    const a = await rule(p('la'), p('lb'))
    const closing = await post(f.tokens.eic, { from: p('lb'), to: p('la') })
    expect(closing.status).toBe(400)
    expect(messages(closing)).toMatch(/Loop/)
    expect(messages(closing)).toContain(`rule #${a}`)
  })

  it('refuses a manual row that chains, in both directions, naming the other rule', async () => {
    const a = await rule(p('ca'), p('cb'))
    const forward = await post(f.tokens.eic, { from: p('cz'), to: p('ca') }) // cz -> ca -> cb
    expect(forward.status).toBe(400)
    expect(messages(forward)).toMatch(/Chain/)
    expect(messages(forward)).toContain(`rule #${a}`)

    const backward = await post(f.tokens.eic, { from: p('cb'), to: p('cc') }) // ca -> cb -> cc
    expect(backward.status).toBe(400)
    expect(messages(backward)).toMatch(/Chain/)
    expect(messages(backward)).toContain(`rule #${a}`)
  })

  it('refuses an update that would create a loop or a chain', async () => {
    const x = await rule(p('ux'), p('uy'))
    const z = await rule(p('uz'), p('u-final'))
    const loop = await patch(f.tokens.eic, z, { to: p('ux') })
    expect(loop.status).toBe(400)
    expect(messages(loop)).toMatch(/Chain|Loop/)
    const selfLoop = await patch(f.tokens.eic, x, { to: p('ux') })
    expect(selfLoop.status).toBe(400)
    expect(messages(selfLoop)).toMatch(/Loop/)
    // unchanged rows stay as they were
    expect((await api('GET', `/api/redirects/${x}`, { token: f.tokens.eic })).json.to).toBe(p('uy'))
  })

  it('lets rank-math rows chain (flattened at generation) but never loop', async () => {
    const target = p('rm-target')
    await rule(target, p('rm-final'))
    const chained = await post(f.tokens.eic, { from: p('rm-entry'), to: target, source: 'rank-math' })
    expect(chained.status, messages(chained)).toBe(201)
    const loop = await post(f.tokens.eic, { from: p('rm-final'), to: p('rm-entry'), source: 'rank-math' })
    expect(loop.status).toBe(400)
    expect(messages(loop)).toMatch(/Loop/)
  })

  it('refuses a rule at the live address of a published article, and a duplicate of a derived rule', async () => {
    const live = await f.seedArticle({ status: 'published', legacyUrl: `https://old.example.test/${runId}-wl/` })
    const hide = await post(f.tokens.eic, { from: `/reports/${live.slug}/`, to: '/x/' })
    expect(hide.status).toBe(400)
    expect(messages(hide)).toContain(live.slug)
    const dup = await post(f.tokens.eic, { from: p('wl'), to: '/x/' })
    expect(dup.status).toBe(400)
    expect(messages(dup)).toContain(`article \\"${live.slug}\\"`)
    const chainIntoDerived = await post(f.tokens.eic, { from: p('wl-in'), to: p('wl') })
    expect(chainIntoDerived.status).toBe(400)
    expect(messages(chainIntoDerived)).toMatch(/Chain/)
  })
})

describe('C7 redirects collection: audit', () => {
  it('records create, update and delete for editor-in-chief to read', async () => {
    const id = await rule(p('aud'), p('aud-dest'))
    await patch(f.tokens.admin, id, { to: p('aud-dest2') })
    await api('DELETE', `/api/redirects/${id}`, { token: f.tokens.eic })
    const res = await api('GET', `/api/audit-logs?where[collection][equals]=redirects&where[docId][equals]=${id}&sort=createdAt&limit=10`, {
      token: f.tokens.eic,
    })
    expect(res.status).toBe(200)
    expect(res.json.docs.map((d: any) => d.action)).toEqual(['redirect.create', 'redirect.update', 'redirect.delete'])
    expect(res.json.docs[1].details).toMatchObject({ before: { to: p('aud-dest') }, after: { to: p('aud-dest2') } })
    expect(res.json.docs[0].actorRole).toBe('editor-in-chief')
    expect(res.json.docs[1].actorRole).toBe('admin')
    // the audit log itself stays staff-private
    expect((await api('GET', '/api/audit-logs', { token: f.tokens.reporter })).status).toBe(403)
  })
})

describe('C7.3 GET /api/public/redirects', () => {
  let published: { id: number; slug: string }
  let sameAddress: { id: number; slug: string }
  let draft: { id: number; slug: string }
  let archived: { id: number; slug: string }

  beforeAll(async () => {
    published = await f.seedArticle({ status: 'published', legacyUrl: `https://old.example.test/2019/05/${runId}-pub-old/` })
    sameAddress = await f.seedArticle({ status: 'published' })
    await f.payload.update({
      collection: 'articles',
      id: sameAddress.id,
      data: { legacyUrl: `https://old.example.test/reports/${sameAddress.slug}/` } as never,
      overrideAccess: true,
      context: { seed: true },
    })
    draft = await f.seedArticle({ status: 'draft', legacyUrl: `https://old.example.test/${runId}-draft-old/` })
    archived = await f.seedArticle({ status: 'archived', legacyUrl: `https://old.example.test/${runId}-archived-old/` })
    await rule(p('pub-manual'), '/', { note: 'internal note should never be public' })
    await rule(p('pub-gone'), null, { status: 410 })
  })

  it('is anonymous, sorted, well-formed, and carries ETag and Cache-Control', async () => {
    const res = await getList()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/application\/json/)
    expect(res.headers.get('cache-control')).toBe('public, max-age=300')
    const body = res.json
    expect(body.version).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(res.headers.get('etag')).toBe(`"${body.version}"`)
    expect(body.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    expect(body.count).toBe(body.rules.length)
    const froms = body.rules.map((r: any) => r.from)
    expect(froms).toEqual([...froms].sort())
    for (const rule of body.rules) expect(Object.keys(rule).sort()).toEqual(['from', 'source', 'status', 'to'])
  })

  it('contains stored rows and the derived rule for a published article whose legacy address differs', async () => {
    const rules = (await getList()).json.rules
    expect(rules.find((r: any) => r.from === p('pub-manual'))).toEqual({ from: p('pub-manual'), to: '/', status: 301, source: 'manual' })
    expect(rules.find((r: any) => r.from === p('pub-gone'))).toEqual({ from: p('pub-gone'), to: null, status: 410, source: 'manual' })
    expect(rules.find((r: any) => r.from === `/2019/05/${runId}-pub-old/`)).toEqual({
      from: `/2019/05/${runId}-pub-old/`,
      to: `/reports/${published.slug}/`,
      status: 301,
      source: 'legacy-url',
    })
  })

  it('emits no rule when the legacy address already equals the current one', async () => {
    const rules = (await getList()).json.rules
    expect(rules.some((r: any) => r.from === `/reports/${sameAddress.slug}/`)).toBe(false)
  })

  it('never exposes unpublished or archived articles, notes, ids or staff data', async () => {
    const res = await getList()
    for (const needle of [draft.slug, archived.slug, `${runId}-draft-old`, `${runId}-archived-old`, 'internal note', '@test.invalid', '"id"', 'reviewNotes', '"note"']) {
      expect(res.text, needle).not.toContain(needle)
    }
    // becomes visible only once published, and disappears again when archived
    await f.payload.update({ collection: 'articles', id: draft.id, data: { status: 'published' } as never, overrideAccess: true, context: { seed: true } })
    resetRedirectsCache()
    expect((await getList()).json.rules.some((r: any) => r.from === `/${runId}-draft-old/`)).toBe(true)
    await f.payload.update({ collection: 'articles', id: draft.id, data: { status: 'archived' } as never, overrideAccess: true, context: { seed: true } })
    resetRedirectsCache()
    expect((await getList()).json.rules.some((r: any) => r.from === `/${runId}-draft-old/`)).toBe(false)
  })

  it('answers 304 to a matching If-None-Match (strong, weak and list forms) and 200 to a stale one', async () => {
    const first = await getList()
    const etag = first.headers.get('etag')!
    const cached = await getList({ 'if-none-match': etag })
    expect(cached.status).toBe(304)
    expect(cached.text).toBe('')
    expect(cached.headers.get('etag')).toBe(etag)
    expect(cached.headers.get('cache-control')).toBe('public, max-age=300')
    expect((await getList({ 'if-none-match': `W/${etag}` })).status).toBe(304)
    expect((await getList({ 'if-none-match': `"other", ${etag}` })).status).toBe(304)
    expect((await getList({ 'if-none-match': '*' })).status).toBe(304)
    expect((await getList({ 'if-none-match': '"sha256:stale"' })).status).toBe(200)
  })

  it('changes the version when content changes and keeps it when nothing changed', async () => {
    const v1 = (await getList()).json.version
    resetRedirectsCache()
    expect((await getList()).json.version).toBe(v1)
    await rule(p('v2'), '/')
    resetRedirectsCache()
    expect((await getList()).json.version).not.toBe(v1)
  })

  it('flattens a chain through a derived rule and reports it in the served list', async () => {
    const art = await f.seedArticle({ status: 'published', legacyUrl: `https://old.example.test/${runId}-chain-old/` })
    await rule(p('chain-entry'), p('chain-old'), { source: 'rank-math' })
    resetRedirectsCache()
    const rules = (await getList()).json.rules
    expect(rules.find((r: any) => r.from === p('chain-entry'))?.to).toBe(`/reports/${art.slug}/`)
    expect(rules.find((r: any) => r.from === p('chain-old'))?.to).toBe(`/reports/${art.slug}/`)
  })

  it('follows PUBLIC_ARTICLE_PATH_TEMPLATE and refuses an invalid value loudly', async () => {
    env.PUBLIC_ARTICLE_PATH_TEMPLATE = '/{slug}/'
    try {
      resetRedirectsCache()
      const rules = (await getList()).json.rules
      expect(rules.find((r: any) => r.from === `/2019/05/${runId}-pub-old/`)?.to).toBe(`/${published.slug}/`)
      // with the short template an article whose legacy address was /reports/<slug>/ now needs a rule
      expect(rules.find((r: any) => r.from === `/reports/${sameAddress.slug}/`)?.to).toBe(`/${sameAddress.slug}/`)

      env.PUBLIC_ARTICLE_PATH_TEMPLATE = '/news/{slug}/'
      resetRedirectsCache()
      const bad = await getList()
      expect(bad.status).toBe(500)
      expect(bad.headers.get('cache-control')).toBe('no-store')
      expect(bad.json.errors[0].message).not.toMatch(/news/)
    } finally {
      delete env.PUBLIC_ARTICLE_PATH_TEMPLATE
    }
  })

  it('refuses (500, never a partial list) when two articles claim one legacy address', async () => {
    const one = await f.seedArticle({ status: 'published', legacyUrl: `https://old.example.test/${runId}-clash/` })
    const two = await f.seedArticle({ status: 'published', legacyUrl: `https://old.example.test/${runId}-clash` })
    resetRedirectsCache()
    const res = await getList()
    expect(res.status).toBe(500)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.text).not.toContain(one.slug)
    expect(res.json).toEqual({ ok: false, errors: [{ message: 'The redirect list is temporarily unavailable.' }] })
    await f.payload.update({ collection: 'articles', id: two.id, data: { status: 'draft' } as never, overrideAccess: true, context: { seed: true } })
    resetRedirectsCache()
    expect((await getList()).status).toBe(200)
  })

  it('is GET only for anonymous callers, and follows the shared Origin and CORS rules', async () => {
    for (const method of ['POST', 'PATCH', 'DELETE'] as const) {
      const res = await api(method, '/api/public/redirects', { body: {} })
      expect(res.status, method).toBeGreaterThanOrEqual(400)
      expect(res.status, method).toBeLessThan(500)
    }
    const ok = await getList({ origin: ALLOWED_ORIGIN })
    expect(ok.status).toBe(200)
    expect(ok.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN)
    expect(ok.headers.get('access-control-expose-headers')).toMatch(/ETag/)
    expect(ok.headers.get('access-control-allow-credentials')).toBeNull()
    expect(ok.headers.get('vary')).toMatch(/Origin/)

    const foreign = await getList({ origin: 'http://not-allowed.test' })
    expect(foreign.status).toBe(403)
    expect(foreign.headers.get('access-control-allow-origin')).toBeNull()

    const none = await getList()
    expect(none.status).toBe(200)
    expect(none.headers.get('access-control-allow-origin')).toBeNull()

    const preflight = await api('OPTIONS', '/api/public/redirects', { headers: { origin: ALLOWED_ORIGIN, 'access-control-request-method': 'GET' } })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN)
    expect(preflight.headers.get('access-control-allow-methods')).toMatch(/GET/)
    expect((await api('OPTIONS', '/api/public/redirects', { headers: { origin: 'http://not-allowed.test' } })).status).toBe(403)
  })
})

describe('C7.3 commands (called as functions against the real database)', () => {
  const capture = () => {
    const lines: string[] = []
    return { lines, log: { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) } }
  }

  it('export:redirects writes the same list the endpoint serves', async () => {
    const out = path.join(tmp, 'redirects.json')
    const { lines, log } = capture()
    expect(await runExport(f.payload, ['--out', out], log)).toBe(0)
    const written = JSON.parse(readFileSync(out, 'utf8'))
    resetRedirectsCache()
    const served = (await getList()).json
    expect(written.version).toBe(served.version)
    expect(written.rules).toEqual(served.rules)
    expect(lines.join('\n')).toMatch(/generated artifact: do not commit/)
    expect(await runExport(f.payload, [], capture().log)).toBe(2) // --out is required
  })

  it('check:redirects prints counts only and exits non-zero while anything is unresolved', async () => {
    const live = await f.seedArticle({ status: 'published', legacyUrl: `https://old.example.test/${runId}-chk-old/` })
    await rule(p('chk-moved'), '/')
    await rule(p('chk-gone'), null, { status: 410 })
    const urls = path.join(tmp, 'urls.txt')
    const addresses = [
      `# top URLs`,
      `https://old.example.test/${runId}-chk-old`,
      p('chk-moved'),
      `${p('chk-gone')}?utm_source=x`,
      `/reports/${live.slug}/`,
    ]
    writeFileSync(urls, addresses.join('\n'))
    const ok = capture()
    expect(await runCheck(f.payload, ['--urls', urls], ok.log)).toBe(0)
    expect(ok.lines.join('\n')).toMatch(/Checked 4 addresses \(1 blank or comment lines ignored\): 4 resolved, 0 unresolved/)
    expect(ok.lines.join('\n')).toMatch(/301=2 302=0 410=1 live-article=1/)

    writeFileSync(urls, [...addresses, `/${runId}-secret-unresolved-address/`, 'https://old.example.test/?p=99'].join('\n'))
    const bad = capture()
    expect(await runCheck(f.payload, ['--urls', urls], bad.log)).toBe(1)
    const out = bad.lines.join('\n')
    expect(out).toMatch(/6 addresses/)
    expect(out).toMatch(/4 resolved, 2 unresolved/)
    expect(out).toMatch(/no-rule=1 query-only=1/)
    // addresses are never printed
    for (const needle of [runId, 'secret-unresolved', 'old.example.test', 'chk-']) expect(out, needle).not.toContain(needle)
    expect(await runCheck(f.payload, ['--urls', path.join(tmp, 'missing.txt')], capture().log)).toBe(2)
  })

  it('import:redirects is a dry run by default, applies with --apply, and prints counts only', async () => {
    await rule(p('imp-existing'), '/')
    const csv = path.join(tmp, 'rank-math.csv')
    writeFileSync(
      csv,
      [
        'from,to,status',
        `/${runId}-imp-a,/${runId}-imp-b,301`,
        `/${runId}-imp-b,/${runId}-imp-c,`,
        `/${runId}-imp-loop-1,/${runId}-imp-loop-2,301`,
        `/${runId}-imp-loop-2,/${runId}-imp-loop-1,301`,
        `/${runId}-imp-existing,/x/,301`,
        `/${runId}-imp-pattern/*,/x/,301`,
        `/${runId}-imp-badhost,https://evil.example.test/,301`,
        `/${runId}-imp-dup,/x/,301`,
        `/${runId}-imp-dup/,/y/,301`,
        `/${runId}-imp-gone,,410`,
        `/${runId}-imp-ext,https://www.example.test/landing,302`,
      ].join('\n'),
    )
    const before = (await f.payload.count({ collection: 'redirects', where: { from: { like: `${runId}-imp-` } }, overrideAccess: true })).totalDocs
    const dry = capture()
    expect(await runImport(f.payload, ['--file', csv], dry.log)).toBe(0)
    const dryText = dry.lines.join('\n')
    expect(dryText).toMatch(/Dry run: 11 rows, 6 would be created/)
    expect(dryText).toMatch(/invalid-to=1 .*pattern=1 duplicate-in-file=1 already-stored=1 .*loops=1/)
    expect(dryText).toMatch(/Nothing was written/)
    expect((await f.payload.count({ collection: 'redirects', where: { from: { like: `${runId}-imp-` } }, overrideAccess: true })).totalDocs).toBe(before)

    const applied = capture()
    expect(await runImport(f.payload, ['--file', csv, '--apply'], applied.log)).toBe(0)
    expect(applied.lines.join('\n')).toMatch(/Created 6 rows\. Source is rank-math/)
    for (const text of [dryText, applied.lines.join('\n')]) {
      for (const needle of [runId, 'evil.example', 'imp-']) expect(text, needle).not.toContain(needle)
    }
    const rows = await f.payload.find({
      collection: 'redirects',
      where: { and: [{ from: { like: `${runId}-imp-` } }, { source: { equals: 'rank-math' } }] },
      limit: 50,
      overrideAccess: true,
    })
    expect(rows.totalDocs).toBe(6)
    expect(rows.docs.find((r: any) => r.from === p('imp-gone'))).toMatchObject({ status: 410, to: null })
    expect(rows.docs.find((r: any) => r.from === p('imp-ext'))).toMatchObject({ status: 302, to: 'https://www.example.test/landing/' })
    const audit = await f.payload.find({ collection: 'audit-logs', where: { action: { equals: 'redirect.import' } }, limit: 5, overrideAccess: true })
    expect(audit.totalDocs).toBeGreaterThanOrEqual(1)

    // the imported chain a -> b -> c is flattened in the served list
    resetRedirectsCache()
    const served = (await getList()).json.rules
    expect(served.find((r: any) => r.from === p('imp-a'))?.to).toBe(p('imp-c'))

    // a second run finds everything already stored
    const again = capture()
    expect(await runImport(f.payload, ['--file', csv], again.log)).toBe(0)
    expect(again.lines.join('\n')).toMatch(/0 would be created/)
    expect(await runImport(f.payload, [], capture().log)).toBe(2)
  })
})

function hash(text: string): number {
  let h = 0
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) | 0
  return h
}
