/**
 * Pure helpers for go-live contract C3 (advertising). No Payload import, so they are unit tested and reusable by the
 * public endpoint, the collection hooks and the media access rule.
 */

export const PLACEMENTS = ['homepage-billboard', 'article-inline', 'mobile-banner'] as const
export type Placement = (typeof PLACEMENTS)[number]
export type Variant = 'desktop' | 'mobile'
export type Size = { width: number; height: number }

/** Exact creative sizes the public renderer accepts. `mobile-banner` has no desktop creative. */
export const PLACEMENT_SIZES: Record<Placement, Partial<Record<Variant, Size>>> = {
  'homepage-billboard': { desktop: { width: 970, height: 250 }, mobile: { width: 320, height: 100 } },
  'article-inline': { desktop: { width: 728, height: 90 }, mobile: { width: 320, height: 100 } },
  'mobile-banner': { mobile: { width: 320, height: 50 } },
}

/** Field names inside the `creatives` group (camelCase: column and API names), keyed by placement. */
export const PLACEMENT_FIELD: Record<Placement, 'homepageBillboard' | 'articleInline' | 'mobileBanner'> = {
  'homepage-billboard': 'homepageBillboard',
  'article-inline': 'articleInline',
  'mobile-banner': 'mobileBanner',
}

export const MAX_CREATIVE_BYTES = 500 * 1024
export const CREATIVE_MIME = ['image/jpeg', 'image/png', 'image/webp'] as const

export const CAMPAIGN_STATUSES = ['draft', 'pending_approval', 'approved', 'paused', 'cancelled'] as const
export const PAYMENT_STATUSES = ['unpaid', 'invoiced', 'paid', 'waived'] as const
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number]
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number]

export const MAX_CACHE_SECONDS = 60

/** `ADS_REQUIRE_PAYMENT` defaults to true: only the literal string `false` (any case) turns the gate off. */
export const requirePayment = (env: Record<string, string | undefined> = process.env): boolean =>
  (env.ADS_REQUIRE_PAYMENT ?? '').trim().toLowerCase() !== 'false'

export const paymentOk = (status: unknown, require: boolean): boolean =>
  !require || status === 'paid' || status === 'waived'

export const envFlag = (value: string | undefined): boolean => (value ?? '').trim().toLowerCase() === 'true'

/** Absolute https URL, no credentials, 1 to 500 characters. Returns the trimmed URL or null. */
export function normalizeDestinationUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const raw = value.trim()
  if (raw.length < 1 || raw.length > 500) return null
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s]/.test(raw)) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  if (url.username || url.password) return null
  if (!url.hostname) return null
  return raw
}

export const isAdTimestamp = (value: unknown): value is string | Date => {
  if (value instanceof Date) return !Number.isNaN(value.getTime())
  return typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Date.parse(value))
}

export const toMs = (value: unknown): number => (value instanceof Date ? value.getTime() : Date.parse(String(value)))

/** `startsAt <= now < endsAt` (start inclusive, end exclusive). */
export const inWindow = (startsAt: unknown, endsAt: unknown, nowMs: number): boolean =>
  isAdTimestamp(startsAt) && isAdTimestamp(endsAt) && toMs(startsAt) <= nowMs && nowMs < toMs(endsAt)

/**
 * Seconds a response may be cached: the smaller of 60 and the whole seconds (rounded DOWN, so a cache never outlives a
 * boundary) until the next start or end after `nowMs`. No upcoming boundary: 60.
 */
export function cacheSeconds(boundariesMs: number[], nowMs: number): number {
  let next = Infinity
  for (const b of boundariesMs) if (Number.isFinite(b) && b > nowMs && b < next) next = b
  if (next === Infinity) return MAX_CACHE_SECONDS
  return Math.max(0, Math.min(MAX_CACHE_SECONDS, Math.floor((next - nowMs) / 1000)))
}

/** Dimensions of a creative against the placement table. Returns a message or null. */
export function checkCreativeSize(
  placement: Placement,
  variant: Variant,
  media: { width?: number | null; height?: number | null },
): string | null {
  const expected = PLACEMENT_SIZES[placement][variant]
  if (!expected) return `${placement} has no ${variant} creative.`
  if (media.width !== expected.width || media.height !== expected.height) {
    return `${placement} ${variant} creative must be exactly ${expected.width}x${expected.height} (this image is ${media.width ?? '?'}x${media.height ?? '?'}).`
  }
  return null
}

/** True for animated PNG (APNG `acTL` chunk) and animated WebP (VP8X animation flag or `ANIM` chunk). JPEG is never animated. */
export function isAnimatedImage(buf: Uint8Array): boolean {
  const ascii = (from: number, to: number) => String.fromCharCode(...buf.subarray(from, to))
  if (buf.length >= 8 && buf[0] === 0x89 && ascii(1, 4) === 'PNG') {
    let pos = 8
    while (pos + 8 <= buf.length) {
      const len = ((buf[pos]! << 24) | (buf[pos + 1]! << 16) | (buf[pos + 2]! << 8) | buf[pos + 3]!) >>> 0
      const type = ascii(pos + 4, pos + 8)
      if (type === 'acTL') return true
      if (type === 'IDAT' || type === 'IEND') return false
      pos += 12 + len
    }
    return false
  }
  if (buf.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
    let pos = 12
    while (pos + 8 <= buf.length) {
      const type = ascii(pos, pos + 4)
      const len = (buf[pos + 4]! | (buf[pos + 5]! << 8) | (buf[pos + 6]! << 16) | (buf[pos + 7]! << 24)) >>> 0
      if (type === 'ANIM') return true
      if (type === 'VP8X' && pos + 9 <= buf.length && (buf[pos + 8]! & 0x02) !== 0) return true
      pos += 8 + len + (len % 2)
    }
  }
  return false
}

export type CreativeSet = Partial<Record<Placement, Partial<Record<Variant, unknown>>>>

/** Read `creatives` (stored as camelCase groups) into placement-keyed form. */
export function readCreatives(creatives: unknown): CreativeSet {
  const out: CreativeSet = {}
  const c = (creatives ?? {}) as Record<string, Record<string, unknown> | null | undefined>
  for (const p of PLACEMENTS) {
    const g = c[PLACEMENT_FIELD[p]]
    if (!g) continue
    out[p] = {}
    for (const v of ['desktop', 'mobile'] as const) if (g[v] !== undefined && g[v] !== null) out[p]![v] = g[v]
  }
  return out
}

/** Which creative variants a placement needs. */
export const requiredVariants = (p: Placement): Variant[] => Object.keys(PLACEMENT_SIZES[p]) as Variant[]

/** Missing creatives for the selected placements, as readable names. */
export function missingCreatives(placements: unknown, creatives: unknown): string[] {
  const set = readCreatives(creatives)
  const missing: string[] = []
  for (const p of (Array.isArray(placements) ? placements : []) as Placement[]) {
    if (!PLACEMENTS.includes(p)) continue
    for (const v of requiredVariants(p)) if (set[p]?.[v] === undefined) missing.push(`${p} ${v}`)
  }
  return missing
}

/** Fields whose change on an approved campaign needs a new approval. */
export const PUBLIC_FIELDS = [
  'sponsor',
  'alt',
  'destinationUrl',
  'placements',
  'creatives',
  'startsAt',
  'endsAt',
  'priority',
] as const

/** The approval gate: returns the problems that stop a campaign from being `approved` (empty = ok). */
export function approvalProblems(
  c: { rightsConfirmed?: unknown; paymentStatus?: unknown; placements?: unknown; creatives?: unknown },
  require: boolean,
): string[] {
  const problems: string[] = []
  if (c.rightsConfirmed !== true) problems.push('Creative rights and advertiser authorisation must be confirmed (rightsConfirmed).')
  if (!Array.isArray(c.placements) || c.placements.length === 0) problems.push('Select at least one placement.')
  const missing = missingCreatives(c.placements, c.creatives)
  if (missing.length > 0) problems.push(`Missing creatives: ${missing.join(', ')}.`)
  if (!paymentOk(c.paymentStatus, require)) problems.push('Payment must be paid or waived before approval (ADS_REQUIRE_PAYMENT).')
  return problems
}

export const idOf = (v: unknown): string | number | undefined =>
  typeof v === 'number' || typeof v === 'string'
    ? v
    : v && typeof v === 'object' && 'id' in v
      ? ((v as { id?: string | number }).id as string | number | undefined)
      : undefined

/** Distinct media ids used by a campaign's creatives. */
export function creativeMediaIds(creatives: unknown, placements: readonly Placement[] = PLACEMENTS): Array<string | number> {
  const ids = new Set<string | number>()
  const set = readCreatives(creatives)
  for (const p of placements) {
    for (const v of ['desktop', 'mobile'] as const) {
      const id = idOf(set[p]?.[v])
      if (id !== undefined) ids.add(id)
    }
  }
  return [...ids]
}

export type PublicMedia = { filename?: string | null; width?: number | null; height?: number | null }

/**
 * Contract C3.2 campaign object. Only whitelisted fields are copied, so nothing staff-only can leak. Returns null when a
 * creative the campaign needs is missing (the campaign is then not delivered rather than delivered broken).
 */
export function toPublicCampaign(
  c: Record<string, unknown>,
  mediaById: Map<string, PublicMedia>,
  baseUrl: string,
): Record<string, unknown> | null {
  const placements = (Array.isArray(c.placements) ? c.placements : []).filter((p): p is Placement =>
    PLACEMENTS.includes(p as Placement),
  )
  if (placements.length === 0) return null
  const set = readCreatives(c.creatives)
  const creatives: Record<string, Record<string, unknown>> = {}
  for (const p of placements) {
    creatives[p] = {}
    for (const v of requiredVariants(p)) {
      const id = idOf(set[p]?.[v])
      const m = id === undefined ? undefined : mediaById.get(String(id))
      if (!m || !m.filename || !m.width || !m.height) return null
      creatives[p]![v] = {
        src: `${baseUrl}/api/media/file/${encodeURIComponent(m.filename)}`,
        width: m.width,
        height: m.height,
      }
    }
  }
  return {
    id: `ac_${String(c.id)}`,
    status: 'active',
    sponsor: c.sponsor,
    alt: c.alt,
    destinationUrl: c.destinationUrl,
    startsAt: new Date(toMs(c.startsAt)).toISOString(),
    endsAt: new Date(toMs(c.endsAt)).toISOString(),
    priority: c.priority ?? 0,
    placements,
    creatives,
  }
}

/**
 * Where-clauses (AND them) selecting campaigns that are delivered right now: approved, rights confirmed, paid or waived
 * while payment is required, and `startsAt <= now < endsAt`. `prefix` is '' for a query on `ad-campaigns` and
 * 'adCampaignCreatives.' for the join used by Media's read rule, so the endpoint and the file route agree by construction.
 */
export function liveCampaignClauses(prefix: string, nowMs: number, require: boolean): Array<Record<string, unknown>> {
  const nowIso = new Date(nowMs).toISOString()
  return [
    { [`${prefix}status`]: { equals: 'approved' } },
    { [`${prefix}rightsConfirmed`]: { equals: true } },
    { [`${prefix}startsAt`]: { less_than_equal: nowIso } },
    { [`${prefix}endsAt`]: { greater_than: nowIso } },
    ...(require ? [{ [`${prefix}paymentStatus`]: { in: ['paid', 'waived'] } }] : []),
  ]
}
