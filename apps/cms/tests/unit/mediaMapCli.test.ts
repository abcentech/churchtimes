import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { isInsideRepoReal, runMediaMapExport, writeMapAtomically } from '../../src/lib/mediaMapCli'

const tmp = mkdtempSync(path.join(tmpdir(), 'ct-mediamap-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))
const log = () => {
  const lines: string[] = []
  return { lines, out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) }
}

describe('export:media-map CLI guards', () => {
  it('refuses a path inside the repository before touching the database', async () => {
    const l = log()
    const code = await runMediaMapExport(undefined as never, ['--out', path.join(process.cwd(), 'map.json')], l)
    expect(code).toBe(2)
    expect(existsSync(path.join(process.cwd(), 'map.json'))).toBe(false)
  })
  it('refuses a bare --out and a --detail-file inside the repository', async () => {
    expect(await runMediaMapExport(undefined as never, ['--out'], log())).toBe(2)
    expect(await runMediaMapExport(undefined as never, ['--detail-file', path.join(process.cwd(), 'd.txt')], log())).toBe(2)
  })
})

describe('isInsideRepoReal', () => {
  it('allows a plain outside path and refuses a path reached through a symlink or junction into the repo', () => {
    expect(isInsideRepoReal(path.join(tmp, 'ok', 'map.json'))).toBe(false)
    const link = path.join(tmp, 'link')
    symlinkSync(process.cwd(), link, 'junction')
    expect(isInsideRepoReal(path.join(link, 'sub', 'map.json'))).toBe(true)
    expect(isInsideRepoReal(path.join(link, 'map.json'))).toBe(true)
  })
})

describe('writeMapAtomically', () => {
  it('writes the file, leaves no temp file, and replaces an existing one', async () => {
    const file = path.join(tmp, 'sub', 'map.json')
    await writeMapAtomically(file, 'one')
    await writeMapAtomically(file, 'two')
    expect(readFileSync(file, 'utf8')).toBe('two')
    expect(readdirSync(path.dirname(file))).toEqual(['map.json'])
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
  })
  it('removes the temp file when the rename fails', async () => {
    const dir = path.join(tmp, 'fail')
    mkdirSync(path.join(dir, 'map.json'), { recursive: true }) // a directory in the way: rename cannot replace it
    await expect(writeMapAtomically(path.join(dir, 'map.json'), 'x')).rejects.toBeDefined()
    expect(readdirSync(dir)).toEqual(['map.json'])
  })
})
