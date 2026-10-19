import { createHash } from 'node:crypto'

import type { Endpoint, PayloadRequest } from 'payload'

import {
  cacheSeconds,
  creativeMediaIds,
  envFlag,
  inWindow,
  paymentOk,
  requirePayment,
  toMs,
  toPublicCampaign,
  type PublicMedia,
} from '../lib/advertising'
import { isOriginAllowed } from './publicSubmissions'

/**
 * `GET /api/public/advertising` (go-live contract C3.2). Anonymous and credential-free; read-only; no rate limit.
 *
 * - A campaign is delivered only when `approved`, rights confirmed, paid or waived (while ADS_REQUIRE_PAYMENT) and
 *   `startsAt <= now < endsAt`. The body is built from a whitelist (`toPublicCampaign`): advertiser, payment status,
 *   approval data and notes are never copied. The file route applies the same rule (Media.readAccess), so a creative is
 *   public only while its campaign is delivered.
 * - `Cache-Control: public, max-age=N`, N = min(60, whole seconds to the next start or end of an approved campaign). An
 *   `ETag` is sent for CDNs. Browsers rely on max-age: the CORS headers expose no response headers and
 *   allow no request headers, so a cross-origin page can neither read the ETag nor send If-None-Match without a preflight.
 * - Origin: when sent it must be in PUBLIC_SUBMISSION_ORIGINS (403), the same allowlist as the public submissions endpoint.
 * - AdSense is only a pair of flags from server configuration; no publisher id or script is ever delivered.
 */

const MAX_CAMPAIGNS = 100
const MAX_SCAN = 500

const corsHeaders = (origin: string | null): Record<string, string> =>
  origin
    ? {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Max-Age': '600',
      }
    : {}

const errorResponse = (status: number, message: string) =>
  Response.json({ ok: false, errors: [{ message }] }, { status, headers: { 'Cache-Control': 'no-store', Vary: 'Origin' } })

/** Base URL for creative `src`: the configured CMS origin, else the origin the request came in on. */
function baseUrl(req: PayloadRequest): string {
  const configured = (process.env.CMS_PUBLIC_URL ?? '').trim().replace(/\/+$/, '')
  if (configured) return configured
  try {
    return new URL(req.url ?? 'http://localhost').origin
  } catch {
    return 'http://localhost'
  }
}

async function respond(req: PayloadRequest, withBody: boolean): Promise<Response> {
  const origin = req.headers.get('origin')
  if (!isOriginAllowed(origin)) return errorResponse(403, 'Origin not allowed.')

  const nowMs = Date.now()
  const nowIso = new Date(nowMs).toISOString()
  const require = requirePayment()

  const scan = await req.payload.find({
    collection: 'ad-campaigns',
    where: {
      and: [
        { status: { equals: 'approved' } },
        { rightsConfirmed: { equals: true } },
        { endsAt: { greater_than: nowIso } },
        ...(require ? [{ paymentStatus: { in: ['paid', 'waived'] } }] : []),
      ],
    },
    sort: 'startsAt',
    limit: MAX_SCAN,
    pagination: false,
    depth: 0,
    overrideAccess: true,
    req,
  })
  const eligible = (scan.docs as unknown as Array<Record<string, unknown>>).filter((c) => paymentOk(c.paymentStatus, require))

  // Boundaries that can change the answer: every start still ahead and every end of a campaign that is eligible.
  const maxAge = cacheSeconds(
    eligible.flatMap((c) => [toMs(c.startsAt), toMs(c.endsAt)]),
    nowMs,
  )

  const live = eligible
    .filter((c) => inWindow(c.startsAt, c.endsAt, nowMs))
    .sort((a, b) => Number(b.priority ?? 0) - Number(a.priority ?? 0) || Number(a.id) - Number(b.id))
    .slice(0, MAX_CAMPAIGNS)

  const mediaIds = [...new Set(live.flatMap((c) => creativeMediaIds(c.creatives)))]
  const mediaById = new Map<string, PublicMedia>()
  if (mediaIds.length > 0) {
    const media = await req.payload.find({
      collection: 'media',
      where: { id: { in: mediaIds } },
      limit: mediaIds.length,
      pagination: false,
      depth: 0,
      overrideAccess: true,
      select: { filename: true, width: true, height: true },
      req,
    })
    for (const m of media.docs as unknown as Array<PublicMedia & { id: number | string }>) {
      mediaById.set(String(m.id), m)
    }
  }

  const base = baseUrl(req)
  const campaigns = live
    .map((c) => toPublicCampaign(c, mediaById, base))
    .filter((c): c is Record<string, unknown> => c !== null)

  const body = JSON.stringify({
    campaigns,
    adsense: {
      enabled: envFlag(process.env.PUBLIC_ADSENSE_ENABLED),
      reviewed: envFlag(process.env.PUBLIC_ADSENSE_REVIEWED),
    },
  })
  const etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`
  const headers = {
    ...corsHeaders(origin),
    ETag: etag,
    'Cache-Control': `public, max-age=${maxAge}`,
    Vary: 'Origin',
  }
  // Conditional requests are for CDNs: honour If-None-Match when a proxy forwards it.
  const inm = req.headers.get('if-none-match')
  if (inm && inm.split(',').map((t) => t.trim().replace(/^W\//, '')).some((t) => t === etag || t === '*')) {
    return new Response(null, { status: 304, headers })
  }
  return new Response(withBody ? body : null, {
    status: 200,
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
  })
}

export const publicAdvertisingEndpoint: Endpoint = {
  path: '/public/advertising',
  method: 'get',
  handler: (req: PayloadRequest) => respond(req, true),
}

export const publicAdvertisingHeadEndpoint: Endpoint = {
  path: '/public/advertising',
  method: 'head',
  handler: (req: PayloadRequest) => respond(req, false),
}

export const publicAdvertisingPreflightEndpoint: Endpoint = {
  path: '/public/advertising',
  method: 'options',
  handler: async (req: PayloadRequest) => {
    const origin = req.headers.get('origin')
    if (origin && !isOriginAllowed(origin)) return new Response(null, { status: 403 })
    return new Response(null, { status: 204, headers: { ...corsHeaders(origin), Vary: 'Origin' } })
  },
}
