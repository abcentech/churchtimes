import { createHash } from 'node:crypto'

/** SYNTHETIC `archive-candidate/1` lines for tests and the schema doc. Invented titles, `.test` hosts. */
export const sha = (s: string): string => createHash('sha256').update(s).digest('hex')

export function candidate(over: Record<string, unknown> = {}, n = 1): Record<string, unknown> {
  return {
    schema: 'archive-candidate/1',
    title: `Synthetic recovered story ${n}`,
    byline: 'Staff Reporter',
    date: '2014-03-09',
    bodyHtml: `<p>Synthetic paragraph one for story ${n}.</p><p>Second paragraph with a <a href="https://example.test/ref">link</a>.</p>`,
    originalUrl: `https://old-site.test/2014/03/synthetic-story-${n}/`,
    canonicalUrl: null,
    host: 'old-site.test',
    captureTimestamp: '2020-01-15T10:20:30Z',
    rawSha256: sha(`raw-${n}`),
    media: [],
    confidence: 'partial',
    reviewer: { assignee: null, notes: null },
    ...over,
  }
}

export const jsonl = (rows: unknown[]): string => rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n'
