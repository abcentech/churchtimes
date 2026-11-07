import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import sharp from 'sharp'

import { attachmentPath } from './uploadsCheck'
import { isInsideRepo } from './safePaths'
import { readWxrFile } from './wxr'

/**
 * `npm run uploads:synth -- --wxr <export.xml> --out <dir> [--seed N] [--variant-percent 15] [--manifest <file>]`
 *
 * Writes a SYNTHETIC `wp-content/uploads` tree for a real WXR export, so the whole media pipeline can be rehearsed at
 * real scale before the real files arrive. One tiny, valid file at every attachment path of the export (JPEG, PNG,
 * WebP from seeded gradients with a little noise; MP4/M4A/MP3/WebM/Ogg placeholders with valid headers), WordPress size
 * variants (`-300x200`) for a share of them, and a KNOWN set of deliberately bad files so detection counts can be
 * asserted. Deterministic (the same export and seed give the same bytes). Nothing real is read except the export's
 * attachment and audio/video addresses; COUNTS ONLY are printed. The manifest (per-path detail, private) is written
 * next to `--out` (never inside it), and `--out` must not be inside a git work tree.
 *
 * The "bad" files hold only a harmless marker (`<?php` or `<script` plus a comment), which is all the checks look for:
 * a realistic web shell would be flagged by antivirus on a developer machine and make the run fail.
 */

export class SynthError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

export type SynthExpected = {
  /** Expected `attachments.rejectedUnsafe` of `import:uploads-check` over the tree (planted bad files + non-media types). */
  rejectedUnsafe: number
  /** Expected `attachments.notImportable` (gif, pdf, avif, too large). */
  notImportable: number
  /** Expected `attachments.unicodeMismatch` and `caseMismatch`. */
  unicodeMismatch: number
  caseMismatch: number
  /** Safe images that hold a script marker (advisory warnings: re-saved on import). */
  polyglotImageWarnings: number
}

export type SynthManifest = {
  seed: number
  distinctAttachmentPaths: number
  written: { files: number; bytes: number }
  byType: Record<string, number>
  variants: number
  avFromBodies: number
  extras: number
  skippedCollisions: number
  /** Planted bad files by category (counts); the paths are in `private`. */
  planted: Record<string, number>
  expected: SynthExpected
  private: { planted: Record<string, string[]>; extras: string[] }
}

export type SynthOptions = { wxr: string; out: string; manifest?: string; seed?: number; variantPercent?: number; concurrency?: number }

function mulberry(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const seedOf = (seed: number, key: string): number => crypto.createHash('sha1').update(`${seed}:${key}`).digest().readUInt32LE(0)

const extOf = (p: string): string => (p.split('/').pop() ?? '').toLowerCase().split('.').pop() ?? ''
const SIZE_RE = /-\d{1,5}x\d{1,5}(\.[A-Za-z0-9]+)$/
const AV_EXT = ['mp4', 'm4v', 'webm', 'mp3', 'm4a', 'ogg', 'oga']
const AV_URL_RE = new RegExp(`/wp-content/uploads/([^\\s"'<>)\\]?#]+?\\.(?:${AV_EXT.join('|')}))(?=$|[\\s"'<>)\\]?#])`, 'gi')

// ---------------------------------------------------------------------------------------------
// file bodies
// ---------------------------------------------------------------------------------------------

const PHP = Buffer.from('<?php /* synthetic marker */ ?>\n')
const SCRIPT = Buffer.from('<script>/* synthetic marker */</script>\n')

function rawImage(key: string, seed: number, width: number, height: number, noise: number): Buffer {
  const rand = mulberry(seedOf(seed, key))
  const ch = [0, 1, 2].map(() => ({ base: 40 + rand() * 160, dx: (rand() - 0.5) * 120, dy: (rand() - 0.5) * 120 }))
  const buf = Buffer.alloc(width * height * 3)
  let s = (seedOf(seed, `n${key}`) | 1) >>> 0
  let i = 0
  for (let y = 0; y < height; y++) {
    const fy = y / height
    for (let x = 0; x < width; x++) {
      const fx = x / width
      s ^= s << 13
      s >>>= 0
      s ^= s >>> 17
      s ^= s << 5
      s >>>= 0
      for (let c = 0; c < 3; c++) {
        const v = ch[c].base + ch[c].dx * fx + ch[c].dy * fy + (noise > 0 ? (((s >>> (c * 8)) & 0xff) / 255 - 0.5) * noise : 0)
        buf[i++] = v < 0 ? 0 : v > 255 ? 255 : v
      }
    }
  }
  return buf
}

async function image(kind: 'jpg' | 'png' | 'webp', key: string, seed: number, width: number, height: number, noise: number): Promise<Buffer> {
  const s = sharp(rawImage(key, seed, width, height, noise), { raw: { width, height, channels: 3 } })
  if (kind === 'jpg') return s.jpeg({ quality: 78 }).toBuffer()
  if (kind === 'webp') return s.webp({ quality: 70 }).toBuffer()
  return s.png({ compressionLevel: 6 }).toBuffer()
}

/** Dimensions vary a little with the key: about 320..1400 wide, 3:2, 4:3 or 16:9. */
function dims(key: string, seed: number): { w: number; h: number } {
  const r = mulberry(seedOf(seed, `d${key}`))
  const w = 320 + Math.floor(r() * 1080)
  const ratio = [2 / 3, 3 / 4, 9 / 16][Math.floor(r() * 3)] as number
  return { w, h: Math.max(120, Math.round(w * ratio)) }
}

function filler(key: string, seed: number, bytes: number): Buffer {
  const r = mulberry(seedOf(seed, `f${key}`))
  const b = Buffer.alloc(bytes)
  for (let i = 0; i < bytes; i++) b[i] = 0x80 + Math.floor(r() * 0x40) // never `<` (0x3c)
  return b
}

const box = (type: string, body: Buffer): Buffer => {
  const h = Buffer.alloc(8)
  h.writeUInt32BE(8 + body.length, 0)
  h.write(type, 4, 'latin1')
  return Buffer.concat([h, body])
}

/** A placeholder with the header the importer's magic check wants (not playable). */
export function avPlaceholder(ext: string, key: string, seed: number, bytes = 24 * 1024): Buffer {
  const body = filler(key, seed, bytes)
  switch (ext) {
    case 'm4a':
      return Buffer.concat([box('ftyp', Buffer.from('M4A \0\0\0\0M4A isom', 'latin1')), box('mdat', body)])
    case 'webm':
      return Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84]), Buffer.from('webm', 'latin1'), body])
    case 'mp3':
      return Buffer.concat([Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00', 'latin1'), body])
    case 'ogg':
    case 'oga':
      return Buffer.concat([Buffer.from('OggS\0\x02', 'latin1'), body])
    default: // mp4, m4v
      return Buffer.concat([box('ftyp', Buffer.from('isom\0\0\x02\0isomiso2mp41', 'latin1')), box('mdat', body)])
  }
}

const GIF = Buffer.from('R0lGODlhAQABAIAAAAUEBAAAACwAAAAAAQABAAACAkQBADs=', 'base64')
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n')

// ---------------------------------------------------------------------------------------------

type Job = { rel: string; make: () => Promise<Buffer> | Buffer; type: string }

export async function synthUploads(opts: SynthOptions, log: (s: string) => void = () => {}): Promise<SynthManifest> {
  const seed = opts.seed ?? 20261027
  const variantPercent = opts.variantPercent ?? 15
  const out = path.resolve(opts.out)
  if (isInsideRepo(out)) throw new SynthError('SYNTH_OUT_INSIDE_REPO')
  const manifestPath = path.resolve(opts.manifest ?? `${out.replace(/[\\/]+$/, '')}.synth-manifest.json`)
  if (isInsideRepo(manifestPath)) throw new SynthError('SYNTH_MANIFEST_INSIDE_REPO')
  if (manifestPath === out || manifestPath.startsWith(out + path.sep)) throw new SynthError('SYNTH_MANIFEST_INSIDE_OUT')
  if (fs.existsSync(manifestPath)) throw new SynthError('SYNTH_MANIFEST_EXISTS')
  if (fs.existsSync(out) && fs.readdirSync(out).length > 0) throw new SynthError('SYNTH_OUT_NOT_EMPTY')

  // 1. what the export refers to
  const attachments = new Set<string>()
  const avRefs = new Set<string>()
  for await (const rec of readWxrFile(opts.wxr)) {
    if (rec.record !== 'item') continue
    const item = rec.item
    if (item.kind === 'attachment' && item.attachment) {
      const p = attachmentPath(item.attachment)
      if (p) attachments.add(p)
    } else if (item.kind === 'post' && item.status === 'publish') {
      for (const m of item.contentHtml.matchAll(AV_URL_RE)) {
        let p = m[1] as string
        try {
          p = decodeURIComponent(p)
        } catch {
          /* keep */
        }
        avRefs.add(p)
      }
    }
  }
  const all = [...new Set([...attachments, ...avRefs])].sort()
  const avFromBodies = [...avRefs].filter((p) => !attachments.has(p)).length

  // 2. names that would collide on a case-insensitive or normalising file system are written once
  const seen = new Set<string>()
  const paths: string[] = []
  let skippedCollisions = 0
  for (const p of all) {
    const k = p.normalize('NFC').toLowerCase()
    if (seen.has(k)) skippedCollisions++
    else (seen.add(k), paths.push(p))
  }
  const attachmentSet = new Set(paths.filter((p) => attachments.has(p)))

  // 3. the planted bad set: deterministic picks from the attachments, by type, never the same path twice
  const taken = new Set<string>()
  const planted: Record<string, string[]> = {}
  const pickFrom = (pool: string[], n: number, offset: number): string[] => {
    const res: string[] = []
    const free = pool.filter((p) => !taken.has(p))
    for (let i = 0; i < n && free.length > 0; i++) {
      const idx = Math.min(free.length - 1, Math.floor(((i + 1 + offset) * free.length) / (n + 2 + offset)))
      const p = free.splice(idx, 1)[0] as string
      taken.add(p)
      res.push(p)
    }
    return res
  }
  const sortedBy = (...exts: string[]) => paths.filter((p) => attachmentSet.has(p) && exts.includes(extOf(p)) && !SIZE_RE.test(p))
  const jpgs = sortedBy('jpg', 'jpeg')
  const pngs = sortedBy('png')
  const mixedCase = jpgs.filter((p) => /[A-Z]/.test(p.split('/').pop() as string))
  const mp4s = sortedBy('mp4', 'm4v')
  planted['php-named-jpg'] = pickFrom(jpgs, 3, 0)
  planted['zero-byte'] = pickFrom(jpgs, 2, 1)
  planted['png-bytes-named-jpg'] = pickFrom(jpgs, 2, 2)
  planted['jpeg-bytes-named-png'] = pickFrom(pngs, 1, 0)
  planted['polyglot-image'] = pickFrom(jpgs, 3, 3)
  planted['oversize-30mb'] = pickFrom(jpgs, 1, 4)
  planted['polyglot-av'] = pickFrom(mp4s, 1, 0)
  // case mismatch: the file on disk has a different letter case from the export's address
  planted['case-mismatch'] = pickFrom(mixedCase, 2, 5)
  // Unicode mismatch: the file on disk is in the other normal form (NFC <-> NFD) than the export's address
  planted['unicode-mismatch'] = pickFrom(
    paths.filter((p) => attachmentSet.has(p) && p.normalize('NFC') !== p.normalize('NFD')),
    2,
    0,
  )

  const casePathOnDisk = (p: string) => {
    const i = p.lastIndexOf('/')
    return p.slice(0, i + 1) + p.slice(i + 1).toLowerCase()
  }
  const jobs: Job[] = []
  const bytesOf = (cat: string, p: string): Job | null => {
    if (cat === 'php-named-jpg') return { rel: p, type: cat, make: () => Buffer.concat([PHP, filler(p, seed, 400)]) }
    if (cat === 'zero-byte') return { rel: p, type: cat, make: () => Buffer.alloc(0) }
    if (cat === 'png-bytes-named-jpg') return { rel: p, type: cat, make: () => image('png', p, seed, 64, 48, 0) }
    if (cat === 'jpeg-bytes-named-png') return { rel: p, type: cat, make: () => image('jpg', p, seed, 64, 48, 0) }
    if (cat === 'polyglot-image') return { rel: p, type: cat, make: async () => Buffer.concat([await image('jpg', p, seed, 200, 150, 20), PHP]) }
    if (cat === 'oversize-30mb') return { rel: p, type: cat, make: async () => Buffer.concat([await image('jpg', p, seed, 64, 48, 0), Buffer.alloc(30 * 1024 * 1024)]) }
    if (cat === 'polyglot-av') return { rel: p, type: cat, make: () => Buffer.concat([avPlaceholder('mp4', p, seed), SCRIPT]) }
    return null
  }
  const plantedAt = new Map<string, string>()
  for (const [cat, list] of Object.entries(planted)) for (const p of list) plantedAt.set(p, cat)

  // 4. every other path gets a good file of its type
  const byType: Record<string, number> = {}
  for (const p of paths) {
    const cat = plantedAt.get(p)
    if (cat === 'case-mismatch') {
      const e = extOf(p)
      jobs.push({ rel: casePathOnDisk(p), type: cat, make: () => image(e === 'png' ? 'png' : e === 'webp' ? 'webp' : 'jpg', p, seed, 200, 150, 10) })
      continue
    }
    if (cat === 'unicode-mismatch') {
      const alt = p.normalize('NFC') === p ? p.normalize('NFD') : p.normalize('NFC')
      const e = extOf(p)
      jobs.push({ rel: alt, type: cat, make: () => image(e === 'png' ? 'png' : e === 'webp' ? 'webp' : 'jpg', p, seed, 200, 150, 10) })
      continue
    }
    const planned = cat ? bytesOf(cat, p) : null
    if (planned) {
      jobs.push(planned)
      continue
    }
    const e = extOf(p)
    if (e === 'jpg' || e === 'jpeg' || e === 'png' || e === 'webp') {
      const { w, h } = dims(p, seed)
      const kind = e === 'jpeg' ? 'jpg' : e
      // PNG carriers are kept small and smooth (noise makes a PNG huge); JPEG and WebP get light noise so the tree has a realistic size.
      jobs.push({ rel: p, type: e, make: () => image(kind as 'jpg' | 'png' | 'webp', p, seed, kind === 'png' ? Math.min(w, 480) : w, kind === 'png' ? Math.min(h, 320) : h, kind === 'png' ? 0 : 24) })
    } else if (AV_EXT.includes(e)) jobs.push({ rel: p, type: e, make: () => avPlaceholder(e, p, seed) })
    else if (e === 'gif') jobs.push({ rel: p, type: e, make: () => GIF })
    else if (e === 'pdf') jobs.push({ rel: p, type: e, make: () => PDF })
    else jobs.push({ rel: p, type: e || 'none', make: () => filler(p, seed, 2048) })
  }

  // 5. WordPress size variants for a share of the good images (never over an existing path)
  let variants = 0
  const existing = new Set(jobs.map((j) => j.rel.normalize('NFC').toLowerCase()))
  const pickR = mulberry(seedOf(seed, 'variants'))
  for (const p of paths) {
    const e = extOf(p)
    if (!['jpg', 'jpeg', 'png', 'webp'].includes(e) || plantedAt.has(p) || SIZE_RE.test(p)) continue
    if (pickR() * 100 >= variantPercent) continue
    const stem = p.slice(0, p.length - e.length - 1)
    for (const [w, h] of [[300, 200], [150, 150]] as const) {
      const rel = `${stem}-${w}x${h}.${e}`
      const k = rel.normalize('NFC').toLowerCase()
      if (existing.has(k)) continue
      existing.add(k)
      variants++
      jobs.push({ rel, type: 'variant', make: () => image(e === 'jpeg' ? 'jpg' : (e as 'jpg' | 'png' | 'webp'), rel, seed, w, h, 0) })
    }
  }

  // 6. extras: unreferenced files a real folder holds, and one placeholder per audio/video type
  const extras: string[] = []
  const extra = (rel: string, make: () => Buffer | Promise<Buffer>, type: string) => {
    extras.push(rel)
    jobs.push({ rel, make, type })
  }
  extra('index.php', () => Buffer.from('<?php\n// Silence is golden.\n'), 'extra-php')
  extra('2026/10/.htaccess', () => Buffer.from('Options -Indexes\n'), 'extra-hidden')
  extra('2026/10/.DS_Store', () => filler('ds', seed, 64), 'extra-hidden')
  for (const e of ['mp4', 'm4a', 'mp3', 'webm', 'ogg']) extra(`2026/10/synth-av-sample.${e}`, () => avPlaceholder(e, `x${e}`, seed), `extra-${e}`)
  extra('2026/10/synth-café-nfc.jpg'.normalize('NFC'), () => image('jpg', 'nfc', seed, 120, 90, 0), 'extra-unicode')
  extra('2026/10/synth-café-nfd.jpg'.normalize('NFD'), () => image('jpg', 'nfd', seed, 120, 90, 0), 'extra-unicode')

  // 7. write, a few at a time
  fs.mkdirSync(out, { recursive: true })
  const written = { files: 0, bytes: 0 }
  const counts: Record<string, number> = {}
  let next = 0
  const worker = async () => {
    for (;;) {
      const j = jobs[next++]
      if (!j) return
      const data = await j.make()
      const abs = path.join(out, ...j.rel.split('/'))
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, data)
      written.files++
      written.bytes += data.length
      counts[j.type] = (counts[j.type] ?? 0) + 1
      if (written.files % 1000 === 0) log(`${written.files} of ${jobs.length} files`)
    }
  }
  await Promise.all(Array.from({ length: opts.concurrency ?? 4 }, worker))
  for (const [t, n] of Object.entries(counts)) if (!t.startsWith('extra-') && t !== 'variant') byType[t] = n

  const notMedia = paths.filter((p) => attachmentSet.has(p) && !plantedAt.has(p) && !['jpg', 'jpeg', 'png', 'webp', 'gif', 'pdf', 'avif', ...AV_EXT].includes(extOf(p))).length
  const unsupported = paths.filter((p) => attachmentSet.has(p) && !plantedAt.has(p) && ['gif', 'pdf', 'avif'].includes(extOf(p))).length
  const n = (c: string) => planted[c]?.length ?? 0
  const manifest: SynthManifest = {
    seed,
    distinctAttachmentPaths: attachments.size,
    written,
    byType,
    variants,
    avFromBodies,
    extras: extras.length,
    skippedCollisions,
    planted: Object.fromEntries(Object.entries(planted).map(([k, v]) => [k, v.length])),
    expected: {
      rejectedUnsafe: n('php-named-jpg') + n('zero-byte') + n('png-bytes-named-jpg') + n('jpeg-bytes-named-png') + n('polyglot-av') + notMedia,
      notImportable: n('oversize-30mb') + unsupported,
      unicodeMismatch: n('unicode-mismatch'),
      caseMismatch: n('case-mismatch'),
      polyglotImageWarnings: n('polyglot-image'),
    },
    private: { planted, extras },
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 1)}\n`, { flag: 'wx' })
  return manifest
}
