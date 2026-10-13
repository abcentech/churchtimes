import { describe, expect, it } from 'vitest'

import { computeContentHash } from '../../src/lib/submissionHash'

const base = { email: 'ada@example.com', title: 'Church opens clinic', body: 'The church opened a clinic.' }

describe('computeContentHash', () => {
  it('is a stable sha256 hex digest', () => {
    expect(computeContentHash(base)).toMatch(/^[0-9a-f]{64}$/)
    expect(computeContentHash(base)).toBe(computeContentHash({ ...base }))
  })
  it('ignores email case, surrounding/collapsed whitespace and case in title/body', () => {
    expect(
      computeContentHash({
        email: ' ADA@Example.com ',
        title: '  church   OPENS clinic ',
        body: 'The church\nopened   a CLINIC.',
      }),
    ).toBe(computeContentHash(base))
  })
  it('changes when the email, title or body changes', () => {
    const h = computeContentHash(base)
    expect(computeContentHash({ ...base, email: 'bob@example.com' })).not.toBe(h)
    expect(computeContentHash({ ...base, title: 'Other title' })).not.toBe(h)
    expect(computeContentHash({ ...base, body: 'A different story.' })).not.toBe(h)
  })
  it('does not let field boundaries blur', () => {
    expect(computeContentHash({ email: 'a@b.co', title: 'xy', body: 'z' })).not.toBe(
      computeContentHash({ email: 'a@b.co', title: 'x', body: 'yz' }),
    )
  })
})
