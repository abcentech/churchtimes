import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { runMediaMapExport, writeMapAtomically } from '../../src/lib/mediaMapCli'

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
  it('refuses a bare --out', async () => {
    expect(await runMediaMapExport(undefined as never, ['--out'], log())).toBe(2)
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
})
