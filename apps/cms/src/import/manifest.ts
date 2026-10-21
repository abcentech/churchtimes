import fs from 'node:fs'

/**
 * Rollback manifest: the ids a run created or updated, so a later rollback tool (or an operator with SQL) can undo
 * exactly this run. Ids only: no title, slug, address or text. Written OUTSIDE the repository, owner-only (0o600).
 *
 * The file is created exclusively (`wx`) at the START of a run, so an unwritable or already existing path stops the
 * import before anything is written to the database, and is filled in at the end (also after a failure).
 */

export type Manifest = {
  schema: 'churchtimes-import-manifest/1'
  startedAt: string
  finishedAt: string | null
  mode: 'apply'
  articles: { created: number[]; updated: number[] }
  categories: number[]
  media: number[]
  comments: number[]
  audits: number[]
}

export const newManifest = (): Manifest => ({
  schema: 'churchtimes-import-manifest/1',
  startedAt: new Date().toISOString(),
  finishedAt: null,
  mode: 'apply',
  articles: { created: [], updated: [] },
  categories: [],
  media: [],
  comments: [],
  audits: [],
})

export type ManifestSink = { write: (m: Manifest) => void; close: () => void }

/** Create the file (mode 0o600, must not exist). Throws when it cannot be created. */
export function openManifest(filePath: string): ManifestSink {
  const fd = fs.openSync(filePath, 'wx', 0o600)
  try {
    fs.chmodSync(filePath, 0o600)
  } catch {
    // Windows ignores POSIX modes; the exclusive create above is what matters there.
  }
  let closed = false
  return {
    write(m) {
      if (closed) return
      fs.ftruncateSync(fd, 0)
      fs.writeSync(fd, JSON.stringify(m, null, 2), 0)
      fs.fsyncSync(fd)
    },
    close() {
      if (closed) return
      closed = true
      fs.closeSync(fd)
    },
  }
}
