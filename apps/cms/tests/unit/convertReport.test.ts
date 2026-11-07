import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { runConvertReport } from '../../src/import/convertReport'
import { buildCorpus } from '../fixtures/html/corpus'

let dir: string
let detailDir: string

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'convert-in-'))
  detailDir = await mkdtemp(path.join(tmpdir(), 'convert-out-'))
  for (const a of buildCorpus(6)) await writeFile(path.join(dir, `${a.id}.html`), a.html)
  await writeFile(path.join(dir, 'with-losses.html'), '<p>x [contact-form-7 id="1"] <a href="https://old.example.test/some-post/">l</a></p><script>x</script><hr><iframe src="https://social.example.test/p/1"></iframe>')
  await writeFile(path.join(dir, 'too-deep.html'), '<div>'.repeat(5000))
  await writeFile(path.join(dir, 'ignored.txt'), 'not html')
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
  await rm(detailDir, { recursive: true, force: true })
})

const run = async (argv: string[]) => {
  const out: string[] = []
  const err: string[] = []
  const code = await runConvertReport(argv, { out: (l) => out.push(l), err: (l) => err.push(l) })
  return { code, out, err }
}

describe('import:convert (convert-only QA report)', () => {
  it('requires --in', async () => {
    const r = await run([])
    expect(r.code).toBe(2)
    expect(r.err.join('\n')).toMatch(/Usage/)
  })

  it('prints counts only and reports failures with a non-zero exit code', async () => {
    const r = await run(['--in', dir, '--old-host', 'old.example.test'])
    expect(r.code).toBe(1)
    const text = r.out.join('\n')
    expect(text).toContain('files: 8')
    expect(text).toContain('converted: 7')
    expect(text).toContain('failed.too-deep: 1')
    expect(text).toMatch(/shortcodeRemoved\.contact-form-7: [1-9]/)
    expect(text).toContain('droppedElement.script: 1')
    expect(text).toContain('horizontalRulesDropped: 1')
    expect(text).toContain('embeds.linked: 1')
    expect(text).toContain('links.unmapped: 1')
    expect(text).toMatch(/images\.unresolved: [1-9]/)
    // no address, file name or content in the printed summary
    expect(text).not.toMatch(/example\.test|\.html|synthetic-/)
  })

  it('--assume-images counts every image as resolved', async () => {
    const r = await run(['--in', dir, '--assume-images'])
    expect(r.out.join('\n')).not.toMatch(/images\.unresolved/)
    expect(r.out.join('\n')).toMatch(/images\.resolved: [1-9]/)
  })

  it('writes details only to a file outside the repository', async () => {
    const inside = await run(['--in', dir, '--detail-file', path.join(process.cwd(), 'details.json')])
    expect(inside.code).toBe(2)
    const file = path.join(detailDir, 'details.json')
    const ok = await run(['--in', dir, '--detail-file', file])
    expect(ok.code).toBe(1)
    const details = JSON.parse(await readFile(file, 'utf8'))
    expect(Object.keys(details)).toContain('with-losses.html')
    expect(details['too-deep.html'].failed).toBe('too-deep')
  })

  it('an unreadable folder is a usage error', async () => {
    expect((await run(['--in', path.join(dir, 'missing')])).code).toBe(2)
  })
})
