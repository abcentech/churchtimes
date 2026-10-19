import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { isInsideRepo } from '../../src/import/safePaths'
import { runWxrReportCli } from '../../src/import/wxrReport'
import { BILLION_LAUGHS, wxr, type FixtureItem } from '../fixtures/wxr/generate'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wxr-report-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

const run = async (args: string[]) => {
  const out: string[] = []
  const err: string[] = []
  const code = await runWxrReportCli(args, { out: (l) => out.push(l), err: (l) => err.push(l) })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

const SECRETS = [
  'Secret Headline',
  'secret-slug',
  'secret@example.test',
  'https://secret.example.test',
  'old.example.test',
  'Commenter One',
  'editor_one',
  'Hidden Category',
]

const list: FixtureItem[] = [
  {
    id: 1,
    title: 'Secret Headline',
    slug: 'secret-slug',
    link: 'https://secret.example.test/secret-slug/',
    categories: [
      { nicename: 'hidden', name: 'Hidden Category' },
      { nicename: 'b', name: 'B' },
    ],
    content:
      '<!-- wp:paragraph --><p>Hi [gallery ids="1,2"] [caption id="x"]<iframe src="https://www.youtube.com/embed/abcdefghijk"></iframe>' +
      '<iframe src="https://maps.example.test/secret-path"></iframe><table></table><img src="a"><img src="b"> [contact-form-7 id=3]</p><!-- /wp:paragraph -->',
    meta: { rank_math_title: '%title% | %sitename%', rank_math_description: 'Plain', _yoast_wpseo_title: 'Y' },
    comments: [{ id: 1, email: 'secret@example.test' }, { id: 2, approved: 'spam' }, { id: 3, type: 'pingback' }],
  },
  { id: 2, slug: 'dup', content: '<p>classic</p>' },
  { id: 3, slug: 'dup' },
  { id: 4, slug: '', dateGmt: '0000-00-00 00:00:00' },
  { id: 5, status: 'draft', slug: 'd' },
  { id: 6, status: 'trash', slug: 't' },
  {
    id: 7,
    postType: 'attachment',
    status: 'inherit',
    meta: { _wp_attachment_image_alt: 'x' },
    attachmentUrl: 'https://old.example.test/a.jpg',
  },
  { id: 8, postType: 'page', slug: 'about' },
  { id: 9, password: 'pw', slug: 'locked' },
]

describe('wxr report (counts only)', () => {
  const file = path.join(dir, 'export.xml')
  fs.writeFileSync(file, wxr(list))

  it('prints the expected counts and nothing identifying', async () => {
    const r = await run(['--file', file])
    expect(r.code).toBe(0)
    expect(r.err).toBe('')
    expect(r.out).toContain('items: 9 | channel categories: 1 | channel authors: 1')
    expect(r.out).toContain('published posts: 5 (owner expects 4346; difference -4341)')
    expect(r.out).toContain('published without slug: 1')
    expect(r.out).toContain('published duplicate-slug groups: 1')
    expect(r.out).toContain('published password-protected: 1')
    expect(r.out).toContain('published with GMT date missing: 1 (of which local-time fallback: 1)')
    expect(r.out).toMatch(/draft: 1/)
    expect(r.out).toMatch(/trash: 1/)
    expect(r.out).toContain('published posts with shortcode-like tags: 1')
    expect(r.out).toMatch(/gallery: 1/)
    expect(r.out).toMatch(/contact-form-7: 1/)
    expect(r.out).toContain('published posts with iframes: 1')
    expect(r.out).toMatch(/www\.youtube\.com: 1/)
    expect(r.out).toMatch(/maps\.example\.test: 1/)
    expect(r.out).not.toContain('secret-path')
    expect(r.out).toContain('published posts with <table>: 1 (1 tables)')
    expect(r.out).toContain('published posts with <img>: 1 (2 images)')
    expect(r.out).toContain('Gutenberg blocks 1, classic 4')
    expect(r.out).toContain('YouTube references: 1')
    expect(r.out).toContain('comments: 3; approved comments on published posts: 1')
    expect(r.out).toContain('approved=spam type=comment: 1')
    expect(r.out).toContain('attachments: 1 (url 1, alt text 1, attached file 0)')
    expect(r.out).toContain('Rank Math title present: 1 (with %variables%: 1); description present: 1 (with %variables%: 0)')
    for (const s of SECRETS) expect(r.out).not.toContain(s)
    expect(r.out).not.toMatch(/https?:\/\//)
    expect(r.out).not.toMatch(/@/)
  })

  it('writes per-item rows only to a detail file outside the repo, never overwriting', async () => {
    const detail = path.join(dir, 'detail.jsonl')
    const r = await run(['--file', file, '--detail-file', detail])
    expect(r.code).toBe(0)
    for (const s of SECRETS) expect(r.out).not.toContain(s)
    const text = fs.readFileSync(detail, 'utf8')
    const rows = text.trim().split('\n').map((l) => JSON.parse(l))
    expect(rows).toHaveLength(9)
    expect(rows[0]).toMatchObject({ wpId: 1, slug: 'secret-slug', title: 'Secret Headline' })
    expect(text).not.toContain('secret@example.test')
    expect((await run(['--file', file, '--detail-file', detail])).err).toBe('REPORT_DETAIL_EXISTS')
  })

  it('refuses a detail file or an input file inside the repository', async () => {
    const inside = path.resolve(process.cwd(), 'wxr-detail-should-not-exist.jsonl')
    const a = await run(['--file', file, '--detail-file', inside])
    expect(a).toMatchObject({ code: 2, err: 'REPORT_DETAIL_INSIDE_REPO' })
    expect(fs.existsSync(inside)).toBe(false)
    const b = await run(['--file', path.resolve(process.cwd(), 'package.json')])
    expect(b).toMatchObject({ code: 2, err: 'REPORT_FILE_INSIDE_REPO', out: '' })
    expect(isInsideRepo(path.resolve(process.cwd(), 'does', 'not', 'exist.txt'))).toBe(true)
    expect(isInsideRepo(file)).toBe(false)
  })

  it('refuses UNC and device paths and paths reached through a link into the repo', async () => {
    for (const p of ['\\\\localhost\\c$\\x\\export.xml', '\\\\127.0.0.1\\c$\\x\\export.xml', '\\\\?\\UNC\\localhost\\c$\\x\\e.xml', '//localhost/c$/x/e.xml', '\\\\.\\C:\\x\\e.xml']) {
      expect(isInsideRepo(p)).toBe(true)
      expect(await run(['--file', p])).toMatchObject({ code: 2, err: 'REPORT_FILE_INSIDE_REPO' })
      expect(await run(['--file', file, '--detail-file', p])).toMatchObject({ code: 2, err: 'REPORT_DETAIL_INSIDE_REPO' })
    }
    const link = path.join(dir, 'link-into-repo')
    try {
      fs.symlinkSync(process.cwd(), link, process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      return // links not permitted here
    }
    expect(isInsideRepo(path.join(link, 'new-file.jsonl'))).toBe(true)
    expect(await run(['--file', file, '--detail-file', path.join(link, 'rows.jsonl')])).toMatchObject({ err: 'REPORT_DETAIL_INSIDE_REPO' })
  })

  it('answers a short code when the detail file cannot be created', async () => {
    const r = await run(['--file', file, '--detail-file', path.join(dir, 'no-such-dir', 'rows.jsonl')])
    expect(r).toEqual({ code: 1, out: '', err: 'REPORT_DETAIL_FAILED' })
  })

  it('stays fast on hostile iframe text and does not report bracketed names as shortcodes', async () => {
    const hostile = path.join(dir, 'hostile.xml')
    fs.writeFileSync(
      hostile,
      wxr([
        { id: 1, content: '<iframe '.repeat(80_000) },
        { id: 2, content: '<p>As [John Smith] and [Smith 2020] said [sic] [laughs] [Jane Doe x=1]</p>' },
        { id: 3, status: 'publish', comments: [{ id: 1, approved: 'a'.repeat(500), type: 'T'.repeat(500) }] },
      ]),
    )
    const t = Date.now()
    const r = await run(['--file', hostile])
    expect(Date.now() - t).toBeLessThan(1000)
    expect(r.code).toBe(0)
    expect(r.out).toContain('published posts with iframes: 0')
    expect(r.out).toContain('published posts with shortcode-like tags: 1')
    expect(r.out).toContain('(other): 1')
    for (const leak of ['John', 'Smith', 'Jane', 'laughs']) expect(r.out).not.toContain(leak)
    expect(r.out).not.toContain('a'.repeat(21))
    expect(r.out).not.toContain('T'.repeat(21))
  })

  it('exits non-zero with a short code only on parse errors', async () => {
    const bad = path.join(dir, 'bomb.xml')
    fs.writeFileSync(bad, BILLION_LAUGHS)
    expect(await run(['--file', bad])).toEqual({ code: 1, out: '', err: 'WXR_DOCTYPE' })
    const trunc = path.join(dir, 'trunc.xml')
    fs.writeFileSync(trunc, wxr(list).slice(0, 2000))
    const t = await run(['--file', trunc])
    expect(t.code).toBe(1)
    expect(t.err).toMatch(/^WXR_[A-Z_]+$/)
    expect(await run([])).toMatchObject({ code: 2, err: 'REPORT_USAGE' })
    expect(await run(['--file', path.join(dir, 'missing.xml')])).toMatchObject({ code: 1, err: 'WXR_UNREADABLE' })
  })
})
