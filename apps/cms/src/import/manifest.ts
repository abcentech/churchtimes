import fs from 'node:fs'

/**
 * Rollback manifest: an append-only JSON Lines file of the ids a run created or updated, so a rollback tool (or an
 * operator with SQL) can undo exactly this run. Ids only: no title, slug, address or text. Written OUTSIDE the
 * repository, owner-only (0o600).
 *
 * Crash safety: the file is created exclusively (`wx`) before anything is written to the database, and every record is
 * appended and fsynced the moment it is known (an `intent` line before a post is touched, an `id` line right after each
 * row is created, a `commit` or `abort` line when the post's transaction ends). A kill therefore loses at most the
 * line being written; `readManifest` ignores such a torn last line. An id logged inside a transaction that never
 * committed simply does not exist in the database (rolling back a missing id is harmless; ids are never reused).
 */

export type ManifestCollection = 'articles' | 'categories' | 'media' | 'legacy-comments' | 'audit-logs'

export type ManifestRecord =
  | { type: 'start'; schema: 'churchtimes-import-manifest/2'; at: string }
  | { type: 'intent'; legacyId: number }
  | { type: 'id'; collection: ManifestCollection; action: 'created' | 'updated'; id: number }
  | { type: 'commit'; legacyId: number }
  | { type: 'abort'; legacyId: number }
  | { type: 'end'; at: string; status: 'complete' | 'failed' | 'stopped' }

export type ManifestSink = {
  append: (record: ManifestRecord) => void
  id: (collection: ManifestCollection, action: 'created' | 'updated', id: number) => void
  close: () => void
}

/** Create the file (mode 0o600, must not exist). Throws when it cannot be created. */
export function openManifest(filePath: string): ManifestSink {
  const fd = fs.openSync(filePath, 'wx', 0o600)
  try {
    fs.chmodSync(filePath, 0o600)
  } catch {
    // Windows ignores POSIX modes; the exclusive create above is what matters there.
  }
  let closed = false
  const append = (record: ManifestRecord) => {
    if (closed) return
    fs.writeSync(fd, JSON.stringify(record) + '\n')
    fs.fsyncSync(fd)
  }
  append({ type: 'start', schema: 'churchtimes-import-manifest/2', at: new Date().toISOString() })
  return {
    append,
    id: (collection, action, id) => append({ type: 'id', collection, action, id }),
    close() {
      if (closed) return
      closed = true
      fs.closeSync(fd)
    },
  }
}

export type ManifestSummary = {
  /** A `start` line was read (a file that is not a manifest has none). */
  started: boolean
  startedAt: string | null
  /** Time of the `end` line, when there is one. */
  endAt: string | null
  complete: boolean
  endStatus: string | null
  articles: { created: number[]; updated: number[] }
  categories: number[]
  media: number[]
  comments: number[]
  audits: number[]
  /** Legacy ids with an `intent` but neither `commit` nor `abort` (the post being written when the run died). */
  openIntents: number[]
  aborted: number[]
}

/** Read a manifest, ignoring a torn last line. Never throws on a malformed line. */
export function readManifest(filePath: string): ManifestSummary {
  const out: ManifestSummary = {
    started: false,
    startedAt: null,
    endAt: null,
    complete: false,
    endStatus: null,
    articles: { created: [], updated: [] },
    categories: [],
    media: [],
    comments: [],
    audits: [],
    openIntents: [],
    aborted: [],
  }
  const open = new Set<number>()
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let r: ManifestRecord
    try {
      r = JSON.parse(line) as ManifestRecord
    } catch {
      continue
    }
    if (r.type === 'start') {
      out.started = true
      out.startedAt = typeof r.at === 'string' ? r.at : null
    } else if (r.type === 'intent') open.add(r.legacyId)
    else if (r.type === 'commit') open.delete(r.legacyId)
    else if (r.type === 'abort') {
      open.delete(r.legacyId)
      out.aborted.push(r.legacyId)
    } else if (r.type === 'end') {
      out.complete = true
      out.endStatus = r.status
      out.endAt = typeof r.at === 'string' ? r.at : null
    } else if (r.type === 'id') {
      if (r.collection === 'articles') (r.action === 'created' ? out.articles.created : out.articles.updated).push(r.id)
      else if (r.collection === 'categories') out.categories.push(r.id)
      else if (r.collection === 'media') out.media.push(r.id)
      else if (r.collection === 'legacy-comments') out.comments.push(r.id)
      else if (r.collection === 'audit-logs') out.audits.push(r.id)
    }
  }
  out.openIntents = [...open]
  return out
}
