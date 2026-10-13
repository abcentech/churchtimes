/**
 * Role permissions and the editorial workflow against the real server, ending in public visibility.
 * Creates its own articles (slug prefix = run id) and deletes them again.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { Client, categoryId, lexical, loginAs, newRunId, NEWSROOM_ORIGIN } from './support'

const runId = newRunId()
const created: number[] = []

let reporter: Client
let editor: Client
let admin: Client
let anon: Client
let cat: number

const createArticle = async (c: Client, label: string, extra: Record<string, unknown> = {}) => {
  const slug = `${runId}-${label}`
  const res = await c.post('/api/articles', {
    json: { title: `${runId} ${label}`, slug, content: lexical(`Body for ${label}.`), category: cat, ...extra },
  })
  const id = res.json?.doc?.id as number | undefined
  if (id) created.push(id)
  return { res, id, slug }
}

beforeAll(async () => {
  reporter = (await loginAs('reporter', NEWSROOM_ORIGIN)).client
  editor = (await loginAs('editor-in-chief', NEWSROOM_ORIGIN)).client
  admin = (await loginAs('admin')).client
  anon = new Client()
  cat = await categoryId(anon)
})

afterAll(async () => {
  for (const id of created) await admin?.del(`/api/articles/${id}`).catch(() => undefined)
})

describe('role permissions on the article workflow', () => {
  it('a reporter can create a draft (status forced to a non-published state, author = the reporter)', async () => {
    const { res, id } = await createArticle(reporter, 'reporter-draft', { status: 'draft' })
    expect(res.status).toBe(201)
    expect(id).toBeTypeOf('number')
    expect(res.json.doc.status).toBe('draft')
    expect(res.json.doc.publishedAt ?? null).toBeNull()
  })

  it('a reporter CANNOT publish: PATCH status=published -> 403 and the article stays a draft', async () => {
    const { id } = await createArticle(reporter, 'reporter-publish', { status: 'draft' })
    const res = await reporter.patch(`/api/articles/${id}`, { json: { status: 'published' } })
    expect(res.status).toBe(403)
    const after = await admin.get(`/api/articles/${id}`)
    expect(after.json.status).toBe('draft')
    expect(after.json.publishedAt ?? null).toBeNull()
  })

  it('a reporter CANNOT create an article directly as published -> 403', async () => {
    const res = await reporter.post('/api/articles', {
      json: { title: `${runId} direct`, slug: `${runId}-direct`, content: lexical('x'), category: cat, status: 'published' },
    })
    if (res.json?.doc?.id) created.push(res.json.doc.id)
    expect(res.status).toBe(403)
  })

  it('a reporter CAN submit for review (draft -> in_review) but CANNOT approve their own work -> 403', async () => {
    const { id } = await createArticle(reporter, 'reporter-approve', { status: 'draft' })
    const submit = await reporter.patch(`/api/articles/${id}`, { json: { status: 'in_review' } })
    expect(submit.status).toBe(200)
    expect(submit.json.doc.status).toBe('in_review')

    const approve = await reporter.patch(`/api/articles/${id}`, { json: { status: 'approved' } })
    expect(approve.status).toBe(403)
    expect((await admin.get(`/api/articles/${id}`)).json.status).toBe('in_review')
  })

  it('a reporter CANNOT delete articles', async () => {
    const { id } = await createArticle(reporter, 'reporter-delete', { status: 'draft' })
    const res = await reporter.del(`/api/articles/${id}`)
    expect([403, 404]).toContain(res.status)
    expect((await admin.get(`/api/articles/${id}`)).status).toBe(200)
  })

  it('an editor-in-chief approves (in_review -> approved) and then publishes; publishedAt is set by the server', async () => {
    const { id, slug } = await createArticle(reporter, 'editor-flow', { status: 'in_review' })

    const approve = await editor.patch(`/api/articles/${id}`, { json: { status: 'approved' } })
    expect(approve.status).toBe(200)
    expect(approve.json.doc.status).toBe('approved')

    // Not public yet.
    const hidden = await anon.get(`/api/articles?where[slug][equals]=${slug}`, { credentials: false })
    expect(hidden.json.docs).toHaveLength(0)

    const bogusDate = '1999-01-01T00:00:00.000Z'
    const publish = await editor.patch(`/api/articles/${id}`, { json: { status: 'published', publishedAt: bogusDate } })
    expect(publish.status).toBe(200)
    expect(publish.json.doc.status).toBe('published')
    expect(publish.json.doc.publishedAt, 'publishedAt is server-owned').not.toBe(bogusDate)
    expect(Date.parse(publish.json.doc.publishedAt)).toBeGreaterThan(Date.now() - 60_000)

    // Publish -> public display.
    const pub = await anon.get(`/api/articles?where[slug][equals]=${slug}&depth=1`, { credentials: false })
    expect(pub.status).toBe(200)
    expect(pub.json.docs).toHaveLength(1)
    expect(pub.json.docs[0]).toMatchObject({ slug, status: 'published' })
    expect(pub.json.docs[0].category).toMatchObject({ id: cat, slug: 'news' })
    // Staff-only fields are never exposed to anonymous readers.
    for (const field of ['author', 'reviewNotes', 'scheduledFor']) expect(pub.json.docs[0][field], field).toBeUndefined()
  })

  it('an editor can request changes and the reporter can then resubmit (changes_requested -> in_review)', async () => {
    const { id } = await createArticle(reporter, 'changes-flow', { status: 'in_review' })
    const ask = await editor.patch(`/api/articles/${id}`, { json: { status: 'changes_requested', reviewNotes: 'e2e note' } })
    expect(ask.status).toBe(200)
    expect(ask.json.doc.status).toBe('changes_requested')
    const again = await reporter.patch(`/api/articles/${id}`, { json: { status: 'in_review' } })
    expect(again.status).toBe(200)
    expect(again.json.doc.status).toBe('in_review')
  })

  it('an invalid transition (draft -> archived) is rejected for an editor', async () => {
    const { id } = await createArticle(reporter, 'bad-transition', { status: 'draft' })
    const res = await editor.patch(`/api/articles/${id}`, { json: { status: 'archived' } })
    expect([400, 403]).toContain(res.status)
    expect((await admin.get(`/api/articles/${id}`)).json.status).toBe('draft')
  })

  it('an editor must append a correction to change a published article, and unpublishing hides it again', async () => {
    const { id, slug } = await createArticle(editor, 'correction', { status: 'published' })
    expect(id).toBeTypeOf('number')

    const noNote = await editor.patch(`/api/articles/${id}`, { json: { title: `${runId} correction (edited)` } })
    expect(noNote.status).toBe(400)

    const ok = await editor.patch(`/api/articles/${id}`, {
      json: { title: `${runId} correction (edited)`, corrections: [{ note: 'E2E correction note.' }] },
    })
    expect(ok.status).toBe(200)
    const pub = await anon.get(`/api/articles?where[slug][equals]=${slug}`, { credentials: false })
    expect(pub.json.docs[0].corrections.map((c: { note: string }) => c.note)).toContain('E2E correction note.')

    const archived = await editor.patch(`/api/articles/${id}`, { json: { status: 'archived' } })
    expect(archived.status).toBe(200)
    const gone = await anon.get(`/api/articles?where[slug][equals]=${slug}`, { credentials: false })
    expect(gone.json.docs).toHaveLength(0)
  })
})
