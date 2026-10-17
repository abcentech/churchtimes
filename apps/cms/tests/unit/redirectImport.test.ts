import { describe, expect, it } from 'vitest'

import { parseFlags } from '../../src/lib/redirectCli'
import { parseRedirectCsv, planRedirectImport } from '../../src/lib/redirectImport'
import type { RedirectRule, StoredRow } from '../../src/lib/redirectMap'

const rows = (text: string) => {
  const parsed = parseRedirectCsv(text)
  if ('error' in parsed) throw new Error(parsed.error)
  return parsed.rows
}
const base = {
  existing: [] as StoredRow[],
  derived: [] as RedirectRule[],
  livePaths: new Set<string>(),
  allowedHosts: ['www.example.test'],
}

describe('parseRedirectCsv', () => {
  it('reads from,to,status with CRLF, BOM, quotes and blank lines', () => {
    const r = rows('﻿from,to,status\r\n/a,/b/,301\r\n\r\n"/c,d","/e/",302\r\n/f,,410')
    expect(r).toEqual([
      { from: '/a', to: '/b/', status: '301' },
      { from: '/c,d', to: '/e/', status: '302' },
      { from: '/f', to: '', status: '410' },
    ])
  })
  it('handles doubled quotes and quoted newlines', () => {
    expect(rows('from,to\n"/a""b","/x\n/y"')).toEqual([{ from: '/a"b', to: '/x\n/y' }])
  })
  it('is case-insensitive about the header, ignores extra columns, and reports a missing column or a bad file', () => {
    expect(rows('From,TO,Notes\n/a,/b/,hi')[0]).toMatchObject({ from: '/a', to: '/b/' })
    expect(parseRedirectCsv('url,target\n/a,/b/')).toHaveProperty('error')
    expect(parseRedirectCsv('')).toHaveProperty('error')
    expect(parseRedirectCsv('from,to\n"/a,/b/')).toHaveProperty('error')
  })
})

describe('planRedirectImport', () => {
  const plan = (csv: string, extra: Partial<typeof base> = {}) =>
    planRedirectImport({ ...base, ...extra, rows: rows(csv) })

  it('accepts exact rows, normalises them, defaults the status and treats a 410 as target-less', () => {
    const p = plan('from,to,status\n/Old,/new,\n/caf%c3%a9,/x/,302\n/gone,,410')
    expect(p.accepted).toEqual([
      { from: '/Old/', to: '/new/', status: 301 },
      { from: '/caf%C3%A9/', to: '/x/', status: 302 },
      { from: '/gone/', to: null, status: 410 },
    ])
    expect(p.counts.accepted).toBe(3)
  })

  it('counts invalid rows and patterns by reason without keeping any address', () => {
    const p = plan(
      [
        'from,to,status',
        '/cat/*,/x/,301',
        'not-a-path,/x/,301',
        '/a/../b,/x/,301',
        '/ok1,https://evil.example.test/,301',
        '/ok2,,301',
        '/ok3,/x/,307',
        '/ok4,/x/,301',
      ].join('\n'),
    )
    expect(p.counts.invalid).toEqual({ from: 2, to: 2, status: 1, pattern: 1 })
    expect(p.counts.accepted).toBe(1)
    expect(JSON.stringify(p.counts)).not.toContain('/ok')
  })

  it('skips duplicates in the file, rows already stored, rows an article rule owns and live article addresses', () => {
    const p = plan('from,to\n/a,/x/\n/a/,/y/\n/stored,/x/\n/owned,/x/\n/reports/live,/x/', {
      existing: [{ id: 1, from: '/stored/', to: '/z/', status: 301, source: 'manual' }],
      derived: [{ from: '/owned/', to: '/reports/o/', status: 301, source: 'legacy-url' }],
      livePaths: new Set(['/reports/live/']),
    })
    expect(p.accepted.map((r) => r.from)).toEqual(['/a/'])
    expect(p.counts).toMatchObject({ duplicateInFile: 1, alreadyStored: 1, conflictsWithDerived: 1, shadowsArticle: 1 })
  })

  it('rejects loops (within the file, and through stored or derived rules) but allows chains', () => {
    const p = plan('from,to\n/a,/b/\n/b,/a/\n/c,/d/\n/d,/e/\n/self,/self/\n/p,/q/', {
      existing: [{ id: 1, from: '/q/', to: '/p/', status: 301, source: 'manual' }],
    })
    expect(p.accepted.map((r) => r.from)).toEqual(['/a/', '/c/', '/d/'])
    expect(p.counts.loops).toBe(3) // /b, /self, /p
  })
})

describe('planRedirectImport: gone targets, absolute targets and the row cap', () => {
  const plan = (csv: string, extra: Partial<typeof base> = {}) => planRedirectImport({ ...base, ...extra, rows: rows(csv) })
  const existing: StoredRow[] = [{ id: 1, from: '/gone/', to: null, status: 410, source: 'manual' }]

  it('writes a row whose target is a gone address as a 410 (a 301 into a 410 would make the host reject the list)', () => {
    const p = plan('from,to\n/a,/gone/\n/b,/a/\n/c,/free/', { existing })
    expect(p.accepted).toEqual([
      { from: '/a/', to: null, status: 410 },
      { from: '/b/', to: null, status: 410 }, // follows the converted row
      { from: '/c/', to: '/free/', status: 301 },
    ])
    expect(p.counts.convertedToGone).toBe(2)
    expect(p.counts.accepted).toBe(3)
  })

  it('skips an absolute target whose path is another rule address', () => {
    const p = plan('from,to\n/a,https://www.example.test/gone/\n/b,https://www.example.test/free/', { existing })
    expect(p.accepted.map((r) => r.from)).toEqual(['/b/'])
    expect(p.counts.absoluteChain).toBe(1)
  })

  it('caps the file at the list cap of 20,000 rows', async () => {
    const m = await import('../../src/lib/redirectImport')
    expect(m.IMPORT_MAX_ROWS).toBe(20_000)
  })
})

describe('parseFlags', () => {
  it('reads --flag value, --flag=value and bare flags', () => {
    expect(parseFlags(['--', '--out', 'f.json', '--apply', '--file=x.csv'])).toEqual({ out: 'f.json', apply: true, file: 'x.csv' })
    expect(parseFlags(['--apply', '--urls', 'u.txt'])).toEqual({ apply: true, urls: 'u.txt' })
  })
})
