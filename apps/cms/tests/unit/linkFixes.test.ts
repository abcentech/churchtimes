import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { auditLinks, type AuditOptions } from '../../src/import/linkAudit'
import { diagnoseLink, reviewCsv, SlugIndex, suggestedFixesCsv } from '../../src/import/linkDiagnose'
import { classifyHref, LinkContextBuilder, linkClassifyHook } from '../../src/import/linkClassify'
import { createLinkFixer, LinkFixesError, parseLinkFixes, readLinkFixesFile } from '../../src/import/linkFixes'
import { resolveSiteHosts } from '../../src/import/linkSiteHosts'
import { htmlToLexical } from '../../src/import/htmlToLexical'
import { readWxrFile } from '../../src/import/wxr'
import { wxr, type FixtureItem } from '../fixtures/wxr/generate'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wxr-linkfixes-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

const ap = (slug: string) => `/${slug}/`
const NET = 'https://churchtimesnigeria.net'
const opts = { articleTemplate: '/{slug}/' }

const links = (hrefs: string[]): string => `<p>${hrefs.map((h, i) => `<a href="${h}">l${i}</a>`).join(' ')}</p>`

const hrefs = [
  `${NET}/alpha_story/`, // underscore for hyphen: same after normalising
  `${NET}/alpha-story-2/`, // numeric suffix
  `${NET}/alpha-storyy/`, // trailing characters
  `${NET}/old-draft/`, // draft
  `${NET}/old-trash/`, // trashed
  `${NET}/old-private/`, // private
  `${NET}/old-locked/`, // password protected
  `${NET}/old-page/`, // page
  `${NET}/old-photo/`, // attachment
  `${NET}/old-product/`, // other type
  `${NET}/never-existed-here/`, // not in export
  `${NET}/news/alpha-story/`, // odd path with a known slug
  `${NET}/news/2020/nothing/`, // odd path
  `${NET}/www.elsewhere.test/page/`, // external style
]

const items = (body: string): FixtureItem[] => [
  { id: 1, slug: 'alpha-story', content: '<p>Alpha.</p>', categories: [{ nicename: 'news', name: 'News' }] },
  { id: 2, slug: 'beta', content: body, categories: [{ nicename: 'news', name: 'News' }] },
  { id: 3, slug: 'old-draft', status: 'draft', content: '<p>x</p>' },
  { id: 4, slug: 'old-trash', status: 'trash', content: '<p>x</p>' },
  { id: 5, slug: 'old-private', status: 'private', content: '<p>x</p>' },
  { id: 6, slug: 'old-locked', password: 'x', content: '<p>x</p>' },
  { id: 7, slug: 'old-page', postType: 'page', content: '<p>x</p>' },
  { id: 8, slug: 'old-photo', postType: 'attachment', status: 'inherit', content: '' },
  { id: 9, slug: 'old-product', postType: 'product', content: '<p>x</p>' },
]

let n = 0
async function run(its: FixtureItem[], extra: Partial<AuditOptions> = {}) {
  const file = path.join(dir, `f${n++}.xml`)
  fs.writeFileSync(file, wxr(its))
  return { ...(await auditLinks(() => readWxrFile(file), { articlePath: ap, ...extra })), file }
}

describe('why a link is unresolved (cause heuristics)', () => {
  it('names the likely cause of every problem link', async () => {
    const { problems } = await run(items(links(hrefs)))
    expect(problems.map((p) => p.diagnosis.cause)).toEqual([
      'near-match-case-or-encoding',
      'near-match-numeric-suffix',
      'near-match-trailing-characters',
      'draft-or-private',
      'trashed',
      'draft-or-private',
      'password-protected',
      'non-post-other-type',
      'not-in-export',
      'odd-path-contains-known-slug',
      'odd-path',
      'external-style-path',
    ])
  })

  it('a page or attachment slug is named as such when diagnosed directly (the audit counts those types separately)', async () => {
    const { ctx, file } = await run(items('<p>x</p>'))
    const idx = new SlugIndex()
    for await (const rec of readWxrFile(file)) idx.add(rec)
    for (const [slug, cause] of [['old-page', 'non-post-page'], ['old-photo', 'non-post-attachment']] as const) {
      const href = NET + '/' + slug + '/'
      expect(diagnoseLink(classifyHref(href, ctx), href, ctx, idx).cause).toBe(cause)
    }
  })

  it('the best candidate (id, similarity) is in the private review file; only high-confidence unique matches are suggested', async () => {
    const { problems } = await run(items(links(hrefs)))
    const csv = reviewCsv(problems)
    expect(csv.split('\n')[0]).toBe('legacy_post_id,link_index,kind,raw_target,cause,best_candidate_wp_id,best_candidate_slug,similarity,suggested_new_path,from,decision')
    expect(csv).toContain('1.000')
    const s = suggestedFixesCsv(problems)
    // the underscore variant (1.0) and the numeric suffix (0.96); the trailing-characters match (0.92) is not high confidence
    expect(s.count).toBe(2)
    expect(s.csv).toContain('/alpha-story/')
    expect(s.csv).not.toContain('alpha-storyy')
  })

  it('two equally good candidates are not unique, so nothing is suggested', async () => {
    const its = [
      ...items(links([`${NET}/alpha-story-3/`])),
      { id: 20, slug: 'alpha-story-4', content: '<p>x</p>', categories: [{ nicename: 'news', name: 'News' }] },
    ]
    const { problems } = await run(its)
    expect(suggestedFixesCsv(problems).count).toBe(0)
  })
})

describe('old hosts default to the primary host', () => {
  it('.org, .com and www. variants of all three are the same site; links keep their path', async () => {
    const { ctx } = await run(items('<p>x</p>'))
    for (const h of ['churchtimesnigeria.org', 'www.churchtimesnigeria.org', 'churchtimesnigeria.com', 'www.churchtimesnigeria.com', 'churchtimesnigeria.net', 'www.churchtimesnigeria.net']) {
      expect(classifyHref(`https://${h}/alpha-story/#x`, ctx)).toMatchObject({ resolved: true, to: '/alpha-story/#x' })
    }
    expect(classifyHref('https://churchtimesnigeria.org/alpha-story/', ctx).host).toBe('legacy')
    expect(classifyHref('https://churchtimesnigeria.net/alpha-story/', ctx).host).toBe('primary')
  })

  it('an unresolved link on an old host is still rewritten to the same path (the host means this site)', async () => {
    const { ctx } = await run(items('<p>x</p>'))
    const hook = linkClassifyHook(ctx)
    expect(hook('https://www.churchtimesnigeria.com/no-such/?a=1#h')).toMatchObject({ to: '/no-such/?a=1#h' })
    expect(hook('https://churchtimesnigeria.net/no-such/').to).toBeNull() // primary host: kept as written
    expect(hook('https://elsewhere.test/no-such/').to).toBeNull()
  })

  it('the host list is configurable (LEGACY_SITE_HOSTS) and the primary comes from PUBLIC_SITE_URL', () => {
    expect(resolveSiteHosts({})).toEqual({ primary: 'churchtimesnigeria.net', legacy: ['churchtimesnigeria.org', 'churchtimesnigeria.com'] })
    expect(resolveSiteHosts({ PUBLIC_SITE_URL: 'https://www.example.test', LEGACY_SITE_HOSTS: 'Old.Example.test, www.other.test' })).toEqual({
      primary: 'example.test',
      legacy: ['old.example.test', 'other.test'],
    })
    expect(() => resolveSiteHosts({ LEGACY_SITE_HOSTS: 'https://x.test' })).toThrow()
  })
})

describe('link fixes file', () => {
  it('parses CSV (with and without a header, quotes) and JSON; validates targets', () => {
    const csv = [
      'from,to',
      '/old-a/,/alpha-story/',
      'Old-B,remove-link',
      '"old-c",keep-text',
      'old-d,https://elsewhere.test/x/', // external host
      'old-e,javascript:alert(1)',
      'old-f,//evil.test/x',
      'old-g,',
      'https://churchtimesnigeria.org/old-h/?x=1,https://churchtimesnigeria.com/alpha-story/',
    ].join('\r\n')
    const f = parseLinkFixes(csv, 'csv', { ...opts, siteHosts: new Set(['churchtimesnigeria.net', 'churchtimesnigeria.org', 'churchtimesnigeria.com']) })
    expect([...f.entries.keys()].sort()).toEqual(['old-a', 'old-b', 'old-c', 'old-h'])
    expect(f.entries.get('old-h')).toEqual({ kind: 'path', to: '/alpha-story/' })
    expect(f.invalid).toBe(3)
    expect(f.undecided).toBe(1)
    expect(parseLinkFixes('old-a,/alpha-story/\n', 'csv', opts).entries.size).toBe(1)
    expect(parseLinkFixes(JSON.stringify({ 'old-a': '/alpha-story/', 'old-b': 'remove-link' }), 'json', opts).entries.size).toBe(2)
    expect(parseLinkFixes(JSON.stringify([{ from: '/old-a/', to: '/alpha-story/' }]), 'json', opts).entries.size).toBe(1)
    expect(() => parseLinkFixes('{', 'json', opts)).toThrow(LinkFixesError)
  })

  it('a path must start with the article path template prefix', () => {
    const f = parseLinkFixes('a,/reports/alpha-story/\nb,/alpha-story/', 'csv', { articleTemplate: '/reports/{slug}/' })
    expect([...f.entries.keys()]).toEqual(['a'])
    expect(f.invalid).toBe(1)
  })

  it('conflicting decisions for one address are both dropped', () => {
    const f = parseLinkFixes('a,/x/\na,remove-link', 'csv', opts)
    expect(f.entries.size).toBe(0)
    expect(f.invalid).toBe(2)
  })

  it('reads the private review file as it is (header names), and refuses a file inside a repository', () => {
    const file = path.join(dir, 'link-fixes.csv')
    fs.writeFileSync(file, 'legacy_post_id,link_index,kind,raw_target,cause,from,decision\n2,1,article-unknown,https://x.test/old-a/,not-in-export,/old-a/,/alpha-story/\n')
    expect(readLinkFixesFile(file, opts).entries.get('old-a')).toEqual({ kind: 'path', to: '/alpha-story/' })
    expect(() => readLinkFixesFile(path.join(process.cwd(), 'package.json'), opts)).toThrow(/INSIDE_REPO/)
    expect(() => readLinkFixesFile(path.join(dir, 'missing.csv'), opts)).toThrow(/UNREADABLE/)
  })
})

describe('applying fixes', () => {
  const fixText = ['from,to', '/never-existed-here/,/alpha-story/', 'alpha-storyy,/alpha-story/', 'old-draft,remove-link', 'unused-one,/alpha-story/', 'old-page,/missing-target/'].join('\n')

  it('turns unresolved links into resolved ones in the audit, counts applied and unmatched, and never touches a working link', async () => {
    const body = links([...hrefs, `${NET}/alpha-story/`])
    const before = await run(items(body))
    const after = await run(items(body), { linkFixes: parseLinkFixes(fixText, 'csv', opts) })
    expect(after.audit.unresolvedTotal).toBe(before.audit.unresolvedTotal - 3)
    expect(after.fixes).toMatchObject({ entries: 5, appliedLinks: 3, entriesUsed: 3, targetNotFound: 1, unmatchedEntries: 1 })
    expect(after.problems.length).toBe(before.problems.length - 3)
  })

  it('the converter rewrites to the new path, unwraps remove-link keeping the text, and is idempotent', async () => {
    const file = path.join(dir, `c${n++}.xml`)
    fs.writeFileSync(file, wxr(items('<p>x</p>')))
    const b = new LinkContextBuilder()
    for await (const rec of readWxrFile(file)) b.add(rec)
    const ctx = b.build({ articlePath: ap })
    const fixer = createLinkFixer(parseLinkFixes(fixText, 'csv', opts), ctx)
    const html = `<p><a href="${NET}/never-existed-here/#top">Missing</a> <a href="/old-draft/">Gone</a> <a href="https://churchtimesnigeria.org/zzz/">Old host</a></p>`
    const conv = () =>
      htmlToLexical(html, {
        oldHosts: ['churchtimesnigeria.net', 'churchtimesnigeria.org'],
        slugMap: { 'alpha-story': 'alpha-story', beta: 'beta' },
        articlePath: ap,
        classify: linkClassifyHook(ctx, fixer),
        resolveImage: () => null,
      })
    const text = JSON.stringify(conv().content)
    expect(text).toContain('"/alpha-story/#top"')
    expect(text).toContain('Gone')
    expect(text).not.toContain('/old-draft/')
    expect(text).toContain('"/zzz/"')
    expect(JSON.stringify(conv().content)).toBe(text)
    expect(classifyHref('/alpha-story/', ctx).resolved).toBe(true)
  })
})

describe('import CLI option', () => {
  it('--link-fixes is read by import:wxr (needs a value)', async () => {
    const { parseImportArgs } = await import('../../src/import/cli')
    expect(parseImportArgs(['--file', 'a.xml', '--link-fixes', 'f.csv'], {})?.linkFixesFile).toBe('f.csv')
    expect(parseImportArgs(['--file', 'a.xml', '--link-fixes'], {})).toBeNull()
    expect(parseImportArgs(['--file', 'a.xml'], {})?.linkFixesFile).toBeUndefined()
  })
})
