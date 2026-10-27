import { describe, expect, it } from 'vitest'

import { parseMailchimpTime, planMailchimpImport } from '../../src/lib/subscriberImport'

const now = new Date('2026-10-22T00:00:00Z')

describe('parseMailchimpTime', () => {
  it('accepts exactly YYYY-MM-DD HH:MM:SS as UTC', () => {
    expect(parseMailchimpTime('2024-03-01 09:30:00', now)).toBe('2024-03-01T09:30:00.000Z')
    expect(parseMailchimpTime(' 2024-03-01 09:30:00 ', now)).toBe('2024-03-01T09:30:00.000Z')
  })
  it('treats every other shape, impossible dates and the future as no time', () => {
    for (const v of [
      '2024-03-01T09:30:00Z',
      '2024-03-01T09:30:00',
      '2024-03-01 09:30:00+01:00',
      '2024-03-01',
      '03/01/2024 09:30',
      'March 1, 2024',
      '2024-02-31 10:00:00',
      '2024-03-01 25:00:00',
      '2999-01-01 00:00:00',
      '',
      undefined,
    ]) {
      expect(parseMailchimpTime(v, now), String(v)).toBeUndefined()
    }
  })
})

describe('planMailchimpImport', () => {
  const csv = (rows: string[]) => ['Email Address,OPTIN_TIME,CONFIRM_TIME,Status', ...rows].join('\n')
  it('takes confirmedAt only from CONFIRM_TIME, never from OPTIN_TIME', () => {
    const { candidates } = planMailchimpImport(csv(['a@example.test,2024-01-01 00:00:00,,subscribed']), { now })
    expect(candidates[0]).toMatchObject({ consentAt: '2024-01-01T00:00:00.000Z' })
    expect(candidates[0]!.confirmedAt).toBeUndefined()
  })
  it('maps unsubscribed and cleaned rows to blocking kinds', () => {
    const { candidates, counts } = planMailchimpImport(csv(['a@example.test,,,unsubscribed', 'b@example.test,,,cleaned', 'c@example.test,,,pending']), { now })
    expect(candidates.map((c) => c.kind)).toEqual(['unsubscribed', 'bounced'])
    expect(counts.skippedNotSubscribed).toBe(1)
  })
})
