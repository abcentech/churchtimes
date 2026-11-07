import path from 'node:path'

type PathModule = Pick<typeof path, 'relative' | 'isAbsolute' | 'sep'>

/**
 * True when `child` is `parent` or lies inside it. Pure path logic: callers resolve symlinks first (`fs.realpathSync`) so a
 * link or a different spelling cannot point into the directory unnoticed. `path.win32` compares case-insensitively, which is
 * what a Windows file system does, so `C:\Repo\x` and `c:\repo\X` are the same place there.
 */
export function isPathInside(child: string, parent: string, mod: PathModule = path): boolean {
  const rel = mod.relative(parent, child)
  if (rel === '') return true
  if (mod.isAbsolute(rel)) return false // different drive or root
  return !(rel === '..' || rel.startsWith(`..${mod.sep}`))
}
