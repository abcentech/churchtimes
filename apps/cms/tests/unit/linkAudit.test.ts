import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import { afterAll, describe, expect, it } from 'vitest'

import { sanitizeLegacyLinks } from '../../src/lib/legacyContent'
import { htmlToLexical } from '../../src/import/htmlToLexical'
import { auditLinks, extractLinks, finalizeRedirects, redirectsCsv, type AuditRow } from '../../src/import/linkAudit'
import { classifyHref, KNOWN_LEGACY_HOSTS, LinkContextBuilder, linkClassifyHook } from '../../src/import/linkClassify'
import { convertWxrStats } from '../../src/import/convertStats'
import { readWxrFile } from '../../src/import/wxr'
import { cdata, wxr, type FixtureItem } from '../fixtures/wxr/generate'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wxr-linkaudit-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

const H = 'https://old.example.test'
const ap = (slug: string) => `/${slug}/`

const links = (hrefs: string[]): string => `<p>${hrefs.map((h, i) => `<a href="${h}">l${i}</a>`).join(' ')}</p>`

const baseItems = (body: string): FixtureItem[] => [
  { id: 1, slug: 'alpha', content: '<p>Alpha.</p>', categories: [{ nicename: 'news', name: 'News' }], tags: [{ nicename: 'sometag', name: 'Some tag' }] },
  { id: 2, slug: 'beta', content: body, categories: [{ nicename: 'news', name: 'News' }] },
  { id: 3, slug: 'gamma', status: 'draft', content: '<p>Draft.</p>' },
  { id: 4, slug: 'about-us', postType: 'page', content: '<p>About.</p>' },
  { id: 5, slug: 'photo-1', postType: 'attachment', status: 'inherit', content: '' },
]

let n = 0
async function audit(items: FixtureItem[], raw = '', opts: { tagPath?: (s: string) => string } = {}) {
  const file = path.join(dir, `a${n++}.xml`)
  fs.writeFileSync(file, wxr(items, { raw }))
  const rows: AuditRow[] = []
  const res = await auditLinks(() => readWxrFile(file), { articlePath: ap, tagPath: opts.tagPath ?? null, onRow: (r) => rows.push(r) })
  return { ...res, rows, file }
}

describe('link classification by type (synthetic export)', () => {
  const body = links([
    `${H}/alpha/`, // article
    `${H}/gamma/`, // draft
    `${H}/no-such-post/`, // unknown
    `${H}/about-us/`, // page
    `${H}/photo-1/`, // attachment
    `${H}/category/news/`, // category (created)
    `${H}/category/missing/`, // category (not created)
    `${H}/tag/sometag/`, // tag
    `${H}/author/someone/`, // author
    `${H}/2023/05/`, // date archive
    `${H}/2023/05/alpha/`, // dated permalink
    `${H}/?p=1`, // post id, published
    `${H}/?p=3`, // post id, draft
    `${H}/?p=999`, // post id, missing
    `${H}/?page_id=4`, // page id
    `${H}/feed/`, // feed
    `${H}/wp-content/uploads/2023/05/pic.jpg`, // uploads
    `${H}/wp-admin/post.php`, // admin
    `https://churchtimesnigeria.org/alpha/`, // other old host
    `${H}/`, // home
    'https://elsewhere.example.org/alpha/', // external
    'mailto:a@example.test',
    'tel:+2348000000000',
  ])

  it('counts every type, resolved and unresolved', async () => {
    const { audit: a } = await audit(baseItems(body))
    const t = (k: keyof typeof a.byType) => a.byType[k]
    expect(t('article')).toMatchObject({ total: 2, resolved: 2, resolvedBefore: 1 }) // .net-style host and .org host
    expect(t('article-draft')).toMatchObject({ total: 1, unresolved: 1 })
    expect(t('article-unknown')).toMatchObject({ total: 1, unresolved: 1 })
    expect(t('page')).toMatchObject({ total: 1, resolved: 0, unresolved: 1 })
    expect(t('page-id')).toMatchObject({ total: 1, resolved: 0, unresolved: 1 })
    expect(t('attachment')).toMatchObject({ total: 1, unresolved: 1 })
    expect(t('category')).toMatchObject({ total: 2, resolved: 1, unresolved: 1 })
    expect(t('tag')).toMatchObject({ total: 1, unresolved: 1 })
    expect(t('author')).toMatchObject({ total: 1, unresolved: 1 })
    expect(t('date-archive')).toMatchObject({ total: 1, unresolved: 1 })
    expect(t('dated-permalink')).toMatchObject({ total: 1, resolved: 1 })
    expect(t('post-id')).toMatchObject({ total: 3, resolved: 1, unresolved: 2 })
    expect(t('feed')).toMatchObject({ total: 1, unresolved: 1 })
    expect(t('uploads')).toMatchObject({ total: 1, resolved: 0, unresolved: 1 })
    expect(t('wp-admin')).toMatchObject({ total: 1, unresolved: 1 })
    expect(t('home')).toMatchObject({ total: 1, resolved: 1 })
    expect(t('external')?.total).toBe(1)
    expect(t('mailto')?.total).toBe(1)
    expect(t('tel')?.total).toBe(1)
    expect(a.byHost.legacy).toBe(1)
    // totals add up: site links = resolved + unresolved
    expect(a.siteLinks).toBe(a.resolvedTotal + a.unresolvedTotal)
  })

  it('the draft slug is a draft, the page id and slug both resolve to the page type', async () => {
    const { ctx } = await audit(baseItems(body))
    expect(classifyHref(`${H}/gamma/`, ctx).type).toBe('article-draft')
    expect(classifyHref(`${H}/?page_id=4`, ctx)).toMatchObject({ type: 'page-id', resolved: false })
  })

  it('a tag path option resolves tag archives, and a pages mapper resolves pages', async () => {
    const { ctx } = await audit(baseItems(body), '', { tagPath: (s) => `/topic/${s}/` })
    expect(classifyHref(`${H}/tag/sometag/`, ctx)).toMatchObject({ type: 'tag', resolved: true, to: '/topic/sometag/' })
    expect(classifyHref(`${H}/tag/unknown-tag/`, ctx).resolved).toBe(false)
  })
})

describe('rewriting', () => {
  const hrefs = [
    `${H}/alpha/#part`,
    `${H}/?p=1`,
    `${H}/?page_id=4`,
    `https://www.churchtimesnigeria.org/alpha/`,
    `${H}/category/news/`,
    `${H}/category/missing/`,
    `${H}/wp-content/uploads/2023/05/pic.jpg`,
    `${H}/about-us/`,
    'mailto:a@example.test',
    'tel:+2348000000000',
    'https://elsewhere.example.org/x/',
  ]

  async function convert(items: FixtureItem[]) {
    const file = path.join(dir, `c${n++}.xml`)
    fs.writeFileSync(file, wxr(items))
    const b = new LinkContextBuilder()
    for await (const rec of readWxrFile(file)) b.add(rec)
    const ctx = b.build({ articlePath: ap, extraHosts: KNOWN_LEGACY_HOSTS })
    const opts = { oldHosts: ['old.example.test', ...KNOWN_LEGACY_HOSTS], slugMap: { alpha: 'alpha', beta: 'beta' }, articlePath: ap, classify: linkClassifyHook(ctx), resolveImage: () => null }
    return { ctx, opts }
  }

  it('rewrites ?p=N, old hosts and created categories; keeps pages, uploads and unmapped as written; never leaves the site', async () => {
    const { opts } = await convert(baseItems(links(hrefs)))
    const r = htmlToLexical(links(hrefs), opts)
    const urls: string[] = []
    const walk = (x: unknown): void => {
      if (Array.isArray(x)) x.forEach(walk)
      else if (x && typeof x === 'object') {
        const o = x as { type?: string; fields?: { url?: string }; children?: unknown[] }
        if (o.type === 'link' && o.fields?.url) urls.push(o.fields.url)
        if (o.children) walk(o.children)
      }
    }
    walk(r.content.root)
    expect(urls).toEqual([
      '/alpha/#part',
      '/alpha/',
      `${H}/?page_id=4`,
      '/alpha/',
      '/category/news/',
      `${H}/category/missing/`,
      `${H}/wp-content/uploads/2023/05/pic.jpg`,
      `${H}/about-us/`,
      'mailto:a@example.test',
      'https://elsewhere.example.org/x/',
    ])
    expect(r.report.links.rewritten).toBe(4)
    // tel: unchanged behaviour (text kept, link gone)
    expect(r.report.links.converted.map((c) => c.reason)).toEqual(['tel: links are not accepted'])
    // every rewrite is root-relative
    for (const u of urls) if (u.startsWith(H) || u.startsWith('/')) expect(u.startsWith('//')).toBe(false)
    const unmappedReasons = r.report.links.unmapped.map((u) => u.reason).sort()
    expect(unmappedReasons).toContain('page (no pages collection yet)')
    expect(unmappedReasons).toContain('uploaded file (not in the media map yet)')
    expect(unmappedReasons).toContain('category not created by the import')
  })

  it('is idempotent: rewriting the output again changes nothing', async () => {
    const { opts } = await convert(baseItems(links(hrefs)))
    const once = htmlToLexical(links(hrefs), opts)
    const again = sanitizeLegacyLinks(once.content, { oldHosts: opts.oldHosts, slugMap: opts.slugMap, articlePath: ap, classify: opts.classify })
    expect(again.report.rewritten).toBe(0)
    expect(again.root).toEqual(once.content)
  })

  it('counts the same rewritten links as the audit says are resolved (conversion stats)', async () => {
    const items = baseItems(links([`${H}/alpha/`, `${H}/?p=1`, `${H}/category/news/`, `${H}/tag/sometag/`]))
    const file = path.join(dir, `s${n++}.xml`)
    fs.writeFileSync(file, wxr(items))
    const { stats } = await convertWxrStats(() => readWxrFile(file))
    expect(stats.linksRewritten).toBe(3)
    expect(stats.linksUnmapped).toBe(1)
  })

  it('without the resolver the old behaviour is unchanged', () => {
    const r = sanitizeLegacyLinks(
      { root: { type: 'root', children: [{ type: 'paragraph', children: [{ type: 'link', fields: { url: `${H}/?p=1` }, children: [{ type: 'text', text: 'x' }] }] }] } },
      { oldHosts: ['old.example.test'], slugMap: { alpha: 'alpha' }, articlePath: ap },
    )
    expect(r.report.unmapped[0].reason).toMatch(/query string/)
  })
})

describe('extractLinks', () => {
  it('finds quoted, single-quoted and bare hrefs and flags image-wrapped anchors', () => {
    const l = extractLinks(`<a href="/a/">x</a><a class=y href='/b/'><img src=z></a> <A HREF=/c/>c</A><a name="n">no</a>`)
    expect(l.map((x) => x.href)).toEqual(['/a/', '/b/', '/c/'])
    expect(l.map((x) => x.imageWrapped)).toEqual([false, true, false])
  })
})

describe('redirect rules', () => {
  const raw = `<wp:category><wp:term_id>9</wp:term_id><wp:category_nicename>${cdata('local')}</wp:category_nicename><wp:category_parent>${cdata('news')}</wp:category_parent><wp:cat_name>${cdata('Local')}</wp:cat_name></wp:category>`

  it('emits rules for nested categories and dated permalinks, in the import:redirects format, and nothing else', async () => {
    const items = baseItems(links([`${H}/2023/05/alpha/`, `${H}/category/news/local/`, `${H}/category/news/`, `${H}/?p=1`, `${H}/tag/sometag/`]))
    items[1].categories = [{ nicename: 'local', name: 'Local' }]
    const { rules, audit: a } = await audit(items, raw)
    expect(rules).toEqual([
      { from: '/2023/05/alpha/', to: '/alpha/', status: 301 },
      { from: '/category/news/local/', to: '/category/local/', status: 301 },
    ])
    expect(a.redirects.rules).toBe(2)
    expect(redirectsCsv(rules)).toBe('from,to,status\n/2023/05/alpha/,/alpha/,301\n/category/news/local/,/category/local/,301\n')
    // no 410 is ever invented and no rule has a query string or a host
    for (const r of rules) {
      expect(r.status).toBe(301)
      expect(r.from + r.to).not.toMatch(/[?#]|:\/\//)
    }
  })

  it('does not duplicate a rule the article derives from its own permalink', async () => {
    const items = baseItems(links([`${H}/2023/05/alpha/`]))
    items[0].link = `${H}/2023/05/alpha/`
    const { rules, audit: a } = await audit(items)
    expect(rules).toEqual([])
    expect(a.redirects.dropped['covered-by-article-rule']).toBe(1)
  })

  it('finalizeRedirects drops identical, loops and conflicts, flattens chains', () => {
    const r = finalizeRedirects([
      { from: '/a/', to: '/a/' },
      { from: '/b/', to: '/c/' },
      { from: '/c/', to: '/d/' }, // chain b -> c -> d
      { from: '/x/', to: '/y/' },
      { from: '/y/', to: '/x/' }, // loop
      { from: '/p/', to: '/q/' },
      { from: '/p/', to: '/r/' }, // conflict
      { from: '/dup/', to: '/t/' },
      { from: '/dup/', to: '/t/' }, // same rule twice
      { from: '/art/', to: '/z/' }, // an article address
      { from: 'https://x.test/a/', to: '/a/' }, // invalid
    ], { articlePaths: new Set(['/art/']) })
    expect(r.rules.map((x) => `${x.from}>${x.to}`)).toEqual(['/b/>/d/', '/c/>/d/', '/dup/>/t/'])
    expect(r.flattened).toBe(1)
    expect(r.dropped).toMatchObject({ identical: 1, loop: 2, conflict: 1, 'is-article-address': 1, invalid: 1 })
    // no emitted `to` is another emitted `from`
    const froms = new Set(r.rules.map((x) => x.from))
    for (const x of r.rules) expect(froms.has(x.to)).toBe(false)
  })

  it('is idempotent: a second audit gives identical counts, rules and rows', async () => {
    const items = baseItems(links([`${H}/2023/05/alpha/`, `${H}/?p=1`, `${H}/category/news/`]))
    const first = await audit(items)
    const second = await audit(items)
    expect(second.audit).toEqual(first.audit)
    expect(second.rules).toEqual(first.rules)
    expect(second.rows).toEqual(first.rows)
  })
})

describe('import:link-audit command', () => {
  const tsx = path.resolve(__dirname, '../../node_modules/tsx/dist/cli.mjs')
  const script = path.resolve(__dirname, '../../scripts/import-link-audit.ts')
  const run = (args: string[]) => spawnSync(process.execPath, [tsx, script, ...args], { cwd: path.resolve(__dirname, '../..'), encoding: 'utf8' })

  it('prints counts only, writes private files outside a repo, and refuses a path inside a git work tree', () => {
    const file = path.join(dir, 'cli.xml')
    fs.writeFileSync(file, wxr(baseItems(links([`${H}/alpha/`, `${H}/about-us/`]))))
    const out = path.join(dir, 'rows.jsonl')
    const rules = path.join(dir, 'rules.csv')
    const ok = run(['--file', file, '--out', out, '--redirects-out', rules, '--article-path', '/{slug}/'])
    expect(ok.status).toBe(0)
    expect(ok.stdout).toContain('article: 1 / 1 / 0 / 1')
    expect(ok.stdout).not.toContain('about-us')
    expect(fs.readFileSync(rules, 'utf8')).toBe('from,to,status\n')
    expect(fs.readFileSync(out, 'utf8').split('\n').filter(Boolean)).toHaveLength(2)

    const inside = path.resolve(__dirname, '../../audit-rows.tmp.jsonl')
    const refused = run(['--file', file, '--out', inside])
    expect(refused.status).toBe(2)
    expect(refused.stderr).toContain('LINK_AUDIT_PATH_INSIDE_REPO')
    expect(fs.existsSync(inside)).toBe(false)
    const refusedRules = run(['--file', file, '--redirects-out', inside])
    expect(refusedRules.status).toBe(2)
    expect(run([]).status).toBe(2)
  }, 120000)
})
