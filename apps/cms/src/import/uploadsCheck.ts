import fs from 'node:fs'
import path from 'node:path'

import { candidatePaths, legacyPathFromUrl, stripSizeSuffix } from '../lib/legacyMediaPath'
import { isSafeRelativeUploadPath } from './media'
import { isInsideRepo } from './safePaths'
import { MEDIA_MAX_BYTES } from '../lib/mediaLimits'
import { isInsideDir, openPrivateOut, privateOutProblem, PrivateOutError } from './privateOut'
import { judgeContent, scanFile, unsafeNameReason, type UnsafeReason } from './uploadSafety'
import { readWxrFile, WxrError, type WxrAttachment, type WxrItem } from './wxr'

/**
 * `npm run import:uploads-check -- --uploads <dir> --wxr <export.xml> [--out <detail file>]`
 *
 * Read-only check of an untrusted copy of the old site's `wp-content/uploads` folder against the attachments and image
 * addresses of the WXR export. Nothing is written except the optional detail file, nothing is executed, no database
 * and no network are used. COUNTS ONLY are printed (never a file name, title or address); `--out` receives one JSON line
 * per file and per unresolved reference (private: it holds real file names), and must be outside every git work tree.
 */

export type Tally = Record<string, number>

export type FileVerdict = { rel: string; bytes: number; reason: UnsafeReason | null; sha256?: string; warning?: boolean }

export type UploadsCheckReport = {
  files: { total: number; bytes: number; safe: number; /** safe files that hold a script marker (advisory: the Media re-save removes it) */ warnings: number; rejected: Tally }
  topLevel: { yearFolders: number; otherFolders: number; looseFiles: number }
  duplicates: { groups: number; extraFiles: number }
  attachments: { inExport: number; distinctPaths: number; present: number; missing: number; sizeVariantOnly: number; unicodeMismatch: number; caseMismatch: number; rejectedUnsafe: number; notImportable: number; noPath: number }
  bodyImages: { distinctReferenced: number; present: number; resolvedViaOriginal: number; missing: number; sizeVariantOnly: number; unicodeMismatch: number; caseMismatch: number; rejectedUnsafe: number; notImportable: number }
  featured: { posts: number; present: number; missing: number; noAttachment: number; rejectedUnsafe: number; notImportable: number }
  tree: { unreferenced: number; derivedSizeVariants: number }
}

export type DetailLine = { kind: 'file' | 'attachment' | 'body-image'; path: string; status: string }

/** Reasons that mean "a real file the CMS cannot take", counted apart from unsafe ones. */
const NOT_IMPORTABLE = new Set<UnsafeReason>(['unsupported-type', 'too-large'])

const bump = (t: Tally, k: string, by = 1): void => {
  t[k] = (t[k] ?? 0) + by
}

// ---------------------------------------------------------------------------------------------
// walking the uploads tree (never follows links)
// ---------------------------------------------------------------------------------------------

export type WalkEntry = { rel: string; kind: 'file' | 'symlink' | 'other'; bytes: number; nlink?: number }

export function walkUploads(root: string): { entries: WalkEntry[]; topYears: number; topOtherDirs: number; topFiles: number } {
  const entries: WalkEntry[] = []
  let topYears = 0
  let topOtherDirs = 0
  let topFiles = 0
  const stack: string[] = ['']
  while (stack.length > 0) {
    const relDir = stack.pop() as string
    const abs = relDir === '' ? root : path.join(root, ...relDir.split('/'))
    for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
      const rel = relDir === '' ? d.name : `${relDir}/${d.name}`
      const top = relDir === ''
      if (d.isSymbolicLink()) {
        entries.push({ rel, kind: 'symlink', bytes: 0 })
        if (top) topOtherDirs++
      } else if (d.isDirectory()) {
        if (top) /^\d{4}$/.test(d.name) ? topYears++ : topOtherDirs++
        stack.push(rel)
      } else if (d.isFile()) {
        if (top) topFiles++
        const st = fs.lstatSync(path.join(abs, d.name))
        entries.push({ rel, kind: 'file', bytes: st.size, nlink: st.nlink })
      } else {
        entries.push({ rel, kind: 'other', bytes: 0 })
      }
    }
  }
  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  return { entries, topYears, topOtherDirs, topFiles }
}

// ---------------------------------------------------------------------------------------------
// what the export refers to
// ---------------------------------------------------------------------------------------------

const IMG_SRC_RE = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi

export type ExportRefs = {
  attachmentItems: number
  attachmentPaths: Set<string>
  attachmentsWithoutPath: number
  bodyRefs: Set<string>
  featuredPosts: number
  /** One entry per published post that has a featured image id: the attachment path, or null when unknown. */
  featuredPaths: Array<string | null>
}

function attachmentPath(att: WxrAttachment): string | null {
  if (att.attachedFile && isSafeRelativeUploadPath(att.attachedFile)) return att.attachedFile
  return legacyPathFromUrl(att.url) ?? legacyPathFromUrl(att.attachedFile)
}

export async function collectExportRefs(file: string): Promise<ExportRefs> {
  const refs: ExportRefs = { attachmentItems: 0, attachmentPaths: new Set(), attachmentsWithoutPath: 0, bodyRefs: new Set(), featuredPosts: 0, featuredPaths: [] }
  const byId = new Map<number, string | null>()
  const posts: WxrItem[] = []
  for await (const rec of readWxrFile(file)) {
    if (rec.record !== 'item') continue
    const item = rec.item
    if (item.kind === 'attachment' && item.attachment) {
      refs.attachmentItems++
      const p = attachmentPath(item.attachment)
      if (p) refs.attachmentPaths.add(p)
      else refs.attachmentsWithoutPath++
      if (item.wpId !== null) byId.set(item.wpId, p)
    } else if (item.kind === 'post' && item.status === 'publish') {
      posts.push({ ...item, comments: [] })
    }
  }
  for (const post of posts) {
    for (const m of post.contentHtml.matchAll(IMG_SRC_RE)) {
      const p = legacyPathFromUrl(m[1] ?? m[2] ?? '')
      if (p) refs.bodyRefs.add(p)
    }
    if (post.thumbnailId !== null) {
      refs.featuredPosts++
      refs.featuredPaths.push(byId.get(post.thumbnailId) ?? null)
    }
  }
  return refs
}

// ---------------------------------------------------------------------------------------------
// reconcile
// ---------------------------------------------------------------------------------------------

type Found = { how: 'exact' | 'unicode' | 'case'; rel: string }

export function reconcile(verdicts: readonly FileVerdict[], refs: ExportRefs, detail?: (l: DetailLine) => void): UploadsCheckReport {
  const byRel = new Map(verdicts.map((v) => [v.rel, v]))
  const nfc = new Map<string, string>()
  const ci = new Map<string, string>()
  const derived = new Map<string, number>() // stripped base path (lowercase NFC) -> count of size-variant files
  for (const v of verdicts) {
    const n = v.rel.normalize('NFC')
    if (!nfc.has(n)) nfc.set(n, v.rel)
    const k = n.toLowerCase()
    if (!ci.has(k)) ci.set(k, v.rel)
    const stripped = stripSizeSuffix(v.rel)
    if (stripped !== v.rel) {
      const dk = stripped.normalize('NFC').toLowerCase()
      derived.set(dk, (derived.get(dk) ?? 0) + 1)
    }
  }
  const find = (rel: string): Found | null => {
    if (byRel.has(rel)) return { how: 'exact', rel }
    const n = rel.normalize('NFC')
    const u = nfc.get(n)
    if (u !== undefined) return { how: 'unicode', rel: u }
    const c = ci.get(n.toLowerCase())
    if (c !== undefined) return { how: 'case', rel: c }
    return null
  }
  const hasVariant = (rel: string): boolean => derived.has(rel.normalize('NFC').toLowerCase())
  const used = new Set<string>()

  const files: UploadsCheckReport['files'] = { total: verdicts.length, bytes: 0, safe: 0, warnings: 0, rejected: {} }
  const byHash = new Map<string, number>()
  for (const v of verdicts) {
    files.bytes += v.bytes
    if (v.reason) bump(files.rejected, v.reason)
    else {
      files.safe++
      if (v.sha256) byHash.set(v.sha256, (byHash.get(v.sha256) ?? 0) + 1)
      if (v.warning) files.warnings++
    }
  }
  let groups = 0
  let extra = 0
  for (const n of byHash.values()) if (n > 1) (groups++, (extra += n - 1))

  type Status = 'present' | 'resolved-via-original' | 'unicode' | 'case' | 'size-variant-only' | 'missing' | 'rejected-unsafe' | 'not-importable'
  const classify = (rel: string): Status => {
    for (const cand of candidatePaths(rel)) {
      const f = find(cand)
      if (!f) continue
      const v = byRel.get(f.rel) as FileVerdict
      if (v.reason) return NOT_IMPORTABLE.has(v.reason) ? 'not-importable' : 'rejected-unsafe'
      used.add(f.rel)
      if (f.how !== 'exact') return f.how
      return cand === rel ? 'present' : 'resolved-via-original'
    }
    return hasVariant(rel) || hasVariant(stripSizeSuffix(rel)) ? 'size-variant-only' : 'missing'
  }

  const att: UploadsCheckReport['attachments'] = { inExport: refs.attachmentItems, distinctPaths: refs.attachmentPaths.size, present: 0, missing: 0, sizeVariantOnly: 0, unicodeMismatch: 0, caseMismatch: 0, rejectedUnsafe: 0, notImportable: 0, noPath: refs.attachmentsWithoutPath }
  const attStatus = new Map<string, Status>()
  for (const p of refs.attachmentPaths) {
    const s = classify(p)
    attStatus.set(p, s)
    detail?.({ kind: 'attachment', path: p, status: s })
    if (s === 'present' || s === 'resolved-via-original') att.present++
    else if (s === 'unicode') att.unicodeMismatch++
    else if (s === 'case') att.caseMismatch++
    else if (s === 'size-variant-only') att.sizeVariantOnly++
    else if (s === 'rejected-unsafe') att.rejectedUnsafe++
    else if (s === 'not-importable') att.notImportable++
    else att.missing++
  }

  const body: UploadsCheckReport['bodyImages'] = { distinctReferenced: refs.bodyRefs.size, present: 0, resolvedViaOriginal: 0, missing: 0, sizeVariantOnly: 0, unicodeMismatch: 0, caseMismatch: 0, rejectedUnsafe: 0, notImportable: 0 }
  for (const p of refs.bodyRefs) {
    const s = classify(p)
    detail?.({ kind: 'body-image', path: p, status: s })
    if (s === 'present') body.present++
    else if (s === 'resolved-via-original') body.resolvedViaOriginal++
    else if (s === 'unicode') body.unicodeMismatch++
    else if (s === 'case') body.caseMismatch++
    else if (s === 'size-variant-only') body.sizeVariantOnly++
    else if (s === 'rejected-unsafe') body.rejectedUnsafe++
    else if (s === 'not-importable') body.notImportable++
    else body.missing++
  }

  const featured: UploadsCheckReport['featured'] = { posts: refs.featuredPosts, present: 0, missing: 0, noAttachment: 0, rejectedUnsafe: 0, notImportable: 0 }
  for (const p of refs.featuredPaths) {
    if (p === null) featured.noAttachment++
    else {
      const s = attStatus.get(p) ?? classify(p)
      if (s === 'present' || s === 'resolved-via-original') featured.present++
      else if (s === 'rejected-unsafe') featured.rejectedUnsafe++
      else if (s === 'not-importable') featured.notImportable++
      else featured.missing++
    }
  }

  // Files nothing refers to. A WordPress size variant of something used or listed is expected, not stray.
  const listed = new Set<string>()
  for (const p of [...refs.attachmentPaths, ...refs.bodyRefs]) for (const cand of candidatePaths(p)) listed.add(cand.normalize('NFC').toLowerCase())
  const usedKeys = new Set([...used].map((u) => u.normalize('NFC').toLowerCase()))
  let unreferenced = 0
  let derivedCount = 0
  for (const v of verdicts) {
    if (v.reason || used.has(v.rel)) continue
    const key = v.rel.normalize('NFC').toLowerCase()
    const stripped = stripSizeSuffix(v.rel).normalize('NFC').toLowerCase()
    if (listed.has(key)) continue
    if (stripped !== key && (listed.has(stripped) || usedKeys.has(stripped))) derivedCount++
    else unreferenced++
  }
  if (detail) for (const v of verdicts) detail({ kind: 'file', path: v.rel, status: v.reason ?? 'safe' })

  return { files, topLevel: { yearFolders: 0, otherFolders: 0, looseFiles: 0 }, duplicates: { groups, extraFiles: extra }, attachments: att, bodyImages: body, featured, tree: { unreferenced, derivedSizeVariants: derivedCount } }
}

// ---------------------------------------------------------------------------------------------
// the check itself
// ---------------------------------------------------------------------------------------------

export async function verdictsFor(root: string, entries: readonly WalkEntry[]): Promise<FileVerdict[]> {
  const out: FileVerdict[] = []
  for (const e of entries) {
    if (e.kind === 'symlink') {
      out.push({ rel: e.rel, bytes: 0, reason: 'symlink' })
      continue
    }
    if (e.kind === 'other') {
      out.push({ rel: e.rel, bytes: 0, reason: 'not-a-file' })
      continue
    }
    const byName = unsafeNameReason(e.rel)
    if (byName) {
      out.push({ rel: e.rel, bytes: e.bytes, reason: byName })
      continue
    }
    if ((e.nlink ?? 1) > 1) {
      out.push({ rel: e.rel, bytes: e.bytes, reason: 'hard-link' })
      continue
    }
    if (e.bytes > MEDIA_MAX_BYTES) {
      // Never read a file over the cap (neither here nor in the loader).
      out.push({ rel: e.rel, bytes: e.bytes, reason: 'too-large' })
      continue
    }
    try {
      const scan = await scanFile(path.join(root, ...e.rel.split('/')))
      const v = judgeContent(e.rel, scan)
      out.push({ rel: e.rel, bytes: e.bytes, reason: v.reason, sha256: scan.sha256, ...(v.warning ? { warning: true } : {}) })
    } catch {
      out.push({ rel: e.rel, bytes: e.bytes, reason: 'unreadable' })
    }
  }
  return out
}

export async function checkUploads(root: string, wxrFile: string, detail?: (l: DetailLine) => void): Promise<UploadsCheckReport> {
  const walked = walkUploads(root)
  const verdicts = await verdictsFor(root, walked.entries)
  const refs = await collectExportRefs(wxrFile)
  const report = reconcile(verdicts, refs, detail)
  report.topLevel = { yearFolders: walked.topYears, otherFolders: walked.topOtherDirs, looseFiles: walked.topFiles }
  return report
}

export function formatUploadsCheck(r: UploadsCheckReport): string {
  const kv = (t: Tally) => (Object.keys(t).length ? Object.entries(t).sort().map(([k, v]) => `    ${k}: ${v}`) : ['    (none)'])
  const mb = Math.round((r.files.bytes / 1024 / 1024) * 10) / 10
  return [
    'Uploads check (read-only, counts only)',
    'Folder',
    `  files: ${r.files.total}, total ${r.files.bytes} bytes (${mb} MB)`,
    `  top-level year folders: ${r.topLevel.yearFolders}; other top-level folders: ${r.topLevel.otherFolders}; loose top-level files: ${r.topLevel.looseFiles}`,
    `  safe, importable images: ${r.files.safe} (of which with a script marker inside, advisory only because the Media re-save removes it: ${r.files.warnings})`,
    '  rejected as unsafe, by reason:',
    ...kv(r.files.rejected),
    `  duplicate content: ${r.duplicates.groups} groups, ${r.duplicates.extraFiles} extra copies`,
    'Attachments in the export',
    `  attachment items: ${r.attachments.inExport}, distinct paths: ${r.attachments.distinctPaths}, items with no usable path: ${r.attachments.noPath}`,
    `  present: ${r.attachments.present}; missing: ${r.attachments.missing}; only size variants on disk: ${r.attachments.sizeVariantOnly}`,
    `  name differs by Unicode form: ${r.attachments.unicodeMismatch}; by letter case: ${r.attachments.caseMismatch}; rejected as unsafe: ${r.attachments.rejectedUnsafe}; not importable (unsupported type or too large): ${r.attachments.notImportable}`,
    'Images in published article bodies (distinct addresses)',
    `  referenced: ${r.bodyImages.distinctReferenced}; present: ${r.bodyImages.present}; present as the original of a size variant: ${r.bodyImages.resolvedViaOriginal}; missing: ${r.bodyImages.missing}; only size variants on disk: ${r.bodyImages.sizeVariantOnly}`,
    `  name differs by Unicode form: ${r.bodyImages.unicodeMismatch}; by letter case: ${r.bodyImages.caseMismatch}; rejected as unsafe: ${r.bodyImages.rejectedUnsafe}; not importable: ${r.bodyImages.notImportable}`,
    'Featured images of published posts',
    `  posts with a featured image id: ${r.featured.posts}; present: ${r.featured.present}; missing: ${r.featured.missing}; attachment not in the export: ${r.featured.noAttachment}; rejected as unsafe: ${r.featured.rejectedUnsafe}; not importable: ${r.featured.notImportable}`,
    'Rest of the folder',
    `  size variants of listed images: ${r.tree.derivedSizeVariants}; unreferenced: ${r.tree.unreferenced}`,
  ].join('\n')
}

export type CliIo = { out: (line: string) => void; err: (line: string) => void }

const arg = (argv: readonly string[], name: string): string | undefined | null => {
  const i = argv.indexOf(name)
  if (i < 0) return undefined
  const v = argv[i + 1]
  return !v || v.startsWith('--') ? null : v
}

/** Exit code: 0 done, 1 failed, 2 bad usage or location, 3 done but unsafe files were found. Errors print one short code. */
export async function runUploadsCheckCli(argv: readonly string[], io: CliIo, cwd: string = process.cwd()): Promise<number> {
  const uploads = arg(argv, '--uploads')
  const wxr = arg(argv, '--wxr')
  const out = arg(argv, '--out')
  if (!uploads || !wxr || out === null) {
    io.err('UPLOADS_CHECK_USAGE')
    return 2
  }
  const uploadsAbs = path.resolve(cwd, uploads)
  const wxrAbs = path.resolve(cwd, wxr)
  if (isInsideRepo(uploadsAbs, cwd)) {
    io.err('UPLOADS_CHECK_UPLOADS_INSIDE_REPO')
    return 2
  }
  if (isInsideRepo(wxrAbs, cwd)) {
    io.err('UPLOADS_CHECK_FILE_INSIDE_REPO')
    return 2
  }
  let outAbs: string | undefined
  if (out !== undefined) {
    outAbs = path.resolve(cwd, out)
    if (isInsideRepo(outAbs, cwd)) {
      io.err('UPLOADS_CHECK_OUT_INSIDE_REPO')
      return 2
    }
    // The nearest existing parent is resolved (links and junctions), so a not-yet-existing --out is judged by where it would really land.
    if (isInsideDir(outAbs, uploadsAbs)) {
      io.err('UPLOADS_CHECK_OUT_INSIDE_UPLOADS')
      return 2
    }
    const problem = privateOutProblem(outAbs, { inputs: [wxrAbs] })
    if (problem) {
      io.err(problem === 'OUT_IS_INPUT' ? 'UPLOADS_CHECK_OUT_IS_INPUT' : 'UPLOADS_CHECK_OUT_EXISTS')
      return 2
    }
  }
  try {
    if (!fs.statSync(uploadsAbs).isDirectory()) throw new Error('x')
  } catch {
    io.err('UPLOADS_CHECK_NO_UPLOADS_DIR')
    return 2
  }
  let fd: number | undefined
  try {
    if (outAbs) fd = openPrivateOut(outAbs, { inputs: [wxrAbs], notInside: [uploadsAbs] })
    const report = await checkUploads(uploadsAbs, wxrAbs, fd === undefined ? undefined : (l) => fs.writeSync(fd as number, `${JSON.stringify(l)}\n`))
    io.out(formatUploadsCheck(report))
    return Object.keys(report.files.rejected).length > 0 ? 3 : 0
  } catch (err) {
    io.err(err instanceof WxrError ? err.code : err instanceof PrivateOutError ? `UPLOADS_CHECK_${err.code}` : 'UPLOADS_CHECK_FAILED')
    return 1
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}
