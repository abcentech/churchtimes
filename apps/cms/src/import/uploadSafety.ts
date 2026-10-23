import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Safety checks for a file from an UNTRUSTED copy of the old site's `wp-content/uploads` folder (the old server was
 * compromised). Shared by the read-only `import:uploads-check` command and by the loader (`media.ts`), so a file the
 * checker rejects is also never ingested. Pure checks plus a streaming scan; nothing here writes or executes anything.
 *
 * Verdict codes are a closed vocabulary (never a name or a path), so they are safe to print and count.
 */

export type UnsafeReason =
  | 'dangerous-extension'
  | 'hidden-file'
  | 'bad-name'
  | 'symlink'
  | 'zero-byte'
  | 'not-a-file'
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
/** Inner extensions that make a name suspicious even with a harmless last one (`shell.php.jpg`). */
const DANGEROUS_INNER = new Set(['php', 'php2', 'php3', 'php4', 'php5', 'php6', 'php7', 'php8', 'phtml', 'pht', 'phps', 'phar', 'cgi', 'asp', 'aspx', 'jsp', 'jspx', 'sh', 'htaccess', 'shtml', 'pl', 'py'])

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

const extKind = (ext: string): ImageKind | null => {
  if (!IMAGE_EXTENSIONS.has(ext)) return null
  return (ext === 'jpeg' ? 'jpg' : ext) as ImageKind
}

/** Name-only verdict for a relative path with `/` separators. Checks every segment. */
export function unsafeNameReason(rel: string): UnsafeReason | null {
  if (CONTROL_RE.test(rel) || rel.includes('\\')) return 'bad-name'
  const segments = rel.split('/')
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') return 'bad-name'
    if (seg.startsWith('.')) return 'hidden-file'
  }
  const name = (segments[segments.length - 1] as string).toLowerCase()
  const parts = name.split('.')
  if (parts.length > 1) {
    if (DANGEROUS_EXT.has(parts[parts.length - 1] as string)) return 'dangerous-extension'
    if (parts.slice(1, -1).some((p) => DANGEROUS_INNER.has(p))) return 'dangerous-extension'
  }
  return null
}

const MAX_NEEDLE = 8

/** True when `buf` holds `<?php`, `<?=` or `<script` in any letter case. */
export function hasActiveContent(buf: Uint8Array): boolean {
  const s = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString('latin1').toLowerCase()
  return s.includes('<?php') || s.includes('<?=') || s.includes('<script')
}

export type ScanResult = { head: Buffer; bytes: number; sha256: string; polyglot: boolean }

/** Stream a file once: first bytes, size, SHA-256 and a scan for active content across chunk borders. */
export async function scanFile(file: string): Promise<ScanResult> {
  const hash = crypto.createHash('sha256')
  let head = Buffer.alloc(0)
  let bytes = 0
  let polyglot = false
  let tail = ''
  const stream = fs.createReadStream(file, { highWaterMark: 1024 * 1024 })
  for await (const chunk of stream) {
    const buf = chunk as Buffer
    hash.update(buf)
    bytes += buf.length
    if (head.length < 32) head = Buffer.concat([head, buf.subarray(0, 32 - head.length)])
    if (!polyglot) {
      const text = tail + buf.toString('latin1').toLowerCase()
      if (text.includes('<?php') || text.includes('<?=') || text.includes('<script')) polyglot = true
      tail = text.slice(-(MAX_NEEDLE - 1))
    }
  }
  return { head, bytes, sha256: hash.digest('hex'), polyglot }
}

/** Content verdict from a scan: size, extension against magic bytes, active content. */
export function unsafeContentReason(rel: string, scan: ScanResult): UnsafeReason | null {
  if (scan.bytes === 0) return 'zero-byte'
  const ext = (rel.split('.').pop() ?? '').toLowerCase()
  const want = extKind(ext)
  if (want !== null && sniffKind(scan.head) !== want) return 'magic-mismatch'
  if (scan.polyglot) return 'polyglot'
  return null
}

/**
 * lstat every segment of `rel` below `root` (never following links). A link or junction anywhere in the path, or a
 * non-regular last segment, is refused. Returns the file size on success.
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
    size = st.size
  }
  return { ok: true, size }
}

/** Full verdict for one file under `root` (used by the loader). Null when the file may be ingested. */
export async function unsafeFileReason(root: string, rel: string): Promise<UnsafeReason | null> {
  const byName = unsafeNameReason(rel)
  if (byName) return byName
  const chain = lstatChain(root, rel)
  if (!chain.ok) return chain.reason
  try {
    return unsafeContentReason(rel, await scanFile(path.join(root, ...rel.split('/'))))
  } catch {
    return 'unreadable'
  }
}
