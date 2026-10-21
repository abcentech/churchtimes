import fs from 'node:fs'
import path from 'node:path'

import type { Payload, PayloadRequest } from 'payload'

import { candidatePaths, legacyPathFromUrl, resolveAlt } from '../lib/legacyMediaPath'
import { isNetworkOrDevicePath } from './safePaths'

/**
 * Legacy upload resolution for the loader (go-live contract C1.2).
 *
 * A WordPress image address (or `_wp_attached_file` value) is reduced to a path under `wp-content/uploads`
 * (`2023/10/photo.jpg`), which is looked up in `media.legacyPath` (exact path first, then without a `-300x200` size
 * suffix, see `candidatePaths`). When there is no media document yet and an uploads folder was given, the file is read
 * from that folder and uploaded through the Local API, which runs the Media collection's own checks (magic bytes,
 * MIME allowlist, alt text). Files are never read outside the uploads root: UNC and device paths, drive letters,
 * `..` segments, NUL and control characters, backslashes and alternate data streams are refused, and the real path
 * (symlinks and junctions resolved) must stay inside the real uploads root.
 *
 * A missing, refused or unreadable image is reported by reason code and never stops the import. Reports hold counts
 * and reason codes only, never a path or file name.
 */

export const MEDIA_MAX_BYTES = 25 * 1024 * 1024

export type ConfineFailure = 'bad-path' | 'outside-root' | 'missing-file' | 'not-a-file' | 'too-large' | 'no-uploads-root'
export type ConfineResult = { ok: true; file: string } | { ok: false; reason: ConfineFailure }

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/

/** True when `rel` is a plain relative path of safe segments (no drive, device, UNC, traversal or stream syntax). */
export function isSafeRelativeUploadPath(rel: unknown): rel is string {
  if (typeof rel !== 'string' || rel === '' || rel.length > 500) return false
  if (isNetworkOrDevicePath(rel) || CONTROL_RE.test(rel)) return false
  if (rel.startsWith('/') || rel.includes('\\') || rel.includes(':')) return false
  const segments = rel.split('/')
  return segments.every((s) => s !== '' && s !== '.' && s !== '..')
}

/** Resolve `rel` inside `uploadsRoot` or say why not. Never throws. */
export function confineUploadPath(uploadsRoot: string | undefined, rel: string): ConfineResult {
  if (!uploadsRoot) return { ok: false, reason: 'no-uploads-root' }
  if (!isSafeRelativeUploadPath(rel)) return { ok: false, reason: 'bad-path' }
  let rootReal: string
  try {
    rootReal = fs.realpathSync.native(uploadsRoot)
  } catch {
    return { ok: false, reason: 'no-uploads-root' }
  }
  const candidate = path.join(rootReal, ...rel.split('/'))
  let real: string
  try {
    real = fs.realpathSync.native(candidate)
  } catch {
    return { ok: false, reason: 'missing-file' }
  }
  const relative = path.relative(rootReal, real)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return { ok: false, reason: 'outside-root' }
  try {
    const st = fs.statSync(real)
    if (!st.isFile()) return { ok: false, reason: 'not-a-file' }
    if (st.size > MEDIA_MAX_BYTES) return { ok: false, reason: 'too-large' }
  } catch {
    return { ok: false, reason: 'missing-file' }
  }
  return { ok: true, file: real }
}

export type MediaOutcome = { ok: true; mediaId: number; created: boolean } | { ok: false; reason: string }

export type MediaStats = {
  /** Media documents that already existed (matched by legacyPath). */
  reused: number
  /** Media documents created (or, in a dry run, that would be created). */
  created: number
  /** Unresolved by reason code. */
  unresolved: Record<string, number>
}

export type MediaResolverOptions = {
  payload: Payload
  req: PayloadRequest
  /** Folder that holds the copied `wp-content/uploads` tree. Without it only existing media can be matched. */
  uploadsRoot?: string
  /** Host names of the old site. An absolute address on any other host is not an upload of the old site. */
  oldHosts: readonly string[]
  dryRun: boolean
  /** Called with the id of every media document created. */
  onCreated?: (id: number) => void
}

export type MediaResolver = {
  /** An image address from article HTML. */
  resolveUrl: (src: string, ctx: { alt?: string; caption?: string; articleTitle?: string }) => Promise<MediaOutcome>
  /** A path under the uploads folder (`2023/10/photo.jpg`), for example `_wp_attached_file`. */
  resolvePath: (legacyPath: string, ctx: { alt?: string; caption?: string; articleTitle?: string }) => Promise<MediaOutcome>
  stats: MediaStats
  /** Use this request (and its transaction) for the following calls. */
  setReq: (req: PayloadRequest) => void
  /** Forget what was resolved (after a rolled-back transaction, whose media rows no longer exist). */
  reset: () => void
}

const bump = (rec: Record<string, number>, key: string) => {
  rec[key] = (rec[key] ?? 0) + 1
}

/** Host of an absolute or protocol-relative address, or null for a relative one. */
function hostOf(src: string): string | null {
  try {
    const u = new URL(src, 'http://relative.invalid')
    return u.hostname === 'relative.invalid' ? null : u.hostname.toLowerCase()
  } catch {
    return null
  }
}

export function createMediaResolver(opts: MediaResolverOptions): MediaResolver {
  const stats: MediaStats = { reused: 0, created: 0, unresolved: {} }
  const hosts = new Set(opts.oldHosts.map((h) => h.toLowerCase()))
  const cache = new Map<string, MediaOutcome>()
  let req = opts.req

  const fail = (reason: string): MediaOutcome => {
    bump(stats.unresolved, reason)
    return { ok: false, reason }
  }

  async function findExisting(legacyPath: string): Promise<number | null> {
    const found = await opts.payload.find({
      collection: 'media',
      where: { legacyPath: { equals: legacyPath } },
      limit: 1,
      depth: 0,
      pagination: false,
      overrideAccess: true,
      req: req,
    })
    const id = (found.docs[0] as { id?: number } | undefined)?.id
    return typeof id === 'number' ? id : null
  }

  async function resolveOne(legacyPath: string, ctx: { alt?: string; caption?: string; articleTitle?: string }): Promise<MediaOutcome> {
    const candidates = candidatePaths(legacyPath)
    for (const candidate of candidates) {
      const id = await findExisting(candidate)
      if (id !== null) {
        stats.reused++
        return { ok: true, mediaId: id, created: false }
      }
    }
    let lastFailure: ConfineFailure = 'missing-file'
    for (const candidate of candidates) {
      const confined = confineUploadPath(opts.uploadsRoot, candidate)
      if (!confined.ok) {
        // A refused path is more telling than a missing one: keep the first refusal.
        if (confined.reason !== 'missing-file') lastFailure = confined.reason
        continue
      }
      if (opts.dryRun) {
        stats.created++
        // A placeholder (never written): 1 and not 0, so the converter treats it as a resolved image exactly as in a real run.
        return { ok: true, mediaId: 1, created: true }
      }
      try {
        const doc = (await opts.payload.create({
          collection: 'media',
          data: {
            alt: resolveAlt({ alt: ctx.alt, caption: ctx.caption, articleTitle: ctx.articleTitle }).alt,
            ...(ctx.caption ? { caption: ctx.caption.slice(0, 500) } : {}),
            legacyPath: candidate,
          } as never,
          filePath: confined.file,
          overrideAccess: true,
          req: req,
        })) as { id: number }
        stats.created++
        opts.onCreated?.(doc.id)
        return { ok: true, mediaId: doc.id, created: true }
      } catch {
        // The Media validators refuse a corrupt or unsupported image; the message could carry a file name, so only a code is kept.
        return fail('rejected-by-media-rules')
      }
    }
    return fail(lastFailure)
  }

  const run = async (legacyPath: string, ctx: { alt?: string; caption?: string; articleTitle?: string }): Promise<MediaOutcome> => {
    const hit = cache.get(legacyPath)
    if (hit) return hit
    const outcome = await resolveOne(legacyPath, ctx)
    cache.set(legacyPath, outcome)
    return outcome
  }

  return {
    stats,
    setReq: (r) => {
      req = r
    },
    reset: () => cache.clear(),
    resolvePath: async (legacyPath, ctx) => {
      if (!isSafeRelativeUploadPath(legacyPath)) return fail('bad-path')
      return run(legacyPath, ctx)
    },
    resolveUrl: async (src, ctx) => {
      const host = hostOf(src)
      if (host !== null && !hosts.has(host)) return fail('external-host')
      const legacyPath = legacyPathFromUrl(src)
      if (legacyPath === null) return fail(src.toLowerCase().includes('wp-content/uploads') ? 'bad-path' : 'not-an-upload')
      return run(legacyPath, ctx)
    },
  }
}
