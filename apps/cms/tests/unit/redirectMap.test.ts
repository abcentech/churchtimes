import { describe, expect, it } from 'vitest'

import {
  type ArticleInput,
  type RedirectRule,
  type RuleLookup,
  type StoredRow,
  RedirectMapError,
  buildRedirectMap,
  canonicalJson,
  checkAddresses,
  deriveRule,
  findWriteConflict,
  legacyPathOf,
} from '../../src/lib/redirectMap'

const NOW = new Date('2026-10-16T00:00:00.123Z')
const base = { template: '/reports/{slug}/' as const, allowedHosts: ['www.example.test'], now: NOW }

const article = (slug: string, legacyUrl: string | null, status = 'published'): ArticleInput => ({ id: slug, slug, status, legacyUrl })
const row = (id: number, from: string, to: string | null, status = 301, source = 'manual'): StoredRow => ({ id, from, to, status, source })

const build = (articles: ArticleInput[], rows: StoredRow[], extra: Partial<Parameters<typeof buildRedirectMap>[0]> = {}) =>
  buildRedirectMap({ ...base, articles, rows, ...extra })
const problems = (fn: () => unknown): string => {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(RedirectMapError)
    return (err as RedirectMapError).message
  }
  throw new Error('expected the build to fail')
}

describe('derived rules (C7.2)', () => {
  it('derives from = path of legacyUrl and to = the current public path', () => {
    const { map } = build([article('new-slug', 'https://old.example.test/2019/05/old-slug/')], [])
    expect(map.rules).toEqual([{ from: '/2019/05/old-slug/', to: '/reports/new-slug/', status: 301, source: 'legacy-url' }])
    expect(map.count).toBe(1)
  })

  it('uses the template (the same value the public host reads)', () => {
    const { map } = build([article('new-slug', 'https://old.example.test/old-slug')], [], { template: '/{slug}/' })
    expect(map.rules[0]).toMatchObject({ from: '/old-slug/', to: '/new-slug/' })
  })

  it('emits no rule when from equals to (most articles with the /{slug}/ template)', () => {
    const r = build([article('same', 'https://old.example.test/same/'), article('renamed', 'https://old.example.test/old/')], [], {
      template: '/{slug}/',
    })
    expect(r.map.rules.map((x) => x.from)).toEqual(['/old/'])
    expect(r.stats.skipped.sameAddress).toBe(1)
  })

  it('emits nothing for unpublished, archived, scheduled or in-review articles', () => {
    const r = build(
      ['draft', 'in_review', 'scheduled', 'archived', 'changes_requested'].map((s) => article(`a-${s}`, `https://old.example.test/${s}/`, s)),
      [],
    )
    expect(r.map.rules).toEqual([])
    expect(r.stats.skipped.notPublished).toBe(5)
  })

  it('skips (and counts) a legacyUrl that cannot be an exact key: query string, root, junk', () => {
    const r = build(
      [
        article('q', 'https://old.example.test/?p=123'),
        article('i', 'https://old.example.test/index.php?p=5'),
        article('r', 'https://old.example.test/'),
        article('j', 'not a url'),
        article('ok', 'https://old.example.test/ok-old/'),
      ],
      [],
    )
    expect(r.map.rules.map((x) => x.from)).toEqual(['/ok-old/'])
    expect(r.stats.skipped).toMatchObject({ queryString: 2, root: 1, invalidLegacyUrl: 1 })
  })

  it('normalises the legacy path (lower-case WordPress percent-encoding becomes upper case)', () => {
    expect(legacyPathOf('https://old.example.test/caf%c3%a9')).toEqual({ ok: true, path: '/caf%C3%A9/' })
    expect(deriveRule(article('x', 'https://old.example.test/a/'), '/reports/{slug}/')).toMatchObject({ rule: { to: '/reports/x/' } })
  })
})

describe('combining, sorting and the hash (C7.3)', () => {
  const rows = [row(1, '/zeta/', '/'), row(2, '/alpha/', '/reports/a/', 302, 'rank-math')]
  const articles = [article('m', 'https://old.example.test/mid/')]

  it('sorts by from and keeps source and status', () => {
    const { map } = build(articles, rows)
    expect(map.rules.map((r) => r.from)).toEqual(['/alpha/', '/mid/', '/zeta/'])
    expect(map.rules[0]).toEqual({ from: '/alpha/', to: '/reports/a/', status: 302, source: 'rank-math' })
    expect(map.rules[2]).toEqual({ from: '/zeta/', to: '/', status: 301, source: 'manual' })
  })

  it('has a stable version that ignores input order and the clock but changes with the content', () => {
    const a = build(articles, rows)
    const b = build([...articles].reverse(), [...rows].reverse(), { now: new Date('2027-01-01T00:00:00Z') })
    expect(b.map.version).toBe(a.map.version)
    expect(a.map.version).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(b.map.generatedAt).toBe('2027-01-01T00:00:00Z')
    expect(a.map.generatedAt).toBe('2026-10-16T00:00:00Z')
    const changed = build(articles, [...rows, row(3, '/extra/', '/')])
    expect(changed.map.version).not.toBe(a.map.version)
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}')
  })

  it('serves exactly the JSON of the map (the endpoint and the export write the same bytes)', () => {
    const r = build(articles, rows)
    expect(JSON.parse(r.body)).toEqual(r.map)
    expect(r.bytes).toBe(Buffer.byteLength(r.body))
  })

  it('represents a 410 with a null target', () => {
    const { map } = build([], [row(1, '/gone/', null, 410)])
    expect(map.rules).toEqual([{ from: '/gone/', to: null, status: 410, source: 'manual' }])
  })
})

describe('collisions: duplicates fail and name both rules', () => {
  it('two stored rows with one address', () => {
    const msg = problems(() => build([], [row(1, '/a/', '/x/'), row(2, '/a/', '/y/')]))
    expect(msg).toMatch(/share the address \/a\//)
    expect(msg).toMatch(/#1/)
    expect(msg).toMatch(/#2/)
  })
  it('two articles with the same legacy address', () => {
    const msg = problems(() => build([article('one', 'https://old.example.test/a/'), article('two', 'https://old.example.test/a')], []))
    expect(msg).toMatch(/article "one"/)
    expect(msg).toMatch(/article "two"/)
  })
  it('a stored row and a derived rule', () => {
    const msg = problems(() => build([article('one', 'https://old.example.test/a/')], [row(7, '/a/', '/')]))
    expect(msg).toMatch(/#7/)
    expect(msg).toMatch(/article "one"/)
  })
  it('rejects stored rows that are not canonical or have an invalid status or target', () => {
    expect(problems(() => build([], [row(1, '/NoSlash', '/x/')]))).toMatch(/not a canonical path/)
    expect(problems(() => build([], [row(1, '/a/', '/x')]))).toMatch(/"to" is not a canonical/)
    expect(problems(() => build([], [row(1, '/a/', 'https://evil.example.test/x/')]))).toMatch(/allowed https/)
    expect(problems(() => build([], [row(1, '/a/', '/x/', 307)]))).toMatch(/status/)
    expect(problems(() => build([], [row(1, '/', '/x/')]))).toMatch(/not a canonical path/)
  })
})

describe('loops always fail', () => {
  it('a rule pointing at itself', () => {
    expect(problems(() => build([], [row(1, '/a/', '/a/')]))).toMatch(/Redirect loop/)
  })
  it('two rules pointing at each other, reported once', () => {
    const msg = problems(() => build([], [row(1, '/a/', '/b/'), row(2, '/b/', '/a/')]))
    expect(msg).toMatch(/Redirect loop/)
    expect(msg.match(/Redirect loop/g)).toHaveLength(1)
    expect(msg).toMatch(/#1/)
    expect(msg).toMatch(/#2/)
  })
  it('a longer cycle, and a chain that leads into a cycle', () => {
    expect(problems(() => build([], [row(1, '/a/', '/b/'), row(2, '/b/', '/c/'), row(3, '/c/', '/a/')]))).toMatch(/Redirect loop/)
    expect(problems(() => build([], [row(1, '/entry/', '/b/', 301, 'rank-math'), row(2, '/b/', '/c/'), row(3, '/c/', '/b/')]))).toMatch(/Redirect loop/)
  })
  it('a loop through a derived rule', () => {
    const msg = problems(() => build([article('new', 'https://old.example.test/old/')], [row(1, '/reports/new/', '/old/')]))
    expect(msg).toMatch(/Redirect loop/)
  })
})

describe('chains are flattened (at most one hop for any reader) and counted', () => {
  it('flattens a derived rule whose target is another rule', () => {
    const r = build(
      [article('first', 'https://old.example.test/a/')],
      [row(1, '/reports/first/', '/reports/second/'), row(2, '/reports/second/', '/final/')],
    )
    const to = Object.fromEntries(r.map.rules.map((x) => [x.from, x.to]))
    expect(to['/a/']).toBe('/final/')
    expect(to['/reports/first/']).toBe('/final/')
    expect(to['/reports/second/']).toBe('/final/')
    expect(r.stats.flattened).toBe(2)
    for (const rule of r.map.rules) expect(r.map.rules.some((o) => o.from === rule.to)).toBe(false)
  })
  it('flattens long chains of imported rows', () => {
    const r = build([], [row(1, '/a/', '/b/', 301, 'rank-math'), row(2, '/b/', '/c/', 301, 'rank-math'), row(3, '/c/', '/d/', 301, 'rank-math')])
    expect(r.map.rules.map((x) => x.to)).toEqual(['/d/', '/d/', '/d/'])
    expect(r.stats.flattened).toBe(2)
  })
  it('ends at an allowed external address', () => {
    const r = build([], [row(1, '/a/', '/b/', 301, 'rank-math'), row(2, '/b/', 'https://www.example.test/z/')])
    expect(r.map.rules.find((x) => x.from === '/a/')?.to).toBe('https://www.example.test/z/')
  })
  it('becomes temporary when any hop is temporary, and never flattens through a 410', () => {
    const r = build([], [row(1, '/a/', '/b/', 301, 'rank-math'), row(2, '/b/', '/c/', 302), row(3, '/x/', '/g/', 301, 'rank-math'), row(4, '/g/', null, 410)])
    const byFrom = Object.fromEntries(r.map.rules.map((x) => [x.from, x]))
    expect(byFrom['/a/']).toMatchObject({ to: '/c/', status: 302 })
    expect(byFrom['/x/']).toMatchObject({ to: '/g/', status: 301 })
    expect(r.stats.pointsToGone).toBe(1)
  })
})

describe('size caps refuse, never truncate', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => row(i + 1, `/p${i}/`, '/'))
  it('refuses above the rule cap, and accepts exactly the cap', () => {
    expect(problems(() => build([], many(4), { limits: { maxRules: 3 } }))).toMatch(/4 rules; the limit is 3/)
    expect(build([], many(3), { limits: { maxRules: 3 } }).map.count).toBe(3)
  })
  it('refuses above the byte cap', () => {
    const r = build([], many(3))
    expect(problems(() => build([], many(3), { limits: { maxBytes: r.bytes - 1 } }))).toMatch(/bytes; the limit is/)
    expect(build([], many(3), { limits: { maxBytes: r.bytes } }).bytes).toBe(r.bytes)
  })
  it('the defaults are 20,000 rules and 5 MB', async () => {
    const m = await import('../../src/lib/redirectMap')
    expect(m.MAX_RULES).toBe(20_000)
    expect(m.MAX_BYTES).toBe(5 * 1024 * 1024)
    expect(problems(() => build([], many(20_001)))).toMatch(/20001 rules; the limit is 20000/)
  })
})

describe('checkAddresses (counts only)', () => {
  const rules: RedirectRule[] = [
    { from: '/a/', to: '/x/', status: 301, source: 'manual' },
    { from: '/t/', to: '/y/', status: 302, source: 'manual' },
    { from: '/g/', to: null, status: 410, source: 'manual' },
  ]
  it('classifies resolved, live, unresolved and invalid lines without echoing any address', () => {
    const summary = checkAddresses(
      ['# top URLs', '', 'https://old.example.test/a', '/t/?utm=1', '/g/', '/reports/live/', '/missing/', 'https://old.example.test/?p=77', '/bad/../path/', 'junk'],
      rules,
      new Set(['/reports/live/']),
    )
    expect(summary).toEqual({
      total: 8,
      ignored: 2,
      resolved: 4,
      unresolved: 4,
      byStatus: { '301': 1, '302': 1, '410': 1, live: 1 },
      unresolvedBy: { invalid: 2, queryOnly: 1, noRule: 1 },
    })
    const text = JSON.stringify(summary)
    for (const secret of ['missing', 'old.example.test', 'junk', '/a/']) expect(text).not.toContain(secret)
  })
})

describe('findWriteConflict (logic over a fake lookup; the database version is covered by the integration tests)', () => {
  const stored: StoredRow[] = [row(1, '/b/', '/c/', 301, 'manual'), row(2, '/gone/', null, 410), row(3, '/m/', '/n/', 301, 'rank-math')]
  const lookup = (derived: Record<string, { to: string; label: string }> = {}, articles: Record<string, string> = {}): RuleLookup => ({
    storedFrom: async (p) => stored.find((r) => r.from === p) ?? null,
    storedTo: async (p) => stored.filter((r) => r.to === p),
    derivedFrom: async (p) => (derived[p] ? { from: p, to: derived[p].to, status: 301, source: 'legacy-url', label: derived[p].label } : null),
    articleAt: async (p) => articles[p] ?? null,
  })
  const cand = (from: string, to: string | null, status: 301 | 302 | 410 = 301, source: 'manual' | 'rank-math' | 'legacy-url' = 'manual') => ({
    from,
    to,
    status,
    source,
  })

  it('accepts a plain new rule', async () => {
    expect(await findWriteConflict(cand('/new/', '/dest/'), lookup())).toBeNull()
  })
  it('refuses a self-loop, a two-rule loop and a longer loop, naming the rule', async () => {
    expect(await findWriteConflict(cand('/a/', '/a/'), lookup())).toMatch(/Loop/)
    expect(await findWriteConflict(cand('/c/', '/b/'), lookup())).toMatch(/Loop: .* and rule #1/)
    // /a -> /m, existing /m -> /n; candidate /n -> /a closes the cycle (rank-math rows may chain, but never loop)
    expect(await findWriteConflict(cand('/n/', '/a/', 301, 'rank-math'), lookup({ '/a/': { to: '/m/', label: 'derived rule from article "x"' } }))).toMatch(/Loop/)
    expect(await findWriteConflict(cand('/n/', '/m/', 301, 'rank-math'), lookup())).toMatch(/Loop/)
  })
  it('refuses a manual row that chains, in both directions, naming the other rule', async () => {
    expect(await findWriteConflict(cand('/a/', '/b/'), lookup())).toMatch(/Chain: .*#1/)
    expect(await findWriteConflict(cand('/c/', '/d/'), lookup())).toMatch(/Chain: rule #1/)
  })
  it('lets rank-math rows chain (they are flattened at generation) but not manual rows through them', async () => {
    expect(await findWriteConflict(cand('/a/', '/b/', 301, 'rank-math'), lookup())).toBeNull()
    expect(await findWriteConflict(cand('/a/', '/m/'), lookup())).toMatch(/Chain/)
  })
  it('allows pointing at a 410 and being pointed at by a 410 row', async () => {
    expect(await findWriteConflict(cand('/a/', '/gone/'), lookup())).toBeNull()
    expect(await findWriteConflict(cand('/c/', null, 410), lookup())).toBeNull()
  })
  it('refuses a duplicate address, a derived duplicate and the live address of a published article', async () => {
    expect(await findWriteConflict(cand('/b/', '/z/'), lookup())).toMatch(/already exists: rule #1/)
    expect(await findWriteConflict(cand('/old/', '/z/'), lookup({ '/old/': { to: '/reports/s/', label: 'derived rule from article "s"' } }))).toMatch(/derived rule from article "s"/)
    expect(await findWriteConflict(cand('/reports/s/', '/z/'), lookup({}, { '/reports/s/': 's' }))).toMatch(/published article "s"/)
  })
  it('refuses a manual row that points at a derived rule (chain)', async () => {
    expect(await findWriteConflict(cand('/a/', '/old/'), lookup({ '/old/': { to: '/reports/s/', label: 'derived rule from article "s"' } }))).toMatch(/Chain: .*derived rule from article "s"/)
  })
})
