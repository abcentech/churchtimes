import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { sniffAvMimes } from '../lib/avMedia'
import { AV_EXTENSION_MIMES, isImportableExtension, MEDIA_EXTENSION_MIME, maxBytesForPath, type AllowedMime } from '../lib/mediaLimits'

/**
 * Safety checks for a file from an UNTRUSTED copy of the old site's `wp-content/uploads` folder (the old server was
 * compromised). Shared by the read-only `import:uploads-check` command and by the loader (`media.ts`), so a file the
 * checker rejects is also never ingested. Pure checks plus a streaming scan; nothing here writes or executes anything.
 *
 * The REAL protection is the Media collection: an importable picture must be a JPEG, PNG or WebP by its magic bytes, within
 * 40 megapixels, and it is decoded and re-saved with sharp, so nothing hidden after the image data survives. (Audio and
 * video are stored as uploaded, so for those a script marker stays a rejection.) The checks
 * here are a first filter: names and extensions (allow-list), links, size, magic bytes against the extension. A script
 * marker inside an image is only an ADVISORY warning (random image data contains such byte runs by chance, and the
 * re-save removes any payload).
 *
 * Verdict codes are a closed vocabulary (never a name or a path), so they are safe to print and count.
 */

export type UnsafeReason =
  | 'dangerous-extension'
  | 'hidden-file'
  | 'bad-name'
  | 'symlink'
  | 'hard-link'
  | 'zero-byte'
  | 'too-large'
  | 'not-a-file'
  | 'not-media'
  | 'unsupported-type'
  | 'magic-mismatch'
  | 'polyglot'
  | 'unreadable'

/** Final extensions that are never media: scripts, server config, executables, markup, archives. */
const DANGEROUS_EXT = new Set([
  'php', 'php2', 'php3', 'php4', 'php5', 'php6', 'php7', 'php8', 'phtml', 'pht', 'phps', 'phar', 'inc',
  'htaccess', 'htpasswd', 'ini', 'sh', 'bash', 'zsh', 'bat', 'cmd', 'com', 'exe', 'dll', 'msi', 'scr', 'ps1', 'vbs', 'jar', 'so', 'bin', 'elf',
  'js', 'mjs', 'cjs', 'html', 'htm', 'xhtml', 'shtml', 'svg', 'svgz', 'xml', 'xsl', 'xslt',
  'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'rar', '7z', 'cab', 'iso', 'sql', 'bak', 'old', 'swp', 'log',
  'py', 'pl', 'rb', 'cgi', 'asp', 'aspx', 'jsp', 'jspx', 'cfm',
])
/** Inner extensions that make a name suspicious even with a harmless last one (`shell.php.jpg`, `x.html.jpg`, `x.svg.png`). */
const DANGEROUS_INNER = new Set([
  'php', 'php2', 'php3', 'php4', 'php5', 'php6', 'php7', 'php8', 'phtml', 'pht', 'phps', 'phar', 'cgi', 'asp', 'aspx', 'jsp', 'jspx', 'sh', 'htaccess', 'shtml', 'pl', 'py',
  'html', 'htm', 'xhtml', 'svg', 'svgz', 'js', 'mjs', 'cjs', 'xml', 'exe', 'dll', 'bat', 'cmd', 'ps1', 'vbs', 'jar',
])
/** Real picture or document formats that the Media collection does not take (so they are counted, not imported). */
const UNSUPPORTED_MEDIA_EXT = new Set(['gif', 'bmp', 'ico', 'avif', 'pdf', 'tif', 'tiff', 'heic', 'heif'])
/** Windows device names: reserved with any extension (`con.png`). */
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/

export const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'ico'])

export type ImageKind = 'jpg' | 'png' | 'gif' | 'webp' | 'avif' | 'bmp' | 'ico'

/** The image type implied by the first bytes, or null. */
export function sniffKind(b: Uint8Array): ImageKind | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg'
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'png'
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return 'gif'
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp'
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70 && b[8] === 0x61 && b[9] === 0x76 && b[10] === 0x69 && (b[11] === 0x66 || b[11] === 0x73)) return 'avif'
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'bmp'
  if (b.length >= 4 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return 'ico'
  return null
}


const kindOfMime = (m: AllowedMime): ImageKind => (m === 'image/jpeg' ? 'jpg' : m === 'image/png' ? 'png' : 'webp')

/** Extension (lower case, trailing dots and spaces removed) of the last path segment, or ''. */
const extensionOf = (rel: string): string => {
  const name = (rel.split('/').pop() ?? '').replace(/[. ]+$/, '').toLowerCase()
  const i = name.lastIndexOf('.')
  return i < 0 ? '' : name.slice(i + 1)
}

/** Name-only verdict for a relative path with `/` separators. Checks every segment. */
export function unsafeNameReason(rel: string): UnsafeReason | null {
  // `:` is an NTFS stream separator (`a.png:evil.php`) and a drive marker.
  if (CONTROL_RE.test(rel) || rel.includes('\\') || rel.includes(':')) return 'bad-name'
  const segments = rel.split('/')
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') return 'bad-name'
    if (seg.startsWith('.')) return 'hidden-file'
    // Windows drops trailing dots and spaces, and a device name is reserved with any extension.
    const stem = seg.replace(/[. ]+$/, '').split('.')[0] ?? ''
    if (WINDOWS_RESERVED_RE.test(stem.trimEnd().toLowerCase())) return 'bad-name'
  }
  const last = segments[segments.length - 1] as string
  const stripped = last.replace(/[. ]+$/, '').toLowerCase()
  const parts = stripped.split('.').map((p) => p.trim())
  const ext = parts.length > 1 ? (parts[parts.length - 1] as string) : ''
  if (DANGEROUS_EXT.has(ext)) return 'dangerous-extension'
  if (parts.slice(1, -1).some((p) => DANGEROUS_INNER.has(p))) return 'dangerous-extension'
  // Allow-list: only these may be imported (pictures, and audio/video since the audioVideo block). Everything else is not media.
  if (isImportableExtension(ext)) {
    // `photo.jpg.` or `photo.jpg ` name a different file on Windows than the one on disk.
    return stripped === last.toLowerCase() ? null : 'bad-name'
  }
  if (UNSUPPORTED_MEDIA_EXT.has(ext)) return 'unsupported-type'
  return 'not-media'
}

const MAX_NEEDLE = 8

/** True when `buf` holds `<?php` or `<script` in any letter case. (`<?=` is not looked for: it occurs by chance in image data.) */
export function hasActiveContent(buf: Uint8Array): boolean {
  const s = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString('latin1').toLowerCase()
  return s.includes('<?php') || s.includes('<script')
}

/** `hasActiveContent` for a large buffer: in 1 MB slices (a big string would be needlessly large), markers across slice borders included. */
export function bufferHasActiveContent(buf: Buffer): boolean {
  const STEP = 1024 * 1024
  for (let at = 0; at < buf.length; at += STEP) {
    if (hasActiveContent(buf.subarray(Math.max(0, at - (MAX_NEEDLE - 1)), Math.min(buf.length, at + STEP)))) return true
  }
  return false
}

export type ScanResult = { head: Buffer; bytes: number; sha256: string; polyglot: boolean }

/** Stream a file once (at most the size cap of its type plus one byte): first bytes, size, SHA-256 and a scan for script markers across chunk borders. */
export async function scanFile(file: string, maxBytes: number = maxBytesForPath(file)): Promise<ScanResult> {
  const hash = crypto.createHash('sha256')
  let head = Buffer.alloc(0)
  let bytes = 0
  let polyglot = false
  let tail = ''
  const stream = fs.createReadStream(file, { highWaterMark: 1024 * 1024, start: 0, end: maxBytes })
  for await (const chunk of stream) {
    const buf = chunk as Buffer
    hash.update(buf)
    bytes += buf.length
    if (head.length < 32) head = Buffer.concat([head, buf.subarray(0, 32 - head.length)])
    if (!polyglot) {
      const text = tail + buf.toString('latin1').toLowerCase()
      if (text.includes('<?php') || text.includes('<script')) polyglot = true
      tail = text.slice(-(MAX_NEEDLE - 1))
    }
  }
  return { head, bytes, sha256: hash.digest('hex'), polyglot }
}

/** `warning`: a script marker inside an image. Advisory only: the Media re-save removes anything hidden in the file. */
export type ContentVerdict = { reason: UnsafeReason | null; warning: boolean; /** the type to store the file as, when it may be imported */ mimetype?: string }

/**
 * Content verdict: size cap of the type, extension against magic bytes. A script marker in an importable PICTURE is a warning,
 * never a rejection (it is re-saved). Audio and video are stored as uploaded, so a script marker there is still `polyglot`.
 */
export function judgeContent(rel: string, scan: Pick<ScanResult, 'head' | 'bytes' | 'polyglot'>): ContentVerdict {
  if (scan.bytes === 0) return { reason: 'zero-byte', warning: false }
  if (scan.bytes > maxBytesForPath(rel)) return { reason: 'too-large', warning: false }
  const ext = extensionOf(rel)
  const mime = MEDIA_EXTENSION_MIME[ext]
  if (mime !== undefined) {
    if (sniffKind(scan.head) !== kindOfMime(mime)) return { reason: 'magic-mismatch', warning: false }
    return { reason: null, warning: scan.polyglot, mimetype: mime }
  }
  const avMimes = AV_EXTENSION_MIMES[ext]
  if (avMimes !== undefined) {
    const sniffed = sniffAvMimes(scan.head)
    const pick = avMimes.find((m) => sniffed.includes(m))
    if (pick === undefined) return { reason: 'magic-mismatch', warning: false }
    return scan.polyglot ? { reason: 'polyglot', warning: false } : { reason: null, warning: false, mimetype: pick }
  }
  return { reason: scan.polyglot ? 'polyglot' : 'not-media', warning: false }
}

/** Rejection reason from a scan (see `judgeContent`). */
export function unsafeContentReason(rel: string, scan: ScanResult): UnsafeReason | null {
  return judgeContent(rel, scan).reason
}

/**
 * lstat every segment of `rel` below `root` (never following links). A link or junction anywhere in the path, or a
 * non-regular last segment, is refused, and so is a file with more than one hard link (it may be the same data as
 * something outside the folder). Returns the file size on success.
 */
export function lstatChain(root: string, rel: string): { ok: true; size: number } | { ok: false; reason: UnsafeReason } {
  const segments = rel.split('/')
  let cur = root
  let size = 0
  for (let i = 0; i < segments.length; i++) {
    cur = path.join(cur, segments[i] as string)
    let st: fs.Stats
    try {
      st = fs.lstatSync(cur)
    } catch {
      return { ok: false, reason: 'unreadable' }
    }
    if (st.isSymbolicLink()) return { ok: false, reason: 'symlink' }
    const last = i === segments.length - 1
    if (last && !st.isFile()) return { ok: false, reason: 'not-a-file' }
    if (!last && !st.isDirectory()) return { ok: false, reason: 'not-a-file' }
    if (last && st.nlink > 1) return { ok: false, reason: 'hard-link' }
    size = st.size
  }
  return { ok: true, size }
}

export type CheckedFile = { ok: true; data: Buffer; name: string; mimetype: string; size: number; warning: boolean }

/**
 * Check and read one file under `root` (a real path) in a single pass, for the loader: name, links, size, then the file is
 * opened once (never following a link at the last step), read in full (at most the size cap) and judged from that very
 * buffer. The caller uploads the returned bytes, not the path, so the file cannot change between check and use.
 */
export function readCheckedFile(root: string, rel: string): CheckedFile | { ok: false; reason: UnsafeReason } {
  const byName = unsafeNameReason(rel)
  if (byName) return { ok: false, reason: byName }
  const chain = lstatChain(root, rel)
  if (!chain.ok) return chain
  const cap = maxBytesForPath(rel)
  if (chain.size > cap) return { ok: false, reason: 'too-large' }
  const abs = path.join(root, ...rel.split('/'))
  let fd: number | undefined
  try {
    fd = fs.openSync(abs, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    const st = fs.fstatSync(fd)
    if (!st.isFile()) return { ok: false, reason: 'not-a-file' }
    if (st.nlink > 1) return { ok: false, reason: 'hard-link' }
    if (st.size > cap) return { ok: false, reason: 'too-large' }
    const data = Buffer.alloc(st.size)
    let off = 0
    while (off < data.length) {
      const n = fs.readSync(fd, data, off, data.length - off, off)
      if (n === 0) break
      off += n
    }
    if (off !== data.length) return { ok: false, reason: 'unreadable' }
    const verdict = judgeContent(rel, { head: data.subarray(0, 32), bytes: data.length, polyglot: bufferHasActiveContent(data) })
    if (verdict.reason) return { ok: false, reason: verdict.reason }
    return { ok: true, data, name: path.basename(abs), mimetype: verdict.mimetype as string, size: data.length, warning: verdict.warning }
  } catch {
    return { ok: false, reason: 'unreadable' }
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

/** Full verdict for one file under `root`. Null when the file may be ingested. */
export async function unsafeFileReason(root: string, rel: string): Promise<UnsafeReason | null> {
  const r = readCheckedFile(root, rel)
  return r.ok ? null : r.reason
}
