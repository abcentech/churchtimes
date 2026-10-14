/**
 * REMOTE mode of the cross-app lane (XAPP_REMOTE=1): the same journeys against an already deployed https staging.
 * Nothing is booted. See docs/staging.md ("Remote mode") for the operator guide.
 *
 * Hard rules implemented here:
 *   - the three URLs come from env (no defaults in code), must be https and reachable with REAL certificates;
 *   - credentials come ONLY from the JSON file named by XAPP_REMOTE_CREDENTIALS (never env, never printed, never logged);
 *   - every record the run creates carries the run prefix "E2E-<yyyymmdd>-<hhmm>" (see `uniq` in helpers.ts) and the
 *     teardown deletes (or, for articles, archives) ONLY records whose name contains that prefix;
 *   - evidence goes to docs/evidence/remote/ (gitignored).
 *
 * This module has no value imports from helpers.ts / stack.ts (they import it).
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { XappConfig } from './stack'

export const isRemote = process.env.XAPP_REMOTE === '1'
export const isHeaded = process.env.XAPP_HEADED === '1'

const here = path.dirname(fileURLToPath(import.meta.url))
const cmsRoot = path.resolve(here, '../../..')
const repoRoot = path.resolve(cmsRoot, '../..')

/** Seconds between ticks of the real scheduler on the deployed CMS (SCHEDULER_INTERVAL_SECONDS there, 60 by default). */
export function remoteSchedulerSeconds(): number {
  const raw = process.env.XAPP_REMOTE_SCHEDULER_SECONDS ?? '60'
  const n = Number(raw)
  if (!/^\d+$/.test(raw) || n < 1 || n > 3600) throw new Error(`XAPP_REMOTE_SCHEDULER_SECONDS must be an integer 1-3600, got "${raw}"`)
  return n
}

/** The run prefix of every synthetic record: "E2E-yyyymmdd-hhmm" (UTC) unless XAPP_RUN_PREFIX overrides it (same shape required). */
const PREFIX_RE = /^E2E-\d{8}-\d{4}(-[A-Za-z0-9]{1,16})?$/
export function makeRunPrefix(now = new Date()): string {
  const override = process.env.XAPP_RUN_PREFIX
  if (override) {
    if (!PREFIX_RE.test(override)) throw new Error(`XAPP_RUN_PREFIX must look like E2E-20261014-1530 (optionally -suffix), got "${override}"`)
    return override
  }
  const p = (n: number) => String(n).padStart(2, '0')
  return `E2E-${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}`
}
export const assertSweepablePrefix = (prefix: string): void => {
  if (!PREFIX_RE.test(prefix)) throw new Error(`Refusing to clean up with prefix "${prefix}": it must look like E2E-20261014-1530`)
}

const log = (...a: unknown[]) => console.log('[xapp-remote]', ...a)

// ---------------------------------------------------------------------------------------------------------
// Environment + reachability
// ---------------------------------------------------------------------------------------------------------

function readHttpsOrigin(name: string, example: string): string {
  const raw = process.env[name]
  if (!raw) throw new Error(`${name} is not set (remote mode needs XAPP_PUBLIC_URL, XAPP_NEWSROOM_URL and XAPP_CMS_URL), e.g. ${name}=${example}`)
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new Error(`${name} is not a valid URL: "${raw}"`)
  }
  if (u.protocol !== 'https:') throw new Error(`${name} must be an https:// URL (real certificate), got "${u.protocol}//${u.host}"`)
  if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash || u.username) throw new Error(`${name} must be a bare origin without path, query or credentials, got "${raw}"`)
  return u.origin
}

const errCode = (e: unknown): string => {
  const err = e as { cause?: { code?: string; message?: string }; message?: string }
  return err.cause?.code ?? err.cause?.message ?? err.message ?? String(e)
}

async function probe(label: string, url: string, expectJson = false): Promise<string | null> {
  try {
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000) })
    if (res.status >= 500) return `${label} ${url} answered HTTP ${res.status}`
    if (expectJson && res.status !== 200) return `${label} ${url} answered HTTP ${res.status} (expected 200 with JSON: is this really the CMS?)`
    return null
  } catch (e) {
    const code = errCode(e)
    const tls = /CERT|SSL|TLS|self.signed|issuer/i.test(code) ? ' Real (Let\'s Encrypt) certificates are required; this lane never disables certificate checks.' : ''
    return `${label} ${url} is not reachable (${code}).${tls}`
  }
}

// ---------------------------------------------------------------------------------------------------------
// Credentials file (never printed)
// ---------------------------------------------------------------------------------------------------------

type CredFile = { categoryTitle?: string; credentials: Record<string, { email: string; password: string; name?: string }> }
const ROLES = ['admin', 'reporter', 'section-editor', 'editor-in-chief'] as const
const REQUIRED_ROLES = ['admin', 'reporter', 'section-editor'] as const

function insideGitAndNotIgnored(file: string): boolean {
  const abs = path.resolve(file)
  const rel = path.relative(repoRoot, abs)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false // outside the repository
  const res = spawnSync('git', ['check-ignore', '-q', abs], { cwd: repoRoot })
  return res.status === 1 // 1 = not ignored; 0 = ignored; anything else: git unavailable, do not block
}

export function readCredentialsFile(): CredFile {
  const file = process.env.XAPP_REMOTE_CREDENTIALS
  if (!file) throw new Error('XAPP_REMOTE_CREDENTIALS is not set: it must be the path of a local, gitignored JSON file with the staging logins (see docs/staging.md, "Remote mode").')
  if (!fs.existsSync(file)) throw new Error(`XAPP_REMOTE_CREDENTIALS points to a file that does not exist: ${file}`)
  if (insideGitAndNotIgnored(file)) throw new Error(`XAPP_REMOTE_CREDENTIALS (${file}) is inside the repository and not gitignored. Keep it outside the repo or name it xapp-remote-credentials*.json.`)
  let parsed: any
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    // deliberately no parser message: it can quote the file content
    throw new Error(`XAPP_REMOTE_CREDENTIALS (${file}) is not valid JSON.`)
  }
  const creds = parsed?.credentials
  if (!creds || typeof creds !== 'object') throw new Error('The credentials file must have a "credentials" object keyed by role.')
  for (const role of REQUIRED_ROLES) {
    const c = creds[role]
    if (!c || typeof c.email !== 'string' || !c.email || typeof c.password !== 'string' || !c.password) {
      throw new Error(`The credentials file needs credentials.${role}.email and credentials.${role}.password (strings).`)
    }
  }
  const out: CredFile['credentials'] = {}
  for (const role of ROLES) {
    const c = creds[role]
    if (c && typeof c.email === 'string' && typeof c.password === 'string') out[role] = { email: c.email, password: c.password, ...(typeof c.name === 'string' && c.name ? { name: c.name } : {}) }
  }
  return { categoryTitle: typeof parsed.categoryTitle === 'string' && parsed.categoryTitle ? parsed.categoryTitle : undefined, credentials: out }
}

async function jsonFetch(url: string, init?: RequestInit): Promise<{ status: number; json: any }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) })
  let json: any = null
  try {
    json = await res.json()
  } catch {
    // not JSON
  }
  return { status: res.status, json }
}

async function apiLogin(cms: string, role: string, c: { email: string; password: string }): Promise<{ token: string; id: number; userRole: string }> {
  const r = await jsonFetch(`${cms}/api/users/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: c.email, password: c.password }) })
  if (r.status !== 200 || !r.json?.token) {
    const hint = r.status === 429 ? ' (rate limited: raise AUTH_LOGIN_RATE_LIMIT on the staging CMS or wait for the window)' : r.status === 401 || r.status === 403 ? ' (wrong credentials, or the account is locked)' : ''
    throw new Error(`Staging login as "${role}" failed: HTTP ${r.status}${hint}`)
  }
  return { token: r.json.token as string, id: Number(r.json.user?.id), userRole: String(r.json.user?.role ?? '') }
}

// ---------------------------------------------------------------------------------------------------------
// Global setup (boots nothing)
// ---------------------------------------------------------------------------------------------------------

export async function prepareRemote(): Promise<XappConfig> {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('NODE_TLS_REJECT_UNAUTHORIZED=0 is set: remote mode requires real certificate validation. Unset it.')
  const publicOrigin = readHttpsOrigin('XAPP_PUBLIC_URL', 'https://staging.churchtimesnigeria.net')
  const newsroomOrigin = readHttpsOrigin('XAPP_NEWSROOM_URL', 'https://newsroom.staging.churchtimesnigeria.net')
  const cmsUrl = readHttpsOrigin('XAPP_CMS_URL', 'https://cms.staging.churchtimesnigeria.net')
  remoteSchedulerSeconds() // validates the env early

  const problems = (
    await Promise.all([
      probe('public site', `${publicOrigin}/`),
      probe('newsroom', `${newsroomOrigin}/`),
      probe('CMS', `${cmsUrl}/api/categories?limit=1`, true),
    ])
  ).filter((p): p is string => !!p)
  if (problems.length) throw new Error(`Remote staging is not ready (checked over https, 15 s timeout each):\n  - ${problems.join('\n  - ')}`)
  log('public, newsroom and CMS answered over https')

  const file = readCredentialsFile()
  const credentials: XappConfig['credentials'] = {}
  for (const [role, c] of Object.entries(file.credentials)) {
    const { id, userRole } = await apiLogin(cmsUrl, role, c)
    if (!Number.isFinite(id)) throw new Error(`Staging login as "${role}" returned no user id.`)
    if (userRole && userRole !== role) throw new Error(`The "${role}" entry of the credentials file logged in as an account with role "${userRole}". Fix the file.`)
    credentials[role] = { email: c.email, password: c.password, id, ...(c.name ? { name: c.name } : {}) }
  }
  log(`logged in as ${Object.keys(credentials).join(', ')} (ids resolved; no secret printed)`)

  const categoryTitle = process.env.XAPP_REMOTE_CATEGORY ?? file.categoryTitle ?? 'News'
  const cat = await jsonFetch(`${cmsUrl}/api/categories?where[title][equals]=${encodeURIComponent(categoryTitle)}&limit=2&depth=0`)
  const categoryId = cat.json?.docs?.[0]?.id
  if (typeof categoryId !== 'number') throw new Error(`No category titled "${categoryTitle}" exists on staging (set "categoryTitle" in the credentials file or XAPP_REMOTE_CATEGORY).`)

  const runId = makeRunPrefix()
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-e2e-remote-'))
  log(`run prefix ${runId}; every synthetic record created by this run carries it`)
  return {
    cmsUrl,
    newsroomOrigin,
    publicOrigin,
    publicGapOrigin: publicOrigin, // spec 05 checks the DEPLOYED public build (there is no second build remotely)
    credentials,
    categoryId,
    categoryTitle,
    recorderUrl: `${cmsUrl}/__e2e/log`, // no recording proxy remotely; never fetched (see recorder-log.ts); only its origin is used by older helpers
    apiBase: cmsUrl,
    remote: true,
    runId,
    fixtureDir,
    evidenceDir: path.join(cmsRoot, 'docs', 'evidence', 'remote'),
  }
}

// ---------------------------------------------------------------------------------------------------------
// Teardown: remove what THIS run created (prefix only)
// ---------------------------------------------------------------------------------------------------------

type Counts = { matched: number; deleted: number; archived: number; failed: number; skippedNoPrefix: number }

/**
 * Deletes (articles: falls back to archiving) every record whose title / filename contains `prefix` (case-insensitive, verified again
 * client-side before each write). Records without the prefix are never listed for writing. Never throws; returns a report.
 */
export async function cleanupByPrefix(cmsUrl: string, creds: Record<string, { email: string; password: string }>, prefix: string): Promise<string[]> {
  assertSweepablePrefix(prefix)
  const lines: string[] = []
  const say = (l: string) => {
    lines.push(l)
    log(l)
  }
  const role = creds['admin'] ? 'admin' : creds['editor-in-chief'] ? 'editor-in-chief' : undefined
  if (!role) return [`cleanup skipped: no admin / editor-in-chief credentials (records with prefix ${prefix} remain on staging)`]
  let token: string
  try {
    token = (await apiLogin(cmsUrl, role, creds[role]!)).token
  } catch (e) {
    return [`cleanup FAILED: ${(e as Error).message}; records with prefix ${prefix} remain on staging`]
  }
  const call = (method: string, p: string, body?: unknown) =>
    jsonFetch(`${cmsUrl}${p}`, { method, headers: { authorization: `JWT ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
  const low = prefix.toLowerCase()
  const has = (v: unknown) => typeof v === 'string' && v.toLowerCase().includes(low)

  const sweep = async (collection: string, field: 'title' | 'filename', opts: { archiveFallback?: boolean } = {}): Promise<{ counts: Counts; ids: number[] }> => {
    const counts: Counts = { matched: 0, deleted: 0, archived: 0, failed: 0, skippedNoPrefix: 0 }
    const seen = new Set<number>()
    const ids: number[] = []
    const op = field === 'filename' ? 'like' : 'contains'
    for (let pass = 0; pass < 20; pass++) {
      const r = await call('GET', `/api/${collection}?where[${field}][${op}]=${encodeURIComponent(prefix)}&limit=100&depth=0&sort=id`)
      if (r.status !== 200) {
        say(`${collection}: listing failed (HTTP ${r.status}); not cleaned`)
        counts.failed += 1
        break
      }
      const fresh = (r.json?.docs ?? []).filter((d: any) => !seen.has(d.id))
      if (!fresh.length) break
      for (const d of fresh) {
        seen.add(d.id)
        if (!has(d[field])) {
          counts.skippedNoPrefix += 1 // the server matched loosely; without the exact prefix we never touch it
          continue
        }
        counts.matched += 1
        ids.push(d.id)
        const del = await call('DELETE', `/api/${collection}/${d.id}`)
        if (del.status === 200) counts.deleted += 1
        else if (opts.archiveFallback && (await call('PATCH', `/api/${collection}/${d.id}`, { status: 'archived' })).status === 200) counts.archived += 1
        else counts.failed += 1
      }
    }
    say(`${collection}: ${counts.matched} with prefix, deleted ${counts.deleted}, archived ${counts.archived}, failed ${counts.failed}${counts.skippedNoPrefix ? `, ${counts.skippedNoPrefix} loose matches left untouched` : ''}`)
    return { counts, ids }
  }

  try {
    // live updates first (they point at events); an event is only listed through its prefixed title
    const events = await call('GET', `/api/live-events?where[title][contains]=${encodeURIComponent(prefix)}&limit=100&depth=0`)
    let updatesDeleted = 0
    let updatesFailed = 0
    for (const e of (events.json?.docs ?? []).filter((d: any) => has(d.title))) {
      const ups = await call('GET', `/api/live-updates?where[event][equals]=${e.id}&limit=200&depth=0`)
      for (const u of ups.json?.docs ?? []) (await call('DELETE', `/api/live-updates/${u.id}`)).status === 200 ? updatesDeleted++ : updatesFailed++
    }
    say(`live-updates (of prefixed events): deleted ${updatesDeleted}, failed ${updatesFailed}`)
    await sweep('live-events', 'title')
    await sweep('submissions', 'title')
    await sweep('articles', 'title', { archiveFallback: true })
    await sweep('media', 'filename')
    say('audit-logs are immutable through the API and are not removed')
  } catch (e) {
    say(`cleanup stopped by an error: ${(e as Error).message}`)
  }
  return lines
}

/** Called by global teardown: removes the temp fixtures and sweeps the prefixed records; appends the report to the evidence log. */
export async function teardownRemote(cfg: XappConfig, appendEvidence: (line: string) => void): Promise<void> {
  const lines = await cleanupByPrefix(cfg.cmsUrl, cfg.credentials, cfg.runId)
  for (const l of lines) appendEvidence(`[remote-cleanup] ${l}`)
  try {
    fs.rmSync(cfg.fixtureDir, { recursive: true, force: true })
  } catch {
    // temp dir
  }
}

/**
 * Cookies that belong to the application. Locally the reader must have NO cookie at all. On a real deployment the Cloudflare edge may set its own
 * infrastructure cookies (`__cf_bm`, `cf_clearance`, ...) which are not the app's; remote mode ignores exactly those, nothing else.
 */
export const appCookies = <T extends { name: string }>(cookies: T[]): T[] => (isRemote ? cookies.filter((c) => !/^(__cf|_cf|cf_)/i.test(c.name)) : cookies)
