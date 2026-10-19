import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** Walk up from `start` looking for a `.git` entry (a directory, or a file in a worktree). */
function repoRootOf(start: string): string | undefined {
  let dir = start
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** Real path of the nearest existing ancestor plus the not-yet-existing remainder (defeats symlinks and junctions). */
function realish(p: string): string {
  const abs = path.resolve(p)
  const rest: string[] = []
  let cur = abs
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...rest.reverse())
    } catch {
      const parent = path.dirname(cur)
      if (parent === cur) return abs
      rest.push(path.basename(cur))
      cur = parent
    }
  }
}

const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p)

/**
 * True when `target` is inside a git checkout: the one that contains the current directory or the one that contains
 * this code. Private data (the export, detail files) must never live in a repository.
 */
export function isInsideRepo(target: string, cwd: string = process.cwd()): boolean {
  const t = norm(realish(target))
  const roots = [repoRootOf(realish(cwd)), repoRootOf(path.dirname(fileURLToPath(import.meta.url)))]
  return roots.some((root) => {
    if (!root) return false
    const r = norm(realish(root))
    return t === r || t.startsWith(r + path.sep)
  })
}
