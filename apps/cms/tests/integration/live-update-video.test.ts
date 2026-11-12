import { sql } from '@payloadcms/db-postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as migration from '../../src/migrations/20261112_120000_live_update_video'
import { api, newRunId, setupFixtures, type Fixtures } from './helpers'

const runId = newRunId()
let f: Fixtures
beforeAll(async () => { f = await setupFixtures(runId) })
afterAll(async () => { await f?.cleanup() })

describe('live-update video', () => {
  it('migration is additive and reversible', async () => {
    const db = (f.payload.db as any).drizzle
    const args = { db, payload: f.payload, req: {} } as never
    await migration.down(args)
    const columns = async () => (await db.execute(sql`select column_name from information_schema.columns where table_name='live_updates' and column_name like 'video_%'`)).rows.map((r: any) => r.column_name).sort()
    expect(await columns()).toEqual([])
    await migration.up(args)
    expect(await columns()).toEqual(['video_start_seconds', 'video_title', 'video_video_id'])
  })

  it('keeps a reporter video private until approval and publishes corrections in sequence', async () => {
    const slug = runId + '-video'
    const event = await api('POST', '/api/live-events', { token: f.tokens.eic, body: { title: runId + ' video', slug, category: f.catA.id, status: 'live' } })
    expect(event.status).toBe(201)
    const pending = await api('POST', '/api/live-updates', { token: f.tokens.reporter, body: {
      event: event.json.doc.id, body: 'Synthetic pending update',
      video: { videoId: 'https://youtube.com/live/aB3_deF-123?t=1m5s&si=abc', title: 'Service' }
    } })
    expect(pending.status, pending.text).toBe(201)
    expect(pending.json.doc.status).toBe('pending')
    expect(pending.json.doc.video).toMatchObject({ videoId: 'aB3_deF-123', title: 'Service', startSeconds: 65 })
    expect(pending.text).not.toContain('youtube.com')
    const id = pending.json.doc.id
    expect((await api('GET', '/api/live-updates/' + id)).status).toBe(404)
    expect((await api('GET', '/api/live-events/' + slug + '/updates')).json.docs).toEqual([])
    expect((await api('PATCH', '/api/live-updates/' + id, { token: f.tokens.reporter, body: { status: 'approved' } })).status).toBe(403)
    expect((await api('PATCH', '/api/live-updates/' + id, { token: f.tokens.eic, body: { status: 'approved' } })).status).toBe(200)
    const approved = await api('GET', '/api/live-events/' + slug + '/updates')
    expect(approved.json.docs[0].video).toEqual({ videoId: 'aB3_deF-123', title: 'Service', startSeconds: 65 })
    const cursor = approved.json.nextSince
    expect((await api('PATCH', '/api/live-updates/' + id, { token: f.tokens.reporter, body: { video: null } })).status).toBe(403)
    const revised = await api('PATCH', '/api/live-updates/' + id, { token: f.tokens.eic, body: { video: { videoId: 'https://youtu.be/abcdefghijk?t=9', title: 'Correction' } } })
    expect(revised.status, revised.text).toBe(200)
    const after = await api('GET', '/api/live-events/' + slug + '/updates?since=' + cursor)
    expect(after.json.docs[0].video).toEqual({ videoId: 'abcdefghijk', title: 'Correction', startSeconds: 9 })
    const cleared = await api('PATCH', '/api/live-updates/' + id, { token: f.tokens.eic, body: { video: null } })
    expect(cleared.status, cleared.text).toBe(200)
    const last = await api('GET', '/api/live-events/' + slug + '/updates?since=' + after.json.nextSince)
    expect(last.json.docs[0].video).toBeNull()
  })

  it('refuses invalid video hosts, IDs, titles and start times', async () => {
    const event = await api('POST', '/api/live-events', { token: f.tokens.eic, body: { title: runId + ' bad videos', slug: runId + '-bad-video', category: f.catA.id, status: 'live' } })
    for (const video of [
      { videoId: 'https://evil.test/watch?v=abcdefghijk' }, { videoId: 'bad' },
      { videoId: 'abcdefghijk', title: '<script>' }, { videoId: 'abcdefghijk', startSeconds: -1 },
      { title: 'missing ID' }
    ]) {
      const result = await api('POST', '/api/live-updates', { token: f.tokens.reporter, body: { event: event.json.doc.id, body: 'Bad video', video } })
      expect(result.status, JSON.stringify(video)).toBe(400)
    }
  })
})
