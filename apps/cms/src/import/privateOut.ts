import fs from 'node:fs'
import path from 'node:path'

import { realish } from './safePaths'

/**
 * One way to create a PRIVATE output file (a detail file with real names or ids): never over an existing file,
 * never over an input, never inside a protected folder, owner-only where the platform supports it.
 *
 * `fs.openSync(path, 'w')` would truncate whatever is there, including the export that was given as input
 * (`--out export.xml`). Here the file is created with `wx` (fails when anything exists, also through a link), and
 * the real location of the target is compared with the inputs and protected folders first.
 */

export type PrivateOutCode = 'OUT_IS_INPUT' | 'OUT_INSIDE_DIR' | 'OUT_EXISTS' | 'OUT_FAILED'

export class PrivateOutError extends Error {
  constructor(readonly code: PrivateOutCode) {
    super(code)
    this.name = 'PrivateOutError'
  }
}

export type PrivateOutOptions = {
  /** Input files the output must not be (same real path, or the same file by device and inode, or a hard link to it). */
  inputs?: readonly string[]
  /** Folders the output must not be inside (compared by real path, also when the output does not exist yet). */
  notInside?: readonly string[]
}

const norm = (p: string): string => (process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p)

function sameFile(a: string, b: string): boolean {
  if (norm(realish(a)) === norm(realish(b))) return true
  try {
    const sa = fs.statSync(a)
    const sb = fs.statSync(b)
    return sa.ino !== 0 && sa.ino === sb.ino && sa.dev === sb.dev
  } catch {
    return false
  }
}

/** True when `target` (which may not exist yet) lies inside `dir` after resolving links and junctions. */
export function isInsideDir(target: string, dir: string): boolean {
  const rel = path.relative(norm(realish(dir)), norm(realish(target)))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** The refusal code for `out`, or null when it may be created. Does not touch the file system beyond reading. */
export function privateOutProblem(out: string, opts: PrivateOutOptions = {}): PrivateOutCode | null {
  const abs = path.resolve(out)
  for (const input of opts.inputs ?? []) if (sameFile(abs, path.resolve(input))) return 'OUT_IS_INPUT'
  for (const dir of opts.notInside ?? []) if (isInsideDir(abs, dir)) return 'OUT_INSIDE_DIR'
  try {
    fs.lstatSync(abs)
    return 'OUT_EXISTS'
  } catch {
    return null
  }
}

/** Create `out` (and its parent folders) exclusively with mode 0o600 and return the descriptor. Throws PrivateOutError. */
export function openPrivateOut(out: string, opts: PrivateOutOptions = {}): number {
  const problem = privateOutProblem(out, opts)
  if (problem) throw new PrivateOutError(problem)
  const abs = path.resolve(out)
  let fd: number
  try {
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fd = fs.openSync(abs, 'wx', 0o600)
  } catch (err) {
    throw new PrivateOutError((err as NodeJS.ErrnoException).code === 'EEXIST' ? 'OUT_EXISTS' : 'OUT_FAILED')
  }
  try {
    fs.fchmodSync(fd, 0o600)
  } catch {
    // Windows ignores POSIX modes; the exclusive create above is what matters there.
  }
  return fd
}

/** Create `out` exclusively, write `text`, close. */
export function writePrivateOut(out: string, text: string, opts: PrivateOutOptions = {}): void {
  const fd = openPrivateOut(out, opts)
  try {
    fs.writeSync(fd, text)
  } finally {
    fs.closeSync(fd)
  }
}
