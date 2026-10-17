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
  errorCode,
  findWriteConflict,
  hasDataWarnings,
  legacyPathOf,
} from '../../src/lib/redirectMap'
import { compileRedirectMap } from '../fixtures/publicHostValidator.mjs'

const NOW = new Date('2026-10-16T00:00:00.123Z')
const LEGACY = ['old.example.test']
const base = { template: '/reports/{slug}/' as const, allowedHosts: ['www.example.test'], legacyHosts: LEGACY, now: NOW }

const article = (slug: string, legacyUrl: string | null, status = 'published', id: number | string = slug): ArticleInput => ({
  id,
  slug,
  status,
  legacyUrl,
})
const row = (id: number, from: string, to: string | null, status = 301, source = 'manual'): StoredRow => ({ id, from, to, status, source })

const build = (articles: ArticleInput[], rows: StoredRow[], extra: Partial<Parameters<typeof buildRedirectMap>[0]> = {}) =>
  buildRedirectMap({ ...base, articles, rows, ...extra })
const refused = (fn: () => unknown): RedirectMapError => {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(RedirectMapError)
    return err as RedirectMapError
  }
  throw new Error('expected the build to be refused')
}
const byFrom = (rules: RedirectRule[]) => Object.fromEntries(rules.map((r) => [r.from, r]))

/** The public host rejects the whole list on any chain: no emitted `to` may equal another emitted `from`. */
const expectNoChains = (rules: RedirectRule[]) => {
  const froms = new Set(rules.map((r) => r.from))
  for (const r of rules) if (r.to) expect(froms.has(r.to), `${r.from} -> ${r.to}`).toBe(false)
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
        article('t', 'https://old.example.test/tel:2019/'),
        article('ok', 'https://old.example.test/ok-old/'),
      ],
      [],
    )
    expect(r.map.rules.map((x) => x.from)).toEqual(['/ok-old/'])
    expect(r.stats.skipped).toMatchObject({ queryString: 2, root: 1, invalidLegacyUrl: 2 })
  })

  it('skips and counts a legacyUrl on a host that is not a configured legacy host; bare paths are accepted', () => {
    const r = build(
      [
        article('f', 'https://elsewhere.example.test/foreign/'),
        article('s', 'http://OLD.example.test:8080/scheme-and-port/'),
        article('p', '/bare-path/'),
      ],
      [],
    )
    expect(r.map.rules.map((x) => x.from)).toEqual(['/bare-path/', '/scheme-and-port/'])
    expect(r.stats.skipped.foreignHost).toBe(1)
    expect(legacyPathOf('https://x.example.test/a/', ['x.example.test'])).toEqual({ ok: true, path: '/a/' })
    expect(legacyPathOf('https://x.example.test/a/', ['y.example.test'])).toEqual({ ok: false, reason: 'foreignHost' })
  })

  it('an article whose slug cannot make a public path derives nothing instead of failing the list', () => {
    const r = build([article('Not A Slug!', 'https://old.example.test/a/')], [])
    expect(r.map.rules).toEqual([])
    expect(r.stats.skipped.invalidSlug).toBe(1)
  })

  it('normalises the legacy path (lower-case WordPress percent-encoding, NFD) and compares canonical forms', () => {
    expect(legacyPathOf('https://old.example.test/caf%c3%a9')).toEqual({ ok: true, path: '/caf%C3%A9/' })
    expect(legacyPathOf('https://old.example.test/cafe%CC%81/')).toEqual({ ok: true, path: '/caf%C3%A9/' })
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

describe('data problems never stop the list: they are resolved or dropped, and counted', () => {
  it('a staff row beats an article-derived rule for the same address (and is reported)', () => {
    const r = build([article('one', 'https://old.example.test/a/')], [row(7, '/a/', '/chosen/')])
    expect(r.map.rules).toEqual([{ from: '/a/', to: '/chosen/', status: 301, source: 'manual' }])
    expect(r.stats.overriddenDerived).toBe(1)
    expect(r.stats.derived).toBe(0)
    expect(r.details.join('\n')).toMatch(/overridden by a staff row/)
    expect(hasDataWarnings(r.stats)).toBe(true)
  })

  it('the lowest article id wins a duplicate legacyUrl, whatever the input order', () => {
    const one = article('one', 'https://old.example.test/a/', 'published', 9)
    const two = article('two', 'https://old.example.test/a', 'published', 3)
    for (const articles of [[one, two], [two, one]]) {
      const r = build(articles, [])
      expect(r.map.rules).toEqual([{ from: '/a/', to: '/reports/two/', status: 301, source: 'legacy-url' }])
      expect(r.stats.dropped.duplicateLegacy).toBe(1)
    }
  })

  it('invalid stored rows are dropped, not fatal', () => {
    const r = build([], [
      row(1, '/NoSlash', '/x/'),
      row(2, '/a/', '/x'),
      row(3, '/b/', 'https://evil.example.test/x/'),
      row(4, '/c/', '/x/', 307),
      row(5, '/', '/x/'),
      row(6, '/d/', '/x/', 301, 'other'),
      row(7, '/ok/', '/fine/'),
    ])
    expect(r.map.rules.map((x) => x.from)).toEqual(['/ok/'])
    expect(r.stats.dropped.invalid).toBe(6)
  })

  it('a duplicate stored address keeps the lowest id', () => {
    const r = build([], [row(2, '/a/', '/y/'), row(1, '/a/', '/x/')])
    expect(r.map.rules).toEqual([{ from: '/a/', to: '/x/', status: 301, source: 'manual' }])
    expect(r.stats.dropped.duplicateStored).toBe(1)
  })

  it('loops are dropped (every rule on the cycle, and chains that lead into it), the rest is served', () => {
    const r = build([], [
      row(1, '/self/', '/self/'),
      row(2, '/a/', '/b/'),
      row(3, '/b/', '/a/'),
      row(4, '/entry/', '/b/', 301, 'rank-math'),
      row(5, '/ok/', '/fine/'),
    ])
    expect(r.map.rules.map((x) => x.from)).toEqual(['/ok/'])
    expect(r.stats.dropped.loops).toBe(4)
  })

  it('a loop through a derived rule is dropped too', () => {
    const r = build([article('new', 'https://old.example.test/old/')], [row(1, '/reports/new/', '/old/')])
    expect(r.map.rules).toEqual([])
    expect(r.stats.dropped.loops).toBe(2)
  })

  it('details carry the rule labels, the counts carry none', () => {
    const r = build([], [row(1, '/a/', '/b/'), row(2, '/b/', '/a/')])
    expect(r.details.join('\n')).toMatch(/dropped \(loop\): rule #1/)
    expect(JSON.stringify(r.stats)).not.toContain('/a/')
  })
})

describe('chains are flattened and no emitted rule is ever a chain', () => {
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
    expectNoChains(r.map.rules)
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
  it('becomes temporary when any hop is temporary', () => {
    const r = build([], [row(1, '/a/', '/b/', 301, 'rank-math'), row(2, '/b/', '/c/', 302)])
    expect(byFrom(r.map.rules)['/a/']).toMatchObject({ to: '/c/', status: 302 })
  })

  it('a rule whose target is a 410 address becomes a 410 itself (the host rejects a 301 into a 410)', () => {
    const r = build([], [
      row(1, '/x/', '/g/', 301, 'rank-math'),
      row(2, '/g/', null, 410),
      row(3, '/y/', '/x/', 302, 'rank-math'), // two hops to a gone address
    ])
    const rules = byFrom(r.map.rules)
    expect(rules['/x/']).toEqual({ from: '/x/', to: null, status: 410, source: 'rank-math' })
    expect(rules['/y/']).toEqual({ from: '/y/', to: null, status: 410, source: 'rank-math' })
    expect(rules['/g/']).toMatchObject({ status: 410 })
    expect(r.stats.flattenedToGone).toBe(2)
    expectNoChains(r.map.rules)
  })

  it('a derived rule pointing at a gone staff address becomes a 410', () => {
    // the staff row sits on the article path of the derived rule's target
    const r = build([article('s', 'https://old.example.test/old/')], [row(1, '/reports/s/', null, 410)])
    expect(byFrom(r.map.rules)['/old/']).toMatchObject({ to: null, status: 410, source: 'legacy-url' })
    expectNoChains(r.map.rules)
  })

  it('drops an absolute target whose path is another rule address (a chain when it is the public host own origin)', () => {
    const r = build([], [row(1, '/a/', 'https://www.example.test/b/'), row(2, '/b/', '/c/'), row(3, '/ok/', 'https://www.example.test/free/')])
    expect(r.map.rules.map((x) => x.from)).toEqual(['/b/', '/ok/'])
    expect(r.stats.dropped.absoluteChain).toBe(1)
    expectNoChains(r.map.rules)
  })
})

describe('size caps refuse (with a code, no address), never truncate', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => row(i + 1, `/p${i}/`, '/'))
  it('refuses above the rule cap, and accepts exactly the cap', () => {
    const err = refused(() => build([], many(4), { limits: { maxRules: 3 } }))
    expect(err.code).toBe('too-many-rules')
    expect(err.message).toMatch(/4 rules; the limit is 3/)
    expect(errorCode(err)).toBe('too-many-rules')
    expect(build([], many(3), { limits: { maxRules: 3 } }).map.count).toBe(3)
  })
  it('refuses above the byte cap', () => {
    const r = build([], many(3))
    const err = refused(() => build([], many(3), { limits: { maxBytes: r.bytes - 1 } }))
    expect(err.code).toBe('too-large')
    expect(build([], many(3), { limits: { maxBytes: r.bytes } }).bytes).toBe(r.bytes)
  })
  it('the defaults are 20,000 rules and 5 MB', async () => {
    const m = await import('../../src/lib/redirectMap')
    expect(m.MAX_RULES).toBe(20_000)
    expect(m.MAX_BYTES).toBe(5 * 1024 * 1024)
    expect(refused(() => build([], many(20_001))).message).toMatch(/20001 rules; the limit is 20000/)
  })
})

describe('every emitted rule passes the public host own validator (copy in tests/fixtures/publicHostValidator.mjs)', () => {
  const hostOptions = { allowedHosts: ['www.example.test'], siteUrl: 'https://www.example.test' } as never

  it('a varied list: derived, manual, rank-math, gone, external, flattened, Unicode and encoded paths', () => {
    const r = build(
      [
        article('first', 'https://old.example.test/2019/05/old-first/', 'published', 1),
        article('second', 'https://old.example.test/caf%c3%a9-story', 'published', 2),
        article('third', 'https://old.example.test/café-nfd/', 'published', 3),
        article('dup', 'https://old.example.test/old-first', 'published', 4),
      ],
      [
        row(1, '/manual/', '/reports/first/'),
        row(2, '/retired/', null, 410),
        row(3, '/rm-chain/', '/old-first/', 301, 'rank-math'),
        row(4, '/rm-gone/', '/retired/', 301, 'rank-math'),
        row(5, '/external/', 'https://www.example.test/landing/'),
        row(6, '/it%27s/', '/'),
        row(7, '/loop-a/', '/loop-b/'),
        row(8, '/loop-b/', '/loop-a/'),
        row(9, '/%C3%BCn%C3%AF/', '/'),
      ],
    )
    expect(r.map.count).toBeGreaterThan(5)
    expectNoChains(r.map.rules)
    const compiled = compileRedirectMap(JSON.parse(r.body), hostOptions)
    expect(compiled.size).toBe(r.map.count)
    expect(compiled.get('/rm-gone/')).toEqual({ status: 410, to: null })
  })

  it('the host rejects what a naive generator would emit, so the check is real', () => {
    const body = (rules: unknown[]) => ({ version: 'sha256:x', generatedAt: '2026-10-16T00:00:00Z', count: rules.length, rules })
    const chain = body([
      { from: '/a/', to: '/b/', status: 301, source: 'manual' },
      { from: '/b/', to: '/c/', status: 301, source: 'manual' },
    ])
    expect(() => compileRedirectMap(chain, hostOptions)).toThrow(/chains/)
    const intoGone = body([
      { from: '/a/', to: '/g/', status: 301, source: 'manual' },
      { from: '/g/', to: null, status: 410, source: 'manual' },
    ])
    expect(() => compileRedirectMap(intoGone, hostOptions)).toThrow(/chains/)
    expect(() => compileRedirectMap(body([{ from: '/a%2Fb/', to: '/c/', status: 301, source: 'manual' }]), hostOptions)).toThrow()
  })
})

describe('checkAddresses (counts only; looked up the way the public host will)', () => {
  const rules: RedirectRule[] = [
    { from: '/a/', to: '/x/', status: 301, source: 'manual' },
    { from: '/t/', to: '/y/', status: 302, source: 'manual' },
    { from: '/g/', to: null, status: 410, source: 'manual' },
    { from: '/caf%C3%A9/', to: '/z/', status: 301, source: 'manual' },
    { from: '/it%27s/', to: '/z/', status: 301, source: 'manual' },
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

  it('applies the single normalisation: trailing slash, upper-case hex, raw Unicode, NFD, apostrophes, fragments', () => {
    const lines = ['/a', '/caf%c3%a9', '/café', '/cafe%CC%81', "/it's", '/it%27s?x=1#frag', 'https://old.example.test/A', '/a%2Fb']
    const summary = checkAddresses(lines, rules, new Set())
    expect(summary.resolved).toBe(6)
    expect(summary.unresolvedBy).toEqual({ invalid: 1, queryOnly: 0, noRule: 1 }) // /a%2Fb is junk, /A has no rule (case-sensitive)
  })
})

describe('findWriteConflict (logic over a fake lookup; the database version is covered by the integration tests)', () => {
  const stored: StoredRow[] = [
    row(1, '/b/', '/c/', 301, 'manual'),
    row(2, '/gone/', null, 410),
    row(3, '/m/', '/n/', 301, 'rank-math'),
    row(4, '/points-at-gone/', '/gone/', 301, 'manual'),
    row(5, '/ext/', 'https://www.example.test/x/', 301, 'manual'),
  ]
  const lookup = (derived: Record<string, { to: string; label: string }> = {}, articles: Record<string, string> = {}): RuleLookup => ({
    storedFrom: async (p) => stored.find((r) => r.from === p) ?? null,
    storedTo: async (p) => stored.filter((r) => r.to === p && r.source === 'manual'),
    derivedFrom: async (p) => (derived[p] ? { from: p, to: derived[p].to, status: 301, source: 'legacy-url', label: derived[p].label } : null),
    articleAt: async (p) => articles[p] ?? null,
  })
  const cand = (from: string, to: string | null, status: 301 | 302 | 410 = 301, source: 'manual' | 'rank-math' | 'legacy-url' = 'manual') => ({
    from,
    to,
    status,
    source,
  })
  const derivedOld = { '/old/': { to: '/reports/s/', label: 'derived rule from article "s"' } }

  it('accepts a plain new rule', async () => {
    expect(await findWriteConflict(cand('/new/', '/dest/'), lookup())).toBeNull()
  })
  it('refuses a self-loop, a two-rule loop and a longer loop, naming the rule', async () => {
    expect(await findWriteConflict(cand('/a/', '/a/'), lookup())).toMatch(/Loop/)
    expect(await findWriteConflict(cand('/c/', '/b/'), lookup())).toMatch(/Loop: .* and rule #1/)
    expect(await findWriteConflict(cand('/n/', '/a/', 301, 'rank-math'), lookup({ '/a/': { to: '/m/', label: 'derived rule from article "x"' } }))).toMatch(/Loop/)
    expect(await findWriteConflict(cand('/n/', '/m/', 301, 'rank-math'), lookup())).toMatch(/Loop/)
  })
  it('refuses a manual row that chains, in both directions, naming the other rule', async () => {
    expect(await findWriteConflict(cand('/a/', '/b/'), lookup())).toMatch(/Chain: .*#1/)
    expect(await findWriteConflict(cand('/c/', '/d/'), lookup())).toMatch(/Chain: rule #1/)
  })
  it('lets rank-math rows chain (flattened at generation) but not manual rows through them', async () => {
    expect(await findWriteConflict(cand('/a/', '/b/', 301, 'rank-math'), lookup())).toBeNull()
    expect(await findWriteConflict(cand('/a/', '/m/'), lookup())).toMatch(/Chain/)
  })
  it('treats a gone (410) target as a chain: a manual row must be a 410 itself; imported rows are converted at generation', async () => {
    expect(await findWriteConflict(cand('/a/', '/gone/'), lookup())).toMatch(/Chain: .*which is gone. Make this row a 410/)
    expect(await findWriteConflict(cand('/a/', '/gone/', 301, 'rank-math'), lookup())).toBeNull()
    expect(await findWriteConflict(cand('/a/', null, 410), lookup())).toBeNull()
    // a 410 placed on the address a manual row points at
    expect(await findWriteConflict(cand('/c/', null, 410), lookup())).toMatch(/Chain: rule #1 .* gone address/)
  })
  it('refuses a duplicate address and the live address of a published article', async () => {
    expect(await findWriteConflict(cand('/b/', '/z/'), lookup())).toMatch(/already exists: rule #1/)
    expect(await findWriteConflict(cand('/reports/s/', '/z/'), lookup({}, { '/reports/s/': 's' }))).toMatch(/published article "s"/)
  })
  it('a manual row may override a derived rule; other sources may not', async () => {
    expect(await findWriteConflict(cand('/old/', '/z/'), lookup(derivedOld))).toBeNull()
    expect(await findWriteConflict(cand('/old/', '/z/', 301, 'rank-math'), lookup(derivedOld))).toMatch(/derived rule from article "s"/)
  })
  it('refuses a manual row that points at a derived rule (chain)', async () => {
    expect(await findWriteConflict(cand('/a/', '/old/'), lookup(derivedOld))).toMatch(/Chain: .*derived rule from article "s"/)
  })
  it('refuses a manual absolute target whose path is itself a rule', async () => {
    expect(await findWriteConflict(cand('/a/', 'https://www.example.test/b/'), lookup())).toMatch(/Chain: .*itself a rule/)
    expect(await findWriteConflict(cand('/a/', 'https://www.example.test/free/'), lookup())).toBeNull()
  })
})
