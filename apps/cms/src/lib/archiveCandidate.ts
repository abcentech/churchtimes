import { PROVENANCE_CONFIDENCE, type ProvenanceConfidence } from './provenance'

/**
 * `archive-candidate/1`: one JSON object per line, produced outside this repository from recovered web captures and
 * read by `npm run import:archive-candidates`. Pure validation, no I/O. The specification is
 * docs/archive-candidate-schema.md; this file is its executable form.
 *
 * Strict by design: unknown keys, wrong types, over-long values, non-http(s) addresses and any script content reject the
 * line (counted by a fixed reason code, never echoed). The confidence is `partial`, `citation-only` or `missing`;
 * `verified-full` does not exist in this version and is refused.
 */
export const ARCHIVE_CANDIDATE_SCHEMA = 'archive-candidate/1'

export const LIMITS = {
  /** Bytes of one JSONL line. */
  lineBytes: 3_000_000,
  title: 240,
  byline: 200,
  bodyHtml: 1_000_000,
  url: 2000,
  host: 253,
  media: 200,
  mediaMime: 100,
  mediaAlt: 300,
  reviewerAssignee: 120,
  reviewerNotes: 1000,
} as const

export type ArchiveMediaRef = { url: string; localSha256: string | null; mime: string | null; alt: string | null }

export type ArchiveCandidate = {
  schema: typeof ARCHIVE_CANDIDATE_SCHEMA
  title: string
  byline: string | null
  /** `YYYY-MM-DD` or a full ISO 8601 date-time; null when unknown. */
  date: string | null
  bodyHtml: string
  originalUrl: string
  canonicalUrl: string | null
  host: string
  /** Normalised to a UTC ISO string. */
  captureTimestamp: string
  rawSha256: string
  media: ArchiveMediaRef[]
  confidence: ProvenanceConfidence
  reviewer: { assignee: string | null; notes: string | null }
}

export type ValidationResult = { ok: true; value: ArchiveCandidate } | { ok: false; reason: string }

const TOP_KEYS = new Set([
  'schema', 'title', 'byline', 'date', 'bodyHtml', 'originalUrl', 'canonicalUrl', 'host', 'captureTimestamp', 'rawSha256', 'media', 'confidence', 'reviewer',
])
const REQUIRED_KEYS = ['title', 'bodyHtml', 'originalUrl', 'host', 'captureTimestamp', 'rawSha256', 'confidence', 'media']
const MEDIA_KEYS = new Set(['url', 'localSha256', 'mime', 'alt'])
const REVIEWER_KEYS = new Set(['assignee', 'notes'])
const SHA256_RE = /^[0-9a-f]{64}$/
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]/
const SCRIPT_RE = /<\s*\/?\s*script\b|javascript\s*:|vbscript\s*:|data\s*:\s*text\/html/i
const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,60}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,60}$/i

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The address as a URL when it is http or https, has a host, no credentials and no control characters or spaces; else null. */
export function parseHttpUrl(raw: unknown, max: number = LIMITS.url): URL | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > max || CONTROL_RE.test(raw) || /\s/.test(raw)) return null
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (!u.hostname || u.username || u.password) return null
  return u
}

/** Key for "the same page": scheme folded, host lower-case, `www.` and default port dropped, fragment and trailing slash dropped. */
export function normaliseSourceUrl(raw: string): string {
  const u = new URL(raw)
  const host = u.hostname.toLowerCase().replace(/^www\./, '')
  const pathname = u.pathname.replace(/\/+$/, '')
  const port = u.port && u.port !== '80' && u.port !== '443' ? `:${u.port}` : ''
  return `${host}${port}${pathname}${u.search}`
}

/** Normalised title for duplicate detection: Unicode-folded, lower-case, letters and digits only. */
export const normaliseTitle = (t: string): string =>
  t.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

type Err = { err: string }
const isErr = (v: unknown): v is Err => isObj(v) && typeof (v as { err?: unknown }).err === 'string'

function text(v: unknown, max: number, nullable: boolean, code: string): string | null | Err {
  if (v === null) return nullable ? null : { err: `${code}-null` }
  if (typeof v !== 'string') return { err: `${code}-type` }
  const s = v.normalize('NFC').trim()
  if (s.length === 0) return nullable ? null : { err: `${code}-empty` }
  if (s.length > max) return { err: `${code}-too-long` }
  if (CONTROL_RE.test(s) || /[<>]/.test(s)) return { err: `${code}-bad-chars` }
  return s
}

/** A date or date-time that exists on the calendar (no 2021-02-31) as an ISO string, else null. */
export function parseCandidateDate(s: string): string | null {
  if (DATE_ONLY_RE.test(s)) {
    const d = new Date(`${s}T00:00:00.000Z`)
    return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : d.toISOString()
  }
  if (!DATETIME_RE.test(s)) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** Validate one parsed JSON value against `archive-candidate/1`. `now` bounds capture timestamps (not in the future). */
export function validateCandidate(input: unknown, now: number = Date.now()): ValidationResult {
  const no = (reason: string): ValidationResult => ({ ok: false, reason })
  if (!isObj(input)) return no('not-an-object')
  if (input.schema !== ARCHIVE_CANDIDATE_SCHEMA) return no('schema-version')
  for (const k of Object.keys(input)) if (!TOP_KEYS.has(k)) return no('unknown-field')
  for (const k of REQUIRED_KEYS) if (!(k in input)) return no(`missing-${k}`)

  const title = text(input.title, LIMITS.title, false, 'title')
  if (isErr(title)) return no(title.err)

  const byline = 'byline' in input ? text(input.byline, LIMITS.byline, true, 'byline') : null
  if (isErr(byline)) return no(byline.err)

  let date: string | null = null
  if ('date' in input && input.date !== null) {
    if (typeof input.date !== 'string') return no('date-type')
    if (parseCandidateDate(input.date) === null) return no('date-invalid')
    date = input.date
  }

  const body = input.bodyHtml
  if (typeof body !== 'string') return no('bodyHtml-type')
  if (body.trim().length === 0) return no('bodyHtml-empty')
  if (body.length > LIMITS.bodyHtml) return no('bodyHtml-too-long')
  if (SCRIPT_RE.test(body)) return no('bodyHtml-script')

  const original = parseHttpUrl(input.originalUrl)
  if (!original) return no('originalUrl-invalid')
  let canonicalUrl: string | null = null
  if ('canonicalUrl' in input && input.canonicalUrl !== null) {
    if (!parseHttpUrl(input.canonicalUrl)) return no('canonicalUrl-invalid')
    canonicalUrl = input.canonicalUrl as string
  }

  if (typeof input.host !== 'string' || input.host.length > LIMITS.host) return no('host-invalid')
  if (input.host !== original.hostname.toLowerCase()) return no('host-mismatch')

  const capRaw = input.captureTimestamp
  const cap = typeof capRaw === 'string' && DATETIME_RE.test(capRaw) ? parseCandidateDate(capRaw) : null
  if (!cap) return no('captureTimestamp-invalid')
  if (Date.parse(cap) > now + 24 * 3600_000) return no('captureTimestamp-future')

  if (typeof input.rawSha256 !== 'string' || !SHA256_RE.test(input.rawSha256)) return no('rawSha256-invalid')

  if (input.confidence === 'verified-full') return no('confidence-verified-full')
  if (!(PROVENANCE_CONFIDENCE as readonly unknown[]).includes(input.confidence)) return no('confidence-invalid')

  if (!Array.isArray(input.media)) return no('media-type')
  if (input.media.length > LIMITS.media) return no('media-too-many')
  const media: ArchiveMediaRef[] = []
  for (const m of input.media as unknown[]) {
    if (!isObj(m)) return no('media-item-type')
    for (const k of Object.keys(m)) if (!MEDIA_KEYS.has(k)) return no('media-unknown-field')
    if (!parseHttpUrl(m.url)) return no('media-url-invalid')
    const sha = m.localSha256 ?? null
    if (sha !== null && (typeof sha !== 'string' || !SHA256_RE.test(sha))) return no('media-sha256-invalid')
    const mime = m.mime ?? null
    if (mime !== null && (typeof mime !== 'string' || !MIME_RE.test(mime))) return no('media-mime-invalid')
    const alt = m.alt === undefined ? null : text(m.alt, LIMITS.mediaAlt, true, 'media-alt')
    if (isErr(alt)) return no(alt.err)
    media.push({ url: m.url as string, localSha256: sha as string | null, mime: mime as string | null, alt })
  }

  let reviewer: ArchiveCandidate['reviewer'] = { assignee: null, notes: null }
  if ('reviewer' in input && input.reviewer !== null) {
    if (!isObj(input.reviewer)) return no('reviewer-type')
    for (const k of Object.keys(input.reviewer)) if (!REVIEWER_KEYS.has(k)) return no('reviewer-unknown-field')
    const assignee = input.reviewer.assignee === undefined ? null : text(input.reviewer.assignee, LIMITS.reviewerAssignee, true, 'reviewer')
    const notes = input.reviewer.notes === undefined ? null : text(input.reviewer.notes, LIMITS.reviewerNotes, true, 'reviewer')
    if (isErr(assignee)) return no(assignee.err)
    if (isErr(notes)) return no(notes.err)
    reviewer = { assignee, notes }
  }

  return {
    ok: true,
    value: {
      schema: ARCHIVE_CANDIDATE_SCHEMA,
      title: title as string,
      byline,
      date,
      bodyHtml: body,
      originalUrl: input.originalUrl as string,
      canonicalUrl,
      host: input.host,
      captureTimestamp: cap,
      rawSha256: input.rawSha256,
      media,
      confidence: input.confidence as ProvenanceConfidence,
      reviewer,
    },
  }
}

/** Parse one JSONL line (size-checked) and validate it. */
export function validateLine(line: string, now?: number): ValidationResult {
  if (Buffer.byteLength(line, 'utf8') > LIMITS.lineBytes) return { ok: false, reason: 'line-too-long' }
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return { ok: false, reason: 'invalid-json' }
  }
  return validateCandidate(parsed, now)
}
