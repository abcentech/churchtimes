import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { parseImportArgs } from '../../src/import/cli'
import { cleanDisplayName, prepareComments, stripEmailShaped } from '../../src/import/comments'
import { openManifest, readManifest } from '../../src/import/manifest'
import { confineUploadPath, isSafeRelativeUploadPath } from '../../src/import/media'
import { bumpTally, formatImportReport, newReport, reconcile, statusKey } from '../../src/import/qa'
import type { WxrComment } from '../../src/import/wxr'

let root: string
let outside: string

beforeAll(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-loader-unit-'))
  root = path.join(base, 'uploads')
  outside = path.join(base, 'secret')
  fs.mkdirSync(path.join(root, '2023', '10'), { recursive: true })
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(root, '2023', '10', 'photo.png'), 'x')
  fs.writeFileSync(path.join(outside, 'private.png'), 'x')
})
afterAll(() => {
  fs.rmSync(path.dirname(root), { recursive: true, force: true })
})

describe('confineUploadPath', () => {
  it('resolves a plain relative path inside the root', () => {
    const r = confineUploadPath(root, '2023/10/photo.png')
    expect(r.ok).toBe(true)
  })
  it('reports a missing file and a missing root without throwing', () => {
    expect(confineUploadPath(root, '2023/10/nope.png')).toEqual({ ok: false, reason: 'missing-file' })
    expect(confineUploadPath(undefined, '2023/10/photo.png')).toEqual({ ok: false, reason: 'no-uploads-root' })
    expect(confineUploadPath(path.join(root, 'absent'), 'a.png')).toEqual({ ok: false, reason: 'no-uploads-root' })
  })
  it.each([
    '../secret/private.png',
    '2023/../../secret/private.png',
    '/etc/passwd',
    '\\\\host\\share\\a.png',
    '//host/share/a.png',
    '\\\\?\\C:\\a.png',
    '\\\\.\\PhysicalDrive0',
    'C:/Windows/win.ini',
    'C:\\a.png',
    '2023\\10\\photo.png',
    '2023/10/photo.png:stream',
    '2023/10/pho\u0000to.png',
    '2023//10/photo.png',
    './2023/10/photo.png',
    '',
  ])('refuses %j', (rel) => {
    expect(isSafeRelativeUploadPath(rel)).toBe(false)
    const r = confineUploadPath(root, rel)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('bad-path')
  })
  it('refuses a link that leaves the root (real path check)', (ctx) => {
    const link = path.join(root, 'escape')
    try {
      fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      ctx.skip() // no permission to link here: the traversal cases above still cover the textual refusals
      return
    }
    expect(confineUploadPath(root, 'escape/private.png')).toEqual({ ok: false, reason: 'outside-root' })
  })
})

const wc = (over: Partial<WxrComment>): WxrComment => ({
  id: 1,
  parentId: null,
  authorName: 'Ada',
  content: 'Hello',
  dateGmt: '2020-01-02T03:04:05.000Z',
  dateIssue: null,
  approved: '1',
  type: 'comment',
  ...over,
})

describe('prepareComments', () => {
  it('keeps approved comments only and counts skips by reason', () => {
    const r = prepareComments(
      [wc({ id: 1 }), wc({ id: 2, approved: '0' }), wc({ id: 3, approved: 'spam' }), wc({ id: 4, type: 'pingback' }), wc({ id: 5, content: '  ' }), wc({ id: 1 })],
      7,
    )
    expect(r.rows.map((x) => x.legacyId)).toEqual([1])
    expect(r.rows[0].article).toBe(7)
    expect(r.skipped).toMatchObject({ unapproved: 1, spam: 1, pingback: 1, empty: 1, 'duplicate-id': 1 })
  })
  it('strips email-shaped text from names and bodies', () => {
    const r = prepareComments(
      [
        wc({ id: 1, authorName: 'jane.doe@mail.example.test', content: 'write to jane.doe@mail.example.test or j@x.example.org today' }),
        wc({ id: 2, authorName: 'Bob <bob@example.test>' }),
        wc({ id: 3, content: 'fullwidth bob\uFF20example.test here' }),
      ],
      1,
    )
    const text = JSON.stringify(r.rows)
    expect(text).not.toMatch(/@|\uFF20/)
    expect(text).not.toContain('example.test')
    expect(r.rows[0].authorName).toBe('Anonymous')
    expect(r.rows[0].content).toContain('[email removed]')
  })
  it('keeps threading only for imported parents and breaks loops', () => {
    const r = prepareComments(
      [wc({ id: 1 }), wc({ id: 2, parentId: 1 }), wc({ id: 3, parentId: 99 }), wc({ id: 4, parentId: 5 }), wc({ id: 5, parentId: 4 })],
      1,
    )
    const by = new Map(r.rows.map((x) => [x.legacyId, x.parentLegacyId]))
    expect(by.get(2)).toBe(1)
    expect(by.get(3)).toBeNull()
    expect([by.get(4), by.get(5)].filter((v) => v === null).length).toBeGreaterThanOrEqual(1)
    expect(r.orphanedParents).toBeGreaterThanOrEqual(2)
  })
  it('skips trash comments', () => {
    const r = prepareComments([wc({ id: 1, approved: 'trash' }), wc({ id: 2 })], 1)
    expect(r.rows.map((x) => x.legacyId)).toEqual([2])
    expect(r.skipped.trash).toBe(1)
  })
  it('a name with an at-sign becomes Anonymous before any stripping', () => {
    const r = prepareComments([wc({ id: 1, authorName: 'jo@site.example.test' }), wc({ id: 2, authorName: 'jo\uFF20site.example.test' })], 1)
    expect(r.rows.map((x) => x.authorName)).toEqual(['Anonymous', 'Anonymous'])
  })
  it('cleanDisplayName empties an email-like byline', () => {
    expect(cleanDisplayName('Ada Synthetic')).toBe('Ada Synthetic')
    expect(cleanDisplayName('ada@example.test')).toBe('')
    expect(cleanDisplayName('ada\uFF20example.test')).toBe('')
  })
  it('stripEmailShaped output', () => {
    expect(stripEmailShaped('write a.b+c@sub.example.test now')).toBe('write [email removed] now')
    expect(stripEmailShaped('x@y.test, z@w.example.org.')).toBe('[email removed], [email removed].')
    expect(stripEmailShaped('no address here, @handle and 5@6')).toBe('no address here, @handle and 5@6')
    expect(stripEmailShaped('fullwidth bob\uFF20example.test')).toBe('fullwidth [email removed]')
  })
  it('stripEmailShaped is linear on hostile input', () => {
    const t0 = Date.now()
    stripEmailShaped('@'.repeat(20000) + 'a.'.repeat(10000))
    stripEmailShaped(('a'.repeat(60) + '@').repeat(300))
    expect(Date.now() - t0).toBeLessThan(2000)
  })
})

describe('manifest', () => {
  it('is append-only, readable after a kill, and never overwritten', () => {
    const p = path.join(path.dirname(root), 'manifest.jsonl')
    const sink = openManifest(p)
    sink.append({ type: 'intent', legacyId: 11 })
    sink.id('articles', 'created', 1)
    sink.id('media', 'created', 2)
    sink.append({ type: 'commit', legacyId: 11 })
    sink.append({ type: 'intent', legacyId: 12 })
    sink.id('articles', 'created', 3)
    // The process is killed here: no end record, no close, and a torn last line.
    fs.appendFileSync(p, '{"type":"id","collection":"articles","act')
    const m = readManifest(p)
    expect(m.complete).toBe(false)
    expect(m.articles.created).toEqual([1, 3])
    expect(m.media).toEqual([2])
    expect(m.openIntents).toEqual([12])
    if (process.platform !== 'win32') expect(fs.statSync(p).mode & 0o777).toBe(0o600)
    expect(() => openManifest(p)).toThrow()
    sink.close()
  })
  it('records aborts and the end status', () => {
    const p = path.join(path.dirname(root), 'manifest2.jsonl')
    const sink = openManifest(p)
    sink.append({ type: 'intent', legacyId: 5 })
    sink.append({ type: 'abort', legacyId: 5 })
    sink.append({ type: 'end', at: new Date().toISOString(), status: 'failed' })
    sink.close()
    expect(readManifest(p)).toMatchObject({ complete: true, endStatus: 'failed', aborted: [5], openIntents: [] })
  })
})

describe('report', () => {
  it('reconciles and contains only counts', () => {
    const rep = newReport('apply', false)
    rep.source.publishedPosts = 5
    rep.articles.created = 3
    rep.articles.passwordProtected = 1
    bumpTally(rep.articles.skipped, 'no-date')
    const rec = reconcile(rep)
    expect(rec).toEqual({ sourcePublished: 5, accountedFor: 5, difference: 0 })
    expect(statusKey('draft')).toBe('draft')
    expect(statusKey('x-invented-by-the-file')).toBe('other')
    const text = formatImportReport(rep)
    expect(text).toContain('password-protected (skipped): 1')
    expect(text).not.toMatch(/https?:|@/)
  })
})

describe('cli arguments', () => {
  it('is a dry run unless --apply, takes the manifest from the environment', () => {
    expect(parseImportArgs(['--file', 'a.xml'], {})?.dryRun).toBe(true)
    const o = parseImportArgs(['--file', 'a.xml', '--apply', '--limit', '5', '--old-host', 'a.test, b.test'], { IMPORT_MANIFEST_PATH: 'm.json' })
    expect(o).toMatchObject({ dryRun: false, manifestPath: 'm.json', limit: 5, oldHosts: ['a.test', 'b.test'] })
    expect(parseImportArgs([], {})).toBeNull()
    expect(parseImportArgs(['--file', 'a.xml', '--limit', 'x'], {})).toBeNull()
    expect(parseImportArgs(['--file', 'a.xml', '--manifest'], {})).toBeNull()
    expect(parseImportArgs(['--file', '--apply'], {})).toBeNull()
    expect(parseImportArgs(['--file', 'a.xml', '--update'], {})).toMatchObject({ update: true, forceUpdate: false })
    expect(parseImportArgs(['--file', 'a.xml', '--force-update'], {})).toMatchObject({ update: true, forceUpdate: true })
  })

  it('takes the category map and the fallback category from flags or the environment', () => {
    expect(parseImportArgs(['--file', 'a.xml'], {})).toMatchObject({ categoryMapFile: undefined, fallbackCategory: undefined })
    expect(parseImportArgs(['--file', 'a.xml', '--category-map', 'm.json'], {})?.categoryMapFile).toBe('m.json')
    expect(parseImportArgs(['--file', 'a.xml'], { IMPORT_CATEGORY_MAP: 'env.json' })?.categoryMapFile).toBe('env.json')
    expect(parseImportArgs(['--file', 'a.xml', '--fallback-category', 'general'], {})?.fallbackCategory).toEqual({ slug: 'general', title: 'general' })
    expect(parseImportArgs(['--file', 'a.xml', '--fallback-category', 'general', '--fallback-category-name', 'General'], {})?.fallbackCategory).toEqual({ slug: 'general', title: 'General' })
    expect(parseImportArgs(['--file', 'a.xml'], { IMPORT_FALLBACK_CATEGORY_NAME: 'Daily' })?.fallbackCategory).toEqual({ slug: 'news', title: 'Daily' })
    expect(parseImportArgs(['--file', 'a.xml', '--fallback-category', 'Bad Slug'], {})).toBeNull()
    expect(parseImportArgs(['--file', 'a.xml', '--category-map'], {})).toBeNull()
  })
})
