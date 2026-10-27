import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { PASSWORD, api, newRunId, setupFixtures, type Fixtures } from './helpers'

/**
 * M3: deletes are audited (users, submissions, live updates, live events, categories, contact messages) without
 * personal data, and an audit row keeps an immutable copy of its actor even after the actor's user row is deleted.
 */
const runId = newRunId()
let f: Fixtures

beforeAll(async () => {
  f = await setupFixtures(runId)
})
afterAll(async () => {
  await f?.cleanup()
})

type Audit = {
  action: string
  collection: string
  docId: string
  actor?: number | null
  actorIdSnapshot?: string | null
  actorRole?: string | null
  summary?: string | null
}

async function auditRows(collection: string, docId: string | number, action?: string): Promise<Audit[]> {
  const res = await f.payload.find({
    collection: 'audit-logs',
    where: {
      and: [
        { collection: { equals: collection } },
        { docId: { equals: String(docId) } },
        ...(action ? [{ action: { equals: action } }] : []),
      ],
    },
    depth: 0,
    limit: 50,
    overrideAccess: true,
  })
  return res.docs as unknown as Audit[]
}

const del = (token: string, path: string) => api('DELETE', path, { token })

const mkUser = async (key: string, role: string) => {
  const email = `${runId}-${key}@test.invalid`
  const u = (await f.payload.create({
    collection: 'users',
    data: { email, name: `${runId} ${key}`, password: PASSWORD, role, sections: [] } as never,
    overrideAccess: true,
  })) as { id: number }
  const login = await f.payload.login({ collection: 'users', data: { email, password: PASSWORD } })
  return { id: u.id, email, token: login.token as string }
}

describe('audited deletes', () => {
  it('audits a user delete with the actor snapshot and no e-mail address', async () => {
    const victim = await mkUser('victim', 'reporter')
    const res = await del(f.tokens.admin, `/api/users/${victim.id}`)
    expect(res.status).toBe(200)
    const rows = await auditRows('users', victim.id, 'user.delete')
    expect(rows).toHaveLength(1)
    expect(rows[0].actorIdSnapshot).toBe(String(f.users.admin.id))
    expect(rows[0].actorRole).toBe('admin')
    expect(JSON.stringify(rows[0])).not.toContain(victim.email)
    expect(rows[0].summary ?? '').not.toContain('@')
  })

  it('keeps the actor identity on past rows after the actor is deleted', async () => {
    const tmp = await mkUser('tmpeic', 'editor-in-chief')
    const cat = await api('POST', '/api/categories', {
      token: tmp.token,
      body: { title: `${runId} doomed`, slug: `${runId}-doomed` },
    })
    expect(cat.status).toBe(201)
    expect((await del(tmp.token, `/api/categories/${cat.json.doc.id}`)).status).toBe(200)

    const before = await auditRows('categories', cat.json.doc.id, 'delete')
    expect(before).toHaveLength(1)
    expect(before[0].actor).toBe(tmp.id)
    expect(before[0].actorIdSnapshot).toBe(String(tmp.id))
    expect(before[0].summary).toContain(`${runId}-doomed`)

    // An admin deletes the actor: the FK is set null, the snapshot survives.
    expect((await del(f.tokens.admin, `/api/users/${tmp.id}`)).status).toBe(200)
    const after = await auditRows('categories', cat.json.doc.id, 'delete')
    expect(after[0].actor ?? null).toBeNull()
    expect(after[0].actorIdSnapshot).toBe(String(tmp.id))
    expect(after[0].actorRole).toBe('editor-in-chief')
  })

  it('audits a self-delete without breaking the audit foreign key', async () => {
    const self = await mkUser('selfdel', 'admin')
    const res = await del(self.token, `/api/users/${self.id}`)
    expect(res.status).toBe(200)
    const rows = await auditRows('users', self.id, 'user.delete')
    expect(rows).toHaveLength(1)
    expect(rows[0].actorIdSnapshot).toBe(String(self.id))
  })

  it('audits deletes of submissions, contact messages, live events and live updates without personal data', async () => {
    const sub = (await f.payload.create({
      collection: 'submissions',
      data: {
        reference: `${runId}-S1`,
        name: 'Ada Lovelace',
        email: `${runId}-ada@test.invalid`,
        title: `${runId} tip`,
        body: 'secret tip text',
        status: 'new',
      } as never,
      overrideAccess: true,
    })) as { id: number }
    expect((await del(f.tokens.eic, `/api/submissions/${sub.id}`)).status).toBe(200)
    const subRows = await auditRows('submissions', sub.id, 'delete')
    expect(subRows).toHaveLength(1)
    expect(subRows[0].actorIdSnapshot).toBe(String(f.users.eic.id))
    expect(JSON.stringify(subRows[0])).not.toMatch(/Ada|secret tip|@/)

    const msg = (await f.payload.create({
      collection: 'contact-messages',
      data: {
        reference: `${runId}-C1`,
        name: 'Grace Hopper',
        email: `${runId}-grace@test.invalid`,
        topic: 'general',
        message: 'private words',
        status: 'new',
      } as never,
      overrideAccess: true,
    })) as { id: number }
    expect((await del(f.tokens.eic, `/api/contact-messages/${msg.id}`)).status).toBe(200)
    const msgRows = await auditRows('contact-messages', msg.id, 'delete')
    expect(msgRows).toHaveLength(1)
    expect(JSON.stringify(msgRows[0])).not.toMatch(/Grace|private words|@/)

    const ev = (await f.payload.create({
      collection: 'live-events',
      data: { title: `${runId} ev`, slug: `${runId}-ev`, category: f.catA.id, status: 'live' } as never,
      overrideAccess: true,
    })) as { id: number }
    const up = (await f.payload.create({
      collection: 'live-updates',
      data: { event: ev.id, body: `${runId} update`, status: 'approved' } as never,
      overrideAccess: true,
    })) as { id: number }
    expect((await del(f.tokens.eic, `/api/live-updates/${up.id}`)).status).toBe(200)
    expect(await auditRows('live-updates', up.id, 'delete')).toHaveLength(1)
    expect((await del(f.tokens.eic, `/api/live-events/${ev.id}`)).status).toBe(200)
    expect(await auditRows('live-events', ev.id, 'delete')).toHaveLength(1)
  })

  it('writes no e-mail address into user audit summaries', async () => {
    const u = await mkUser('audited', 'reporter')
    const patched = await api('PATCH', `/api/users/${u.id}`, {
      token: f.tokens.admin,
      body: { role: 'section-editor', sections: [f.catA.id] },
    })
    expect(patched.status).toBe(200)
    expect((await api('POST', `/api/users/${u.id}/revoke-sessions`, { token: f.tokens.admin })).status).toBe(200)
    const rows = await auditRows('users', u.id)
    expect(rows.length).toBeGreaterThanOrEqual(2)
    for (const r of rows) expect(r.summary ?? '').not.toContain('@')
    await f.payload.delete({ collection: 'users', id: u.id, overrideAccess: true })
  })
})
