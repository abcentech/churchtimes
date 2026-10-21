import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { openManifest, readManifest } from '../../src/import/manifest'
import { formatRollbackReport, RollbackError, summariseManifest, type RollbackReport } from '../../src/import/rollback'
import { parseRollbackArgs } from '../../src/import/rollbackCli'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-rollback-unit-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('rollback arguments', () => {
  it('needs a manifest and defaults to a dry run', () => {
    expect(parseRollbackArgs([], {})).toBeNull()
    expect(parseRollbackArgs(['--manifest'], {})).toBeNull()
    expect(parseRollbackArgs(['--manifest', '--apply'], {})).toBeNull()
    expect(parseRollbackArgs(['--manifest', 'm.jsonl', '--nonsense'], {})).toBeNull()
    // An apply never takes its manifest from the environment.
    expect(parseRollbackArgs(['--apply'], { IMPORT_MANIFEST_PATH: 'env.jsonl' })).toBeNull()
    expect(parseRollbackArgs(['--manifest', 'm.jsonl'], {})).toEqual({ manifestPath: 'm.jsonl', apply: false, force: false, allowIncomplete: false })
    expect(parseRollbackArgs(['--manifest', 'm.jsonl', '--apply', '--force', '--allow-incomplete'], {})).toMatchObject({ apply: true, force: true, allowIncomplete: true })
    expect(parseRollbackArgs([], { IMPORT_MANIFEST_PATH: 'env.jsonl' })?.manifestPath).toBe('env.jsonl')
  })
})

describe('manifest reading for rollback', () => {
  it('reads start and end times and refuses a file that is not a manifest', () => {
    const p = path.join(dir, 'm.jsonl')
    const sink = openManifest(p)
    sink.id('articles', 'created', 4)
    sink.append({ type: 'end', at: '2026-10-21T10:00:00.000Z', status: 'complete' })
    sink.close()
    expect(readManifest(p)).toMatchObject({ started: true, complete: true, endAt: '2026-10-21T10:00:00.000Z' })
    expect(summariseManifest(p).articles.created).toEqual([4])

    const junk = path.join(dir, 'junk.jsonl')
    fs.writeFileSync(junk, '{"type":"id","collection":"articles","action":"created","id":1}\n')
    const code = (fn: () => unknown) => {
      try {
        fn()
      } catch (e) {
        return (e as RollbackError).code
      }
      return null
    }
    expect(code(() => summariseManifest(junk))).toBe('ROLLBACK_MANIFEST_INVALID')
    expect(code(() => summariseManifest(path.join(dir, 'missing.jsonl')))).toBe('ROLLBACK_MANIFEST_UNREADABLE')
    expect(code(() => summariseManifest(dir))).toBe('ROLLBACK_MANIFEST_UNREADABLE')
  })
})

describe('rollback report', () => {
  it('prints counts and fixed codes only', () => {
    const c = { listed: 3, deleted: 1, wouldDelete: 0, alreadyGone: 1, skipped: { 'edited-since-import': 1 }, failed: 0 }
    const r: RollbackReport = {
      mode: 'apply',
      force: false,
      manifest: { startedAt: '2026-10-21T10:00:00.000Z', complete: true, endStatus: 'complete', openIntents: 0, abortedPosts: 0 },
      comments: c,
      articles: c,
      media: c,
      categories: c,
      articlesUpdatedNotReverted: 2,
      auditRowsKept: 6,
      notes: ['audit-row-written'],
    }
    const text = formatRollbackReport(r)
    expect(text).toContain('edited-since-import=1')
    expect(text).toContain('Audit rows kept: 6')
    expect(text).not.toMatch(/[@/\\]/)
  })
})
