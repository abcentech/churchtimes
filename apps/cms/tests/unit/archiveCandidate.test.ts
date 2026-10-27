import { describe, expect, it } from 'vitest'

import { LIMITS, normaliseSourceUrl, normaliseTitle, parseCandidateDate, parseHttpUrl, validateCandidate, validateLine } from '../../src/lib/archiveCandidate'
import { urlVariants } from '../../src/import/archiveCandidates'
import { parseArchiveArgs } from '../../src/import/archiveCli'
import { publishBlockedByProvenance } from '../../src/lib/provenance'
import { candidate, sha } from '../fixtures/archive/candidates'

const NOW = Date.parse('2026-10-23T00:00:00Z')
const reason = (over: Record<string, unknown>): string | null => {
  const r = validateCandidate(candidate(over), NOW)
  return r.ok ? null : r.reason
}

describe('archive-candidate/1 validator', () => {
  it('accepts a complete synthetic candidate and normalises the capture time', () => {
    const r = validateCandidate(candidate({ captureTimestamp: '2020-01-15T11:20:30+01:00' }), NOW)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.captureTimestamp).toBe('2020-01-15T10:20:30.000Z')
  })

  it('accepts null byline, date, canonical and reviewer, and optional keys left out', () => {
    const c = candidate({ byline: null, date: null, canonicalUrl: null, reviewer: null })
    expect(validateCandidate(c, NOW).ok).toBe(true)
    const minimal = candidate()
    delete minimal.byline
    delete minimal.date
    delete minimal.canonicalUrl
    delete minimal.reviewer
    expect(validateCandidate(minimal, NOW).ok).toBe(true)
  })

  it('requires the schema version and refuses unknown fields', () => {
    expect(reason({ schema: 'archive-candidate/2' })).toBe('schema-version')
    expect(reason({ schema: undefined })).toBe('schema-version')
    expect(reason({ extra: 1 })).toBe('unknown-field')
    expect(validateCandidate('x', NOW)).toEqual({ ok: false, reason: 'not-an-object' })
    expect(validateCandidate([], NOW)).toEqual({ ok: false, reason: 'not-an-object' })
  })

  it('requires the mandatory fields', () => {
    for (const k of ['title', 'bodyHtml', 'originalUrl', 'host', 'captureTimestamp', 'rawSha256', 'confidence', 'media']) {
      const c = candidate()
      delete c[k]
      expect(validateCandidate(c, NOW)).toEqual({ ok: false, reason: `missing-${k}` })
    }
  })

  it('never accepts verified-full and allows only the three confidences', () => {
    expect(reason({ confidence: 'verified-full' })).toBe('confidence-verified-full')
    expect(reason({ confidence: 'high' })).toBe('confidence-invalid')
    for (const c of ['partial', 'citation-only', 'missing']) expect(reason({ confidence: c })).toBeNull()
  })

  it('accepts http and https addresses only, without credentials', () => {
    for (const bad of ['javascript:alert(1)', 'ftp://old-site.test/a', 'file:///etc/passwd', 'data:text/html,x', '//old-site.test/a', 'https://u:p@old-site.test/a', 'https://old-site.test/a b', 'not a url', '']) {
      expect(parseHttpUrl(bad), bad).toBeNull()
    }
    expect(parseHttpUrl('http://old-site.test/a')).not.toBeNull()
    expect(reason({ originalUrl: 'ftp://old-site.test/x', host: 'old-site.test' })).toBe('originalUrl-invalid')
    expect(reason({ canonicalUrl: 'javascript:1' })).toBe('canonicalUrl-invalid')
    expect(reason({ originalUrl: `https://old-site.test/${'a'.repeat(LIMITS.url)}` })).toBe('originalUrl-invalid')
  })

  it('requires host to equal the lower-case host of originalUrl', () => {
    expect(reason({ host: 'other.test' })).toBe('host-mismatch')
    expect(reason({ host: 'OLD-SITE.test' })).toBe('host-mismatch')
    expect(reason({ originalUrl: 'https://OLD-Site.test/x/', host: 'old-site.test' })).toBeNull()
  })

  it('checks sizes', () => {
    expect(reason({ title: 'a'.repeat(LIMITS.title) })).toBeNull()
    expect(reason({ title: 'a'.repeat(LIMITS.title + 1) })).toBe('title-too-long')
    expect(reason({ title: '   ' })).toBe('title-empty')
    expect(reason({ title: null })).toBe('title-null')
    expect(reason({ byline: 'b'.repeat(LIMITS.byline + 1) })).toBe('byline-too-long')
    expect(reason({ bodyHtml: '<p>' + 'x'.repeat(LIMITS.bodyHtml) })).toBe('bodyHtml-too-long')
    expect(reason({ bodyHtml: '  ' })).toBe('bodyHtml-empty')
    expect(reason({ media: Array.from({ length: LIMITS.media + 1 }, (_, i) => ({ url: `https://old-site.test/i${i}.jpg` })) })).toBe('media-too-many')
    expect(validateLine('x'.repeat(LIMITS.lineBytes + 1), NOW)).toEqual({ ok: false, reason: 'line-too-long' })
    expect(validateLine('{not json', NOW)).toEqual({ ok: false, reason: 'invalid-json' })
  })

  it('refuses markup in plain-text fields and control characters', () => {
    expect(reason({ title: 'A <b>bold</b> title' })).toBe('title-bad-chars')
    expect(reason({ byline: 'By <script>' })).toBe('byline-bad-chars')
    expect(reason({ title: 'Nul' + String.fromCharCode(0) + 'ed' })).toBe('title-bad-chars')
  })

  it('rejects scripts in the body, in any spelling', () => {
    for (const body of ['<p>x</p><script>alert(1)</script>', '<SCRIPT src=x>', '< script >', '<a href="javascript:alert(1)">x</a>', '<a href=" JavaScript :1">x</a>', '<iframe src="data:text/html,x">']) {
      expect(reason({ bodyHtml: body }), body).toBe('bodyHtml-script')
    }
    // Event handler attributes pass validation: the converter drops every attribute it does not know.
    expect(reason({ bodyHtml: '<p onclick="x()">hi</p>' })).toBeNull()
  })

  it('checks dates: real calendar days only, capture not in the future', () => {
    expect(parseCandidateDate('2014-03-09')).toBe('2014-03-09T00:00:00.000Z')
    expect(parseCandidateDate('2021-02-31')).toBeNull()
    expect(parseCandidateDate('2021-13-01')).toBeNull()
    expect(parseCandidateDate('09/03/2014')).toBeNull()
    expect(parseCandidateDate('2014-03-09T10:00:00')).toBeNull() // no zone
    expect(reason({ date: '2014-02-30' })).toBe('date-invalid')
    expect(reason({ date: 20140309 })).toBe('date-type')
    expect(reason({ captureTimestamp: '2020-01-15' })).toBe('captureTimestamp-invalid')
    expect(reason({ captureTimestamp: '2030-01-01T00:00:00Z' })).toBe('captureTimestamp-future')
  })

  it('checks hashes', () => {
    expect(reason({ rawSha256: 'ABC' })).toBe('rawSha256-invalid')
    expect(reason({ rawSha256: sha('x').toUpperCase() })).toBe('rawSha256-invalid')
    expect(reason({ rawSha256: 5 })).toBe('rawSha256-invalid')
  })

  it('checks media references', () => {
    const ok = { url: 'https://old-site.test/i.jpg', localSha256: sha('img'), mime: 'image/jpeg', alt: 'A synthetic photo' }
    expect(reason({ media: [ok, { url: 'http://cdn.test/y.png', localSha256: null }] })).toBeNull()
    expect(reason({ media: [{ ...ok, url: 'javascript:1' }] })).toBe('media-url-invalid')
    expect(reason({ media: [{ ...ok, localSha256: 'zz' }] })).toBe('media-sha256-invalid')
    expect(reason({ media: [{ ...ok, mime: 'not a mime' }] })).toBe('media-mime-invalid')
    expect(reason({ media: [{ ...ok, extra: 1 }] })).toBe('media-unknown-field')
    expect(reason({ media: ['x'] })).toBe('media-item-type')
    expect(reason({ media: 'x' })).toBe('media-type')
  })

  it('checks the reviewer placeholder', () => {
    expect(reason({ reviewer: { assignee: 'Desk A', notes: 'check the byline' } })).toBeNull()
    expect(reason({ reviewer: { status: 'reviewed' } })).toBe('reviewer-unknown-field')
    expect(reason({ reviewer: 'x' })).toBe('reviewer-type')
  })
})

describe('address and title normalisation', () => {
  it('treats scheme, www, trailing slash and fragment as the same page', () => {
    const a = normaliseSourceUrl('https://www.Old-Site.test/2014/a/#top')
    expect(normaliseSourceUrl('http://old-site.test/2014/a')).toBe(a)
    expect(normaliseSourceUrl('http://old-site.test/2014/b')).not.toBe(a)
    expect(normaliseSourceUrl('http://old-site.test/2014/a?p=1')).not.toBe(a)
  })

  it('produces a bounded list of address spellings for the database lookup', () => {
    const v = urlVariants('https://old-site.test/2014/a/')
    expect(v.length).toBeLessThanOrEqual(12)
    expect(v).toContain('http://www.old-site.test/2014/a')
    expect(v).toContain('https://old-site.test/2014/a/')
  })

  it('folds titles', () => {
    expect(normaliseTitle('Café  Opens - Today!')).toBe(normaliseTitle('cafe opens today'))
  })
})

describe('publish guard for unreviewed imports', () => {
  const imported = { importBatch: 'arc-1', reviewStatus: 'pending' }
  it('blocks published and scheduled while the import is not reviewed', () => {
    expect(publishBlockedByProvenance({ status: 'published' }, { status: 'draft', provenance: imported })).toBe(true)
    expect(publishBlockedByProvenance({ status: 'scheduled' }, { status: 'draft', provenance: imported })).toBe(true)
    expect(publishBlockedByProvenance({ status: 'published' }, { status: 'draft', provenance: { importBatch: 'arc-1', reviewStatus: 'rejected' } })).toBe(true)
    expect(publishBlockedByProvenance({ status: 'published' }, { status: 'draft', provenance: { importBatch: 'arc-1' } })).toBe(true)
    expect(publishBlockedByProvenance({ status: 'published', provenance: imported }, undefined)).toBe(true)
    // a PATCH that does not mention status on a stored published row still counts
    expect(publishBlockedByProvenance({ title: 'x' }, { status: 'published', provenance: imported })).toBe(true)
  })
  it('allows drafts, reviewed articles and ordinary articles', () => {
    expect(publishBlockedByProvenance({ status: 'draft' }, { status: 'draft', provenance: imported })).toBe(false)
    expect(publishBlockedByProvenance({ status: 'in_review' }, { status: 'draft', provenance: imported })).toBe(false)
    expect(publishBlockedByProvenance({ status: 'published' }, { status: 'draft', provenance: { ...imported, reviewStatus: 'reviewed' } })).toBe(false)
    expect(publishBlockedByProvenance({ status: 'published' }, { status: 'draft' })).toBe(false)
    expect(publishBlockedByProvenance({ status: 'published', provenance: { reviewStatus: 'pending' } }, undefined)).toBe(false)
  })
  it('judges the incoming review status together with the incoming status', () => {
    expect(publishBlockedByProvenance({ status: 'published', provenance: { reviewStatus: 'reviewed' } }, { status: 'draft', provenance: imported })).toBe(false)
    expect(publishBlockedByProvenance({ status: 'published', provenance: { reviewStatus: 'pending' } }, { status: 'draft', provenance: { ...imported, reviewStatus: 'reviewed' } })).toBe(true)
  })
})

describe('command arguments', () => {
  it('needs --file, defaults to a dry run, refuses unknown flags and missing values', () => {
    expect(parseArchiveArgs([])).toBeNull()
    expect(parseArchiveArgs(['--file'])).toBeNull()
    expect(parseArchiveArgs(['--file', '--apply'])).toBeNull()
    expect(parseArchiveArgs(['--file', 'a.jsonl', '--nonsense'])).toBeNull()
    expect(parseArchiveArgs(['--file', 'a.jsonl', '--manifest'])).toBeNull()
    expect(parseArchiveArgs(['--file', 'a.jsonl'])).toMatchObject({ file: 'a.jsonl', apply: false })
    expect(parseArchiveArgs(['--file', 'a.jsonl', '--apply', '--manifest', 'd', '--category', 'archive', '--batch', 'b1'])).toEqual({
      file: 'a.jsonl', apply: true, manifestDir: 'd', category: 'archive', batch: 'b1',
    })
  })
})
