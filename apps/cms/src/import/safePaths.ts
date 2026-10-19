import fs from 'node:fs'
import path from 'node:path'

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

/** UNC (`\\host\share`, `//host/share`) and device (`\\?\`, `\\.\`) paths: refused on every platform. */
const NETWORK_OR_DEVICE_RE = /^[\\/]{2}/

/**
 * True when `target` must not be used for private data: a UNC or device path (its real location cannot be judged,
 * for example `\\localhost\c$\repo` is the local repo), or any path that has an existing ancestor containing `.git`
 * (a checkout of this or any other repository, resolved through symlinks and junctions). Private data (the export,
 * detail files) must never live in a repository.
 */
export function isInsideRepo(target: string, _cwd: string = process.cwd()): boolean {
  if (NETWORK_OR_DEVICE_RE.test(target)) return true
  let dir = realish(path.resolve(_cwd, target))
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return true
    const parent = path.dirname(dir)
    if (parent === dir) return false
    dir = parent
  }
}
