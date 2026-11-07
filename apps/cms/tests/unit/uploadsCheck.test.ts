import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { MEDIA_MAX_BYTES } from '../../src/lib/mediaLimits'
import { openPrivateOut, PrivateOutError, privateOutProblem } from '../../src/import/privateOut'
import { hasActiveContent, lstatChain, readCheckedFile, scanFile, sniffKind, unsafeFileReason, unsafeNameReason } from '../../src/import/uploadSafety'
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
    att(107, '2099/01/shell.jpg'),
    att(108, '2099/01/anim.gif'),
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
  it('imports only an allow-list of extensions, after normalising case, trailing dots and spaces', () => {
    for (const ok of ['a.jpg', 'a.JPEG', 'a.PnG', 'a.webp', 'my photo.v2.jpeg']) expect(unsafeNameReason(`2099/${ok}`), ok).toBeNull()
    // not importable pictures or documents: counted apart
    for (const n of ['a.gif', 'a.bmp', 'a.ico', 'a.avif', 'a.pdf', 'a.GIF']) expect(unsafeNameReason(`2099/${n}`), n).toBe('unsupported-type')
    // everything else is not media
    for (const n of ['a.txt', 'a.doc', 'a.avi', 'a.mov', 'noext', 'a.jpg_', 'a.jpgx']) expect(unsafeNameReason(`2099/${n}`), n).toBe('not-media')
    // trailing dots and spaces are stripped before judging (Windows would drop them)
    expect(unsafeNameReason('2099/a.php.')).toBe('dangerous-extension')
    expect(unsafeNameReason('2099/a.php ')).toBe('dangerous-extension')
    expect(unsafeNameReason('2099/a.PHP . .')).toBe('dangerous-extension')
    expect(unsafeNameReason('2099/a.jpg.')).toBe('bad-name')
    expect(unsafeNameReason('2099/a.png ')).toBe('bad-name')
    expect(unsafeNameReason('2099/a.gif.')).toBe('unsupported-type')
    // inner dangerous extensions
    for (const n of ['x.html.jpg', 'x.svg.png', 'x.js.jpg', 'x.HTM.webp', 'x.exe.png', 'x.php.JPG']) expect(unsafeNameReason(`2099/${n}`), n).toBe('dangerous-extension')
    // reserved Windows device names, any extension, any segment, case-insensitive
    for (const n of ['con.png', 'PRN.jpg', 'aux.webp', 'Nul.png', 'com1.png', 'LPT9.jpg', 'con.tar.png', 'nul .png']) expect(unsafeNameReason(`2099/${n}`), n).toBe('bad-name')
    expect(unsafeNameReason('con/a.png')).toBe('bad-name')
    expect(unsafeNameReason('2099/console.png')).toBeNull()
    expect(unsafeNameReason('2099/com10.png')).toBeNull()
    // NTFS stream syntax
    expect(unsafeNameReason('2099/a.png:evil.php')).toBe('bad-name')
  })
  it('sniffs magic bytes and active content', () => {
    expect(sniffKind(fakePng())).toBe('png')
    expect(sniffKind(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpg')
    expect(sniffKind(Buffer.from('GIF89a..'))).toBe('gif')
    expect(sniffKind(Buffer.from('hello'))).toBeNull()
    expect(hasActiveContent(Buffer.from('xx<?PhP '))).toBe(true)
    expect(hasActiveContent(Buffer.from('xx<SCRIPT>'))).toBe(true)
    expect(hasActiveContent(Buffer.from('xx<?= 1 ?>'))).toBe(false) // three bytes that occur by chance in compressed data
    expect(hasActiveContent(fakePng())).toBe(false)
  })
  it('finds a script marker across a read-chunk border, as an advisory warning only', async () => {
    const png = fakePng()
    const file = path.join(dir, 'border.png')
    fs.writeFileSync(file, Buffer.concat([png, Buffer.alloc(1024 * 1024 - png.length - 3, 1), Buffer.from('<?php')]))
    expect((await scanFile(file)).polyglot).toBe(true)
    expect(await unsafeFileReason(dir, 'border.png')).toBeNull() // an image: the Media re-save removes it
    const r = readCheckedFile(dir, 'border.png')
    expect(r.ok && r.warning).toBe(true)
  })
  it('random image-like payloads are never flagged (seeded, 5 MB each)', async () => {
    // Before: `<?=` (3 bytes) appeared by chance, so ~27% of random 5 MB payloads were "polyglot" and dropped.
    let seed = 0x9e3779b9
    const next = () => {
      // xorshift32
      seed ^= seed << 13
      seed >>>= 0
      seed ^= seed >>> 17
      seed ^= seed << 5
      seed >>>= 0
      return seed
    }
    const SIZE = 5 * 1024 * 1024
    const heads = [Buffer.from(fakePng().subarray(0, 8)), Buffer.from([0xff, 0xd8, 0xff, 0xe0])]
    const names = ['rnd.png', 'rnd.jpg']
    let withQuestionEq = 0
    const words = new Uint32Array(SIZE / 4)
    for (let i = 0; i < 24; i++) {
      for (let j = 0; j < words.length; j++) words[j] = next()
      const body = Buffer.from(words.buffer, words.byteOffset, words.byteLength)
      const head = heads[i % 2] as Buffer
      const data = Buffer.concat([head, body.subarray(head.length)])
      if (data.includes(Buffer.from('<?='))) withQuestionEq++
      const rel = `rnd${i}-${names[i % 2]}`
      fs.writeFileSync(path.join(dir, rel), data)
      expect(await unsafeFileReason(dir, rel), rel).toBeNull()
      fs.rmSync(path.join(dir, rel))
    }
    expect(withQuestionEq).toBeGreaterThan(0) // the seed does reproduce the old false positive, so the test has teeth
  })
  it('refuses files over the shared size cap without reading them, and unsupported types', async () => {
    const big = path.join(dir, 'big.png')
    const fd = fs.openSync(big, 'w')
    fs.writeSync(fd, fakePng())
    fs.ftruncateSync(fd, MEDIA_MAX_BYTES + 1)
    fs.closeSync(fd)
    expect(await unsafeFileReason(dir, 'big.png')).toBe('too-large')
    expect(readCheckedFile(dir, 'big.png')).toEqual({ ok: false, reason: 'too-large' })
    fs.writeFileSync(path.join(dir, 'x.gif'), 'GIF89a....')
    expect(await unsafeFileReason(dir, 'x.gif')).toBe('unsupported-type')
    // a scan never goes past the cap by more than one byte
    expect((await scanFile(big)).bytes).toBe(MEDIA_MAX_BYTES + 1)
  })
  it('reads a checked file once and returns the bytes with the mime type; refuses hard links', () => {
    const png = fakePng()
    fs.writeFileSync(path.join(dir, 'one.png'), png)
    const r = readCheckedFile(dir, 'one.png')
    expect(r).toMatchObject({ ok: true, name: 'one.png', mimetype: 'image/png', size: png.length, warning: false })
    expect(r.ok && r.data.equals(png)).toBe(true)
    fs.writeFileSync(path.join(dir, 'two.JPEG'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))
    expect(readCheckedFile(dir, 'two.JPEG')).toMatchObject({ ok: true, mimetype: 'image/jpeg' })
    fs.writeFileSync(path.join(dir, 'w.webp'), Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]))
    expect(readCheckedFile(dir, 'w.webp')).toMatchObject({ ok: true, mimetype: 'image/webp' })
    fs.linkSync(path.join(dir, 'one.png'), path.join(dir, 'one-link.png'))
    expect(readCheckedFile(dir, 'one.png')).toEqual({ ok: false, reason: 'hard-link' })
    expect(readCheckedFile(dir, 'one-link.png')).toEqual({ ok: false, reason: 'hard-link' })
    expect(lstatChain(dir, 'one-link.png')).toEqual({ ok: false, reason: 'hard-link' })
  })
  it('refuses a path through a directory link (a junction on Windows needs no privilege)', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'uploads-outside-'))
    try {
      fs.writeFileSync(path.join(outside, 'secret.png'), fakePng())
      try {
        fs.symlinkSync(outside, path.join(dir, 'jct'), 'junction')
      } catch {
        return // links cannot be created here: skipped
      }
      expect(lstatChain(dir, 'jct/secret.png')).toEqual({ ok: false, reason: 'symlink' })
      expect(readCheckedFile(dir, 'jct/secret.png')).toEqual({ ok: false, reason: 'symlink' })
    } finally {
      fs.rmSync(path.join(dir, 'jct'), { force: true, recursive: false })
      fs.rmSync(outside, { recursive: true, force: true })
    }
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
    expect(r.attachments).toMatchObject({ inExport: 8, distinctPaths: 8, present: 2, sizeVariantOnly: 1, unicodeMismatch: 1, caseMismatch: 1, missing: 1, rejectedUnsafe: 1, notImportable: 1, noPath: 0 })
    expect(r.files.warnings).toBe(tree.expectedWarnings.length)
    // body (published posts only): a-300x300 resolves through the original, b present, lost missing; the draft is ignored
    expect(r.bodyImages).toMatchObject({ distinctReferenced: 3, present: 1, resolvedViaOriginal: 1, missing: 1 })
    expect(r.featured).toEqual({ posts: 4, present: 1, missing: 1, rejectedUnsafe: 1, notImportable: 0, noAttachment: 1 })
    expect(r.duplicates).toEqual({ groups: 1, extraFiles: 1 })
    expect(r.tree.unreferenced).toBe(4) // stray, the duplicate copy and the two warned (but safe) pictures
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

  it('never truncates or overwrites: --out as the export, or an existing file, is refused and left intact', async () => {
    const before = fs.readFileSync(exportFile)
    expect(await run(['--uploads', uploads, '--wxr', exportFile, '--out', exportFile])).toMatchObject({ code: 2, err: 'UPLOADS_CHECK_OUT_IS_INPUT' })
    expect(fs.readFileSync(exportFile).equals(before)).toBe(true)
    // the same file by another spelling (a hard link, or `.` segments)
    const alias = path.join(dir, 'detail', '..', 'export.xml')
    expect(await run(['--uploads', uploads, '--wxr', exportFile, '--out', alias])).toMatchObject({ code: 2, err: 'UPLOADS_CHECK_OUT_IS_INPUT' })
    const link = path.join(dir, 'export-link.xml')
    fs.linkSync(exportFile, link)
    expect(await run(['--uploads', uploads, '--wxr', exportFile, '--out', link])).toMatchObject({ code: 2, err: 'UPLOADS_CHECK_OUT_IS_INPUT' })
    expect(fs.readFileSync(exportFile).equals(before)).toBe(true)
    const existing = path.join(dir, 'already.jsonl')
    fs.writeFileSync(existing, 'keep me')
    expect(await run(['--uploads', uploads, '--wxr', exportFile, '--out', existing])).toMatchObject({ code: 2, err: 'UPLOADS_CHECK_OUT_EXISTS' })
    expect(fs.readFileSync(existing, 'utf8')).toBe('keep me')
  })

  it('judges --out inside the uploads folder by real paths, also when it does not exist yet', async () => {
    const via = path.join(dir, 'via-link')
    try {
      fs.symlinkSync(uploads, via, 'junction')
    } catch {
      return // links cannot be created here: skipped
    }
    try {
      const res = await run(['--uploads', uploads, '--wxr', exportFile, '--out', path.join(via, 'new', 'd.jsonl')])
      expect(res).toMatchObject({ code: 2, err: 'UPLOADS_CHECK_OUT_INSIDE_UPLOADS' })
      expect(fs.existsSync(path.join(uploads, 'new'))).toBe(false)
    } finally {
      fs.rmSync(via, { force: true, recursive: false })
    }
  })

  it('privateOut: exclusive create, refuses an input, an existing file and a protected folder', () => {
    const file = path.join(dir, 'po', 'a.json')
    expect(privateOutProblem(file, { inputs: [exportFile], notInside: [uploads] })).toBeNull()
    fs.closeSync(openPrivateOut(file))
    expect(privateOutProblem(file)).toBe('OUT_EXISTS')
    expect(() => openPrivateOut(file)).toThrow(PrivateOutError)
    expect(privateOutProblem(exportFile, { inputs: [exportFile] })).toBe('OUT_IS_INPUT')
    expect(privateOutProblem(path.join(uploads, 'x', 'y.json'), { notInside: [uploads] })).toBe('OUT_INSIDE_DIR')
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
  // The Media collection checks the bytes against the declared type, so each extension needs its own kind of bytes.
  const forExt: Record<string, Buffer> = {
    mp4: bytes,
    m4a: Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypM4A '), Buffer.alloc(64, 7)]),
    webm: Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('Bwebm'), Buffer.alloc(64, 7)]),
    mp3: Buffer.concat([Buffer.from('ID3'), Buffer.alloc(64, 7)]),
    ogg: Buffer.concat([Buffer.from('OggS'), Buffer.alloc(64, 7)]),
  }
  it.each(['mp4', 'webm', 'mp3', 'm4a', 'ogg'])('does not flag .%s by name or magic bytes', async (ext) => {
    expect(unsafeNameReason(`2099/01/clip.${ext}`)).toBeNull()
    fs.writeFileSync(path.join(dir, `clip.${ext}`), forExt[ext] as Buffer)
    expect(await unsafeFileReason(dir, `clip.${ext}`)).toBeNull()
  })
  it('reads an audio/video file once with its type; wrong magic bytes and other extensions are refused', () => {
    fs.writeFileSync(path.join(dir, 'ok.mp4'), bytes)
    expect(readCheckedFile(dir, 'ok.mp4')).toMatchObject({ ok: true, mimetype: 'video/mp4', size: bytes.length })
    fs.writeFileSync(path.join(dir, 'fake.mp3'), 'not audio at all')
    expect(readCheckedFile(dir, 'fake.mp3')).toEqual({ ok: false, reason: 'magic-mismatch' })
    expect(unsafeNameReason('2099/01/clip.avi')).toBe('not-media')
    expect(unsafeNameReason('2099/01/clip.mov')).toBe('not-media')
  })
  it('still rejects active content hidden in an audio/video file', async () => {
    fs.writeFileSync(path.join(dir, 'evil.mp4'), Buffer.concat([bytes, Buffer.from('<?php system($_GET[1]);')]))
    expect(await unsafeFileReason(dir, 'evil.mp4')).toBe('polyglot')
    expect(unsafeNameReason('2099/01/evil.php.mp3')).toBe('dangerous-extension')
  })
})
