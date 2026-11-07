import { constants } from 'node:fs'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { createRateLimiter } from './rateLimit'

/**
 * Health surface for external uptime monitors and the container HEALTHCHECK.
 *
 * - Liveness (`/api/health/live`): the process answers HTTP. No database, no Payload boot, fixed body.
 * - Readiness (`/api/health/ready`): database answers `select 1` within a short timeout, every bundled migration is
 *   recorded as applied, and the media directory is writable. Booleans only; failures never carry error text.
 *
 * Both are GET/HEAD only, `Cache-Control: no-store`, and never set CORS headers (monitors are not browsers).
 */

export const HEALTH_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
}

const json = (status: number, body: unknown, method: string, extra: Record<string, string> = {}): Response =>
  new Response(method === 'HEAD' ? null : JSON.stringify(body), { status, headers: { ...HEALTH_HEADERS, ...extra } })

const methodNotAllowed = (): Response =>
  new Response(null, { status: 405, headers: { ...HEALTH_HEADERS, Allow: 'GET, HEAD' } })

export function livenessResponse(method: string): Response {
  if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed()
  return json(200, { status: 'ok' }, method)
}

export type ReadinessProbes = {
  /** Resolves when the database answered a trivial query. */
  pingDatabase: () => Promise<void>
  /** Names of migrations recorded as applied. */
  appliedMigrations: () => Promise<string[]>
  /** Names of migrations shipped in this build. */
  bundledMigrations: string[]
  /** Resolves when the media directory accepts a write. */
  checkMediaWritable: () => Promise<void>
  timeoutMs?: number
}

export type ReadinessReport = { ok: boolean; database: boolean; migrations: boolean; media: boolean }

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms)
    t.unref?.()
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })

const attempt = async (fn: () => Promise<unknown>, ms: number): Promise<boolean> => {
  try {
    await withTimeout(fn(), ms)
    return true
  } catch {
    return false
  }
}

export async function runReadiness(probes: ReadinessProbes): Promise<ReadinessReport> {
  const ms = probes.timeoutMs ?? 2000
  const database = await attempt(probes.pingDatabase, ms)
  let migrations = false
  if (database) {
    migrations = await attempt(async () => {
      const applied = new Set(await probes.appliedMigrations())
      if (!probes.bundledMigrations.every((n) => applied.has(n))) throw new Error('pending')
    }, ms)
  }
  const media = await attempt(probes.checkMediaWritable, ms)
  return { ok: database && migrations && media, database, migrations, media }
}

/** Writes and removes a temp directory entry inside `dir`; rejects when it cannot. */
export async function checkDirectoryWritable(dir: string): Promise<void> {
  await access(dir, constants.W_OK)
  const tmp = await mkdtemp(path.join(dir, '.health-'))
  try {
    await writeFile(path.join(tmp, 'w'), '')
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

const CACHE_MS = 5_000
const limiter = createRateLimiter({ limit: 300, windowMs: 60_000 })
let cache: { at: number; report: ReadinessReport } | undefined

/** Test helper. */
export function resetReadinessState(): void {
  cache = undefined
}

/**
 * Readiness handler. The result is memoised for 5 s so a monitor (or a flood) cannot drive more than one database
 * probe per 5 s per process; a per-client limiter (generous: 300/min) answers 429 beyond that.
 */
export async function readinessResponse(
  method: string,
  clientKey: string,
  getProbes: () => Promise<ReadinessProbes>,
  now: () => number = Date.now,
): Promise<Response> {
  if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed()
  const rl = limiter.check(clientKey)
  if (!rl.allowed) {
    return json(429, { status: 'rate_limited' }, method, { 'Retry-After': String(Math.max(1, rl.retryAfterSeconds)) })
  }
  let report: ReadinessReport
  if (cache && now() - cache.at < CACHE_MS) {
    report = cache.report
  } else {
    try {
      report = await runReadiness(await getProbes())
    } catch {
      // Payload failed to initialise (for instance the database is down at boot): not ready, no detail.
      report = { ok: false, database: false, migrations: false, media: false }
    }
    cache = { at: now(), report }
  }
  const { ok, database, migrations, media } = report
  return json(ok ? 200 : 503, { status: ok ? 'ready' : 'unavailable', database, migrations, media }, method)
}

/**
 * Startup self-check: which critical settings are present and well-formed. Returns COUNTS only, never values or names.
 */
export function startupSelfCheck(env: NodeJS.ProcessEnv): { passed: number; total: number } {
  const set = (k: string) => Boolean(env[k]?.trim())
  const checks: boolean[] = [
    (env.PAYLOAD_SECRET?.length ?? 0) >= 32,
    set('DATABASE_URL'),
    (env.PREVIEW_SECRET?.length ?? 0) >= 32,
    (env.IP_HASH_SALT?.length ?? 0) >= 16,
    set('TURNSTILE_SECRET_KEY'),
    set('CMS_PUBLIC_URL'),
    set('CMS_CORS_ORIGINS'),
    env.TRUST_PROXY === 'true',
    set('SMTP_HOST'),
    env.CMS_ALLOW_INSECURE_LOCAL_STAGING !== 'true',
  ]
  return { passed: checks.filter(Boolean).length, total: checks.length }
}
