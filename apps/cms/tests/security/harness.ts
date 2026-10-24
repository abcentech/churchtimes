import { NextRequest } from 'next/server'

import { proxy } from '../../src/proxy'
import { api, ORIGIN, type ApiOptions, type ApiResult } from '../integration/helpers'

/** A fresh client IP per call so per-IP rate limiters never interfere with matrix probes. */
let ipN = 0
export const freshIp = (): string => `198.51.${Math.floor(ipN / 250) % 250}.${(ipN += 1) % 250}`
export const ipHeaders = (extra: Record<string, string> = {}) => ({ 'x-forwarded-for': freshIp(), ...extra })

type Method = Parameters<typeof api>[0]

/** Body as the proxy would see it (only multipart bodies are inspected there). */
const bodyOf = (body: unknown): BodyInit | undefined =>
  body instanceof FormData ? body : undefined

/**
 * One request through the same two layers the running app has: src/proxy.ts (body/shape/filter guards, Vary: Origin)
 * and then the Payload REST route handler. Black-box: nothing is mocked except the Turnstile/mail transports where a test
 * installs them.
 */
export async function send(method: Method, url: string, options: ApiOptions = {}): Promise<ApiResult> {
  const u = new URL(url, ORIGIN)
  const headers = new Headers(options.headers)
  if (options.token) headers.set('Authorization', `JWT ${options.token}`)
  const gate = await proxy(new NextRequest(u, { method, headers, body: bodyOf(options.body), ...(options.body !== undefined ? { duplex: 'half' } : {}) } as never))
  if (!gate.headers.get('x-middleware-next')) {
    const text = await gate.text()
    let json: unknown = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    return { status: gate.status, headers: gate.headers, json, text }
  }
  const res = await api(method, url, options)
  const merged = new Headers(res.headers)
  merged.append('Vary', 'Origin')
  const cc = gate.headers.get('cache-control')
  if (cc) merged.set('Cache-Control', cc) // headers set by the proxy are merged onto the final response by Next
  return { ...res, headers: merged }
}

export const anon = (
  method: Method,
  url: string,
  opts: { body?: unknown; headers?: Record<string, string>; token?: string } = {},
): Promise<ApiResult> => send(method, url, { body: opts.body, token: opts.token, headers: ipHeaders(opts.headers) })

/** Every key name (at any depth) of a JSON document. */
export function collectKeys(node: unknown, into = new Set<string>(), depth = 0): Set<string> {
  if (depth > 40 || node === null || typeof node !== 'object') return into
  if (Array.isArray(node)) {
    for (const v of node) collectKeys(v, into, depth + 1)
    return into
  }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    into.add(k)
    collectKeys(v, into, depth + 1)
  }
  return into
}

/** Key names that must never appear in an anonymous response (docs/security.md). */
export const FORBIDDEN_KEYS = [
  'provenance',
  'sourceUrl',
  'sourceHost',
  'sourceSha256',
  'importBatch',
  'reviewNotes',
  'scheduledFor',
  'ipHash',
  'contentHash',
  'email',
  'author',
  'bodyMedia',
  'uploadedBy',
  'sessions',
  'hash',
  'salt',
  'password',
  'resetPasswordToken',
  'resetPasswordExpiration',
  'loginAttempts',
  'lockUntil',
  'reviewerNotes',
] as const

/**
 * Legacy fields that are PUBLIC BY CONTRACT (docs/api-contracts.md: Article.legacyUrl / Article.legacyId and the
 * legacy-comments projection). Listed here so the exception is explicit and reviewed; any other key containing
 * "legacy" is forbidden.
 */
export const LEGACY_PUBLIC_BY_CONTRACT = new Set(['legacyId', 'legacyUrl', 'parentLegacyId'])

export function forbiddenKeysIn(json: unknown): string[] {
  const keys = collectKeys(json)
  const bad = (FORBIDDEN_KEYS as readonly string[]).filter((k) => keys.has(k))
  for (const k of keys) {
    if (/legacy/i.test(k) && !LEGACY_PUBLIC_BY_CONTRACT.has(k)) bad.push(k)
  }
  return bad
}

/** Stack traces, SQL or file-system paths in a response body. */
export const LEAK_PATTERNS: Array<[string, RegExp]> = [
  ['stack trace', /\n\s+at\s+\S+\s+\(|\bat\s+\S+\s+\(file:|node_modules[\\/]/],
  [
    'sql',
    /\b(select\s.+\sfrom|insert\s+into|update\s+"?\w+"?\s+set|syntax error at or near|violates .* constraint|relation ".*" does not exist|drizzle|pg_catalog)\b/i,
  ],
  ['fs path', /[A-Za-z]:\\\\?(Users|Windows)|\/(home|usr|var|app|srv)\/[\w.-]+\//],
]

export function leaksIn(text: string): string[] {
  return LEAK_PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name)
}
