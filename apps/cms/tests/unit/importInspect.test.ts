import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { inspectWxr, maxHtmlDepth, runInspectCli } from '../../src/import/inspect'
import { readWxrFile } from '../../src/import/wxr'
import { wxr, type FixtureItem } from '../fixtures/wxr/generate'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wxr-inspect-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

const run = async (args: string[]) => {
  const out: string[] = []
  const err: string[] = []
  const code = await runInspectCli(args, { out: (l) => out.push(l), err: (l) => err.push(l) })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

const SECRETS = ['Secret Headline', 'secret-slug', 'Hidden Category', 'writer_one', 'Writer Person', 'secret@example.test', 'Commenter Name']
const items: FixtureItem[] = [
  {
    id: 1,
    title: 'Secret Headline',
    slug: 'secret-slug',
    creator: 'writer_one',
    categories: [{ nicename: 'hidden', name: 'Hidden Category' }, { nicename: 'b', name: 'B' }],
    content: '<div><p>x <b>y</b></p></div>[gallery ids="1"] [caption]c[/caption] [gallery]',
    comments: [{ id: 11, author: 'Commenter Name' }, { id: 12, approved: 'spam' }, { id: 13, approved: '0' }],
  },
  { id: 2, creator: 'Writer_One', categories: [{ nicename: 'b', name: 'B' }], content: '<p>short</p>' },
  { id: 3, creator: 'someone_else', status: 'draft' },
  { id: 4, password: 'pw' },
  { id: 5, postType: 'attachment', status: 'inherit', attachmentUrl: 'https://old.example.test/a.png' },
]

describe('import:inspect', () => {
  it('counts the synthetic export', async () => {
    const file = path.join(dir, 'a.xml')
    fs.writeFileSync(file, wxr(items))
    const r = await inspectWxr(readWxrFile(file))
    expect(r.postsByStatus).toMatchObject({ publish: 3, draft: 1 })
    expect(r.publishedPasswordProtected).toBe(1)
    expect(r.distinctAuthors).toBe(3) // writer_one (case-folded), someone_else, editor_one (default creator)
    expect(r.categories).toMatchObject({ distinctUsedByPosts: 2, postsWithMoreThanOne: 1 })
    expect(r.commentsByStatus).toMatchObject({ approved: 1, spam: 1, pending: 1, trash: 0 })
    expect(r.attachments).toBe(1)
    expect(r.shortcodeTags).toEqual([['gallery', 2], ['caption', 2]].sort((a, b) => (b[1] as number) - (a[1] as number) || ((a[0] as string) < (b[0] as string) ? -1 : 1)))
    expect(r.largestPost.bytes).toBeGreaterThan(40)
    expect(r.maxHtmlNestingDepth).toBe(3)
  })

  it('prints counts only: no title, slug, name, email or category name', async () => {
    const file = path.join(dir, 'b.xml')
    fs.writeFileSync(file, wxr(items, { authors: [{ id: 2, login: 'writer_one', display: 'Writer Person' }] }))
    const { code, out, err } = await run(['--file', file])
    expect(code).toBe(0)
    expect(err).toBe('')
    expect(out).toContain('distinct authors: 3')
    for (const s of SECRETS) expect(out).not.toContain(s)
    expect(out).not.toContain('old.example.test')
  })

  it('refuses a missing flag, a file inside a repository, and an unreadable file', async () => {
    expect((await run([])).err).toBe('INSPECT_USAGE')
    expect((await run(['--file'])).code).toBe(2)
    expect((await run(['--file', path.join(process.cwd(), 'package.json')])).err).toBe('INSPECT_FILE_INSIDE_REPO')
    const res = await run(['--file', path.join(dir, 'nope.xml')])
    expect(res.code).toBe(1)
    expect(res.out).toBe('')
  })

  it('measures HTML nesting depth leniently', () => {
    expect(maxHtmlDepth('')).toBe(0)
    expect(maxHtmlDepth('<p>a<br>b<img src=x/></p>')).toBe(1)
    expect(maxHtmlDepth('<blockquote><ul><li><a>x</a></li></ul></blockquote><!-- <div><div> -->')).toBe(4)
    expect(maxHtmlDepth('</div></div><p>x</p>')).toBe(1)
  })
})
