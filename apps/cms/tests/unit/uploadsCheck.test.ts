import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { hasActiveContent, sniffKind, unsafeFileReason, unsafeNameReason } from '../../src/import/uploadSafety'
import { checkUploads, formatUploadsCheck, runUploadsCheckCli } from '../../src/import/uploadsCheck'
import { buildSyntheticUploads, fakePng, type SyntheticTree } from '../fixtures/uploads/tree'
import { wxr, type FixtureItem } from '../fixtures/wxr/generate'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uploads-check-'))
const uploads = path.join(dir, 'uploads')
let tree: SyntheticTree
let exportFile: string
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

const run = async (args: string[]) => {
  const out: string[] = []
  const err: string[] = []
  const code = await runUploadsCheckCli(args, { out: (l) => out.push(l), err: (l) => err.push(l) })
  return { code, out: out.join('\n'), err: err.join('\n') }
}
const host = 'https://old.example.test/wp-content/uploads/'
const att = (id: number, rel: string): FixtureItem => ({ id, postType: 'attachment', status: 'inherit', attachmentUrl: `${host}${rel}`, meta: { _wp_attached_file: rel } })

beforeAll(() => {
  tree = buildSyntheticUploads(uploads, fakePng())
  const items: FixtureItem[] = [
    att(101, '2099/01/a.png'),
    att(102, '2099/01/b.png'),
    att(103, tree.sizeVariantOnlyRef),
    att(104, tree.nfcRef),
    att(105, tree.caseRef),
    att(106, '2099/01/gone.png'),
    att(107, '2099/01/poly.png'),
    { id: 1, meta: { _thumbnail_id: '101' }, content: `<p><img src="${host}2099/01/a-300x300.png"> <img src='${host}2099/01/b.png'> <img src="${host}2099/01/lost.png"></p>` },
    { id: 2, meta: { _thumbnail_id: '106' }, content: '<p>no image</p>' },
    { id: 3, meta: { _thumbnail_id: '107' }, content: '<p>x</p>' },
    { id: 4, meta: { _thumbnail_id: '999' }, content: '<p>x</p>' },
    { id: 5, status: 'draft', meta: { _thumbnail_id: '102' }, content: `<img src="${host}2099/01/draft-only.png">` },
  ]
  exportFile = path.join(dir, 'export.xml')
  fs.writeFileSync(exportFile, wxr(items))
})

describe('uploadSafety', () => {
  it('judges names', () => {
    expect(unsafeNameReason('2099/01/a.png')).toBeNull()
    expect(unsafeNameReason('2099/01/a.PHP')).toBe('dangerous-extension')
    expect(unsafeNameReason('2099/01/a.php.jpg')).toBe('dangerous-extension')
    expect(unsafeNameReason('2099/01/a.phtml')).toBe('dangerous-extension')
    expect(unsafeNameReason('2099/01/a.phar')).toBe('dangerous-extension')
    expect(unsafeNameReason('2099/.htaccess')).toBe('hidden-file')
    expect(unsafeNameReason('2099/a\\b.png')).toBe('bad-name')
    expect(unsafeNameReason('2099/a\u0007.png')).toBe('bad-name')
    expect(unsafeNameReason('2099/../a.png')).toBe('bad-name')
    expect(unsafeNameReason('2099/photo.v2.jpg')).toBeNull()
  })
  it('sniffs magic bytes and active content', () => {
    expect(sniffKind(fakePng())).toBe('png')
    expect(sniffKind(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpg')
    expect(sniffKind(Buffer.from('GIF89a..'))).toBe('gif')
    expect(sniffKind(Buffer.from('hello'))).toBeNull()
    expect(hasActiveContent(Buffer.from('xx<?PhP '))).toBe(true)
    expect(hasActiveContent(Buffer.from('xx<SCRIPT>'))).toBe(true)
    expect(hasActiveContent(fakePng())).toBe(false)
  })
  it('finds active content across a read-chunk border', async () => {
    const png = fakePng()
    fs.writeFileSync(path.join(dir, 'border.png'), Buffer.concat([png, Buffer.alloc(1024 * 1024 - png.length - 3, 1), Buffer.from('<?php')]))
    expect(await unsafeFileReason(dir, 'border.png')).toBe('polyglot')
  })
})

describe('import:uploads-check', () => {
  it('rejects every dangerous file of the synthetic tree and nothing else', async () => {
    const lines: Array<{ kind: string; path: string; status: string }> = []
    const r = await checkUploads(uploads, exportFile, (l) => lines.push(l))
    const expected: Record<string, number> = {}
    for (const reason of Object.values(tree.expectedRejected)) expected[reason] = (expected[reason] ?? 0) + 1
    expect(r.files.rejected).toEqual(expected)
    for (const [rel, reason] of Object.entries(tree.expectedRejected)) {
      expect(lines.find((l) => l.kind === 'file' && l.path === rel)?.status, rel).toBe(reason)
    }
    expect(r.files.safe).toBe(r.files.total - Object.keys(tree.expectedRejected).length)
    expect(r.topLevel.yearFolders).toBe(1)
  })

  it('reconciles with the export', async () => {
    const r = await checkUploads(uploads, exportFile)
    expect(r.attachments).toMatchObject({ inExport: 7, distinctPaths: 7, present: 2, sizeVariantOnly: 1, unicodeMismatch: 1, caseMismatch: 1, missing: 1, rejectedUnsafe: 1, noPath: 0 })
    // body (published posts only): a-300x300 resolves through the original, b present, lost missing; the draft is ignored
    expect(r.bodyImages).toMatchObject({ distinctReferenced: 3, present: 1, resolvedViaOriginal: 1, missing: 1 })
    expect(r.featured).toEqual({ posts: 4, present: 1, missing: 1, rejectedUnsafe: 1, noAttachment: 1 })
    expect(r.duplicates).toEqual({ groups: 1, extraFiles: 1 })
    expect(r.tree.unreferenced).toBe(2) // stray and the duplicate copy
    expect(r.tree.derivedSizeVariants).toBe(2)
  })

  it('prints counts only: no file name from the tree appears', async () => {
    const res = await run(['--uploads', uploads, '--wxr', exportFile])
    expect(res.code).toBe(3) // unsafe files were found
    for (const word of ['shell.jpg', 'poly.png', 'evil.php', 'stray', 'Case.png', 'gone', 'lost', 'example.test', '2099']) expect(res.out).not.toContain(word)
    expect(res.out).toContain('Uploads check (read-only, counts only)')
    expect(formatUploadsCheck(await checkUploads(uploads, exportFile))).toBe(res.out)
  })

  it('writes a detail file outside every repository, and refuses a place inside one', async () => {
    const out = path.join(dir, 'detail', 'files.jsonl')
    const res = await run(['--uploads', uploads, '--wxr', exportFile, '--out', out])
    expect(res.code).toBe(3)
    expect(fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).length).toBeGreaterThan(20)
    if (process.platform !== 'win32') expect(fs.statSync(out).mode & 0o777).toBe(0o600)
    const inside = path.join(process.cwd(), 'detail-must-not-exist.jsonl')
    expect(await run(['--uploads', uploads, '--wxr', exportFile, '--out', inside])).toMatchObject({ code: 2, err: 'UPLOADS_CHECK_OUT_INSIDE_REPO' })
    expect(fs.existsSync(inside)).toBe(false)
    expect((await run(['--uploads', uploads, '--wxr', exportFile, '--out', path.join(uploads, 'd.jsonl')])).err).toBe('UPLOADS_CHECK_OUT_INSIDE_UPLOADS')
  })

  it('refuses an uploads folder inside a repository and bad usage', async () => {
    expect((await run(['--uploads', path.join(process.cwd(), 'src'), '--wxr', exportFile])).err).toBe('UPLOADS_CHECK_UPLOADS_INSIDE_REPO')
    expect((await run(['--wxr', exportFile])).code).toBe(2)
    expect((await run(['--uploads', path.join(dir, 'nope'), '--wxr', exportFile])).err).toBe('UPLOADS_CHECK_NO_UPLOADS_DIR')
  })

  it('exits 0 for a clean tree', async () => {
    const clean = path.join(dir, 'clean')
    fs.mkdirSync(path.join(clean, '2099'), { recursive: true })
    fs.writeFileSync(path.join(clean, '2099', 'a.png'), fakePng())
    expect((await run(['--uploads', clean, '--wxr', exportFile])).code).toBe(0)
  })
})

describe('uploadSafety with audio/video', () => {
  const bytes = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypmp42'), Buffer.alloc(64, 7)])
  it.each(['mp4', 'webm', 'mp3', 'm4a', 'ogg'])('does not flag .%s by name or magic bytes', async (ext) => {
    expect(unsafeNameReason(`2099/01/clip.${ext}`)).toBeNull()
    fs.writeFileSync(path.join(dir, `clip.${ext}`), bytes)
    expect(await unsafeFileReason(dir, `clip.${ext}`)).toBeNull()
  })
  it('still rejects active content hidden in an audio/video file', async () => {
    fs.writeFileSync(path.join(dir, 'evil.mp4'), Buffer.concat([bytes, Buffer.from('<?php system($_GET[1]);')]))
    expect(await unsafeFileReason(dir, 'evil.mp4')).toBe('polyglot')
    expect(unsafeNameReason('2099/01/evil.php.mp3')).toBe('dangerous-extension')
  })
})
