import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { readManifest } from '../../src/import/manifest'
import { runRollback } from '../../src/import/rollback'
import { IMAGE_DIR, imageName, largeWxr } from '../fixtures/wxr/large'
import { newRunId, setupFixtures, type Fixtures } from './helpers'

/**
 * The REAL command (`payload run src/seed/importWxr.ts`, what `npm run import:wxr` runs) in its own process, stopped
 * part-way through a large synthetic import.
 *
 * - POSIX: a real SIGINT. The CLI finishes the post in flight, writes the manifest `end` line (status `stopped`) and exits 1.
 * - Windows: Node cannot deliver SIGINT to another process (`process.kill(pid, 'SIGINT')` terminates it at once, no handler
 *   runs) and a console Ctrl+C event cannot be sent to a detached child without a native addon. So here the process is
 *   killed hard, which is the worse case: the manifest has no `end` line and may end in a torn line. Both ways the
 *   manifest must stay readable and `import:rollback --allow-incomplete` must remove what the run wrote.
 */
const runId = newRunId()
const cmsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const idBase = 9_500_000 + (parseInt(runId.slice(1, 5), 16) % 3_000) * 1_000
let f: Fixtures
let dir: string

beforeAll(async () => {
  f = await setupFixtures(runId)
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-signal-int-'))
})

afterAll(async () => {
  // Leftovers of a failed run (rows are removed by `import:rollback` in the test itself).
  await f?.cleanup()
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
})

const countCommits = (file: string): number => {
  try {
    return (fs.readFileSync(file, 'utf8').match(/"type":"commit"/g) ?? []).length
  } catch {
    return 0
  }
}

describe('import process interrupted mid-run', () => {
  it('leaves a readable manifest and can be rolled back', async () => {
    const uploads = path.join(dir, 'uploads')
    fs.mkdirSync(path.join(uploads, ...IMAGE_DIR.split('/')), { recursive: true })
    for (let n = 0; n < 5; n++) {
      const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: n * 40, g: 60, b: 90 } } }).png().toBuffer()
      fs.writeFileSync(path.join(uploads, ...IMAGE_DIR.split('/'), imageName(n)), png)
    }
    const gen = largeWxr({ posts: 400, images: 5, idBase, prefix: runId })
    const exportFile = path.join(dir, 'export.xml')
    const manifestPath = path.join(dir, 'manifest.jsonl')
    fs.writeFileSync(exportFile, gen.xml)

    const args = [path.join(cmsRoot, 'node_modules', 'payload', 'bin.js'), 'run', 'src/seed/importWxr.ts', '--', '--file', exportFile, '--uploads', uploads, '--manifest', manifestPath, '--apply']
    const child = spawn(process.execPath, args, { cwd: cmsRoot, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))

    // Wait until the run is demonstrably in the middle: some posts committed, many to go.
    const started = Date.now()
    while (countCommits(manifestPath) < 15) {
      if (child.exitCode !== null) throw new Error(`the import ended before it could be interrupted (exit ${child.exitCode}): ${out.slice(-600)}`)
      if (Date.now() - started > 240_000) {
        child.kill('SIGKILL')
        throw new Error('the import did not start in time')
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    const posix = process.platform !== 'win32'
    child.kill(posix ? 'SIGINT' : 'SIGKILL')
    const ended = await Promise.race([exit, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('the process did not stop')), 120_000))])

    const m = readManifest(manifestPath)
    expect(m.started).toBe(true)
    expect(m.articles.created.length).toBeGreaterThanOrEqual(15)
    expect(m.articles.created.length).toBeLessThan(gen.expected.importablePosts)
    expect(fs.readFileSync(manifestPath, 'utf8')).not.toMatch(/example\.test|Synthetic|story/)
    if (posix) {
      expect(ended.code).toBe(1)
      expect(m).toMatchObject({ complete: true, endStatus: 'stopped', openIntents: [] })
      expect(out).toContain('stopped-early-by-signal')
    } else {
      expect(m.complete).toBe(false)
      expect(ended.code === null || ended.code !== 0).toBe(true)
    }

    // Whatever was committed is in the database; rollback (incomplete manifests need the flag on Windows) removes it.
    const inDb = async () => (await f.payload.count({ collection: 'articles', where: { legacyId: { greater_than_equal: idBase, less_than: idBase + 1_000_000 } }, overrideAccess: true })).totalDocs
    expect(await inDb()).toBeGreaterThanOrEqual(15)
    await expect(runRollback(f.payload, { manifestPath, apply: true, allowIncomplete: !m.complete })).resolves.toMatchObject({ mode: 'apply' })
    expect(await inDb()).toBe(0)
    const again = await runRollback(f.payload, { manifestPath, apply: true, allowIncomplete: !m.complete })
    expect(again.articles.deleted + again.comments.deleted + again.media.deleted + again.categories.deleted).toBe(0)
  }, 600_000)
})
