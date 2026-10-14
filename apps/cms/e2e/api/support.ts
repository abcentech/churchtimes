/**
 * Shared helpers for the API end-to-end suite. Everything here talks to a REAL running staging server
 * over HTTP (`npm run staging:up`); nothing imports application code.
 *
 * Config resolution:
 *   STAGING_DIR   (default apps/cms/.staging)  -> state.json, credentials.json, .env.staging
 *   STAGING_URL   overrides the base URL used for requests (default state.urls.cmsLoopback)
 *   STAGING_CMS_ORIGIN overrides the Origin sent as "the CMS itself" (default state.urls.cms)
 */
import { createHash, createHmac, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { deflateSync, crc32 } from 'node:zlib'

const root = path.resolve(import.meta.dirname, '..', '..')
const stagingDir = path.resolve(root, process.env.STAGING_DIR || '.staging')

const readJson = (file: string): any => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

const state = readJson(path.join(stagingDir, 'state.json'))
if (!process.env.STAGING_URL && !state?.ready) {
  throw new Error(
    `No running staging environment found (${path.join(stagingDir, 'state.json')}). Run \`npm run staging:up\` first, ` +
      'or set STAGING_URL (and STAGING_DIR for the credentials).',
  )
}

export const BASE_URL: string = (process.env.STAGING_URL || state.urls.cmsLoopback).replace(/\/+$/, '')
/** The CMS's own browser origin (always CSRF-allowed). */
export const CMS_ORIGIN: string = process.env.STAGING_CMS_ORIGIN || state?.urls?.cms || BASE_URL
/** Allowlisted frontend origins (CMS_CORS_ORIGINS / CMS_CSRF_ORIGINS / PUBLIC_SUBMISSION_ORIGINS). */
export const NEWSROOM_ORIGIN: string = state?.urls?.newsroomOrigin || 'http://newsroom.churchtimes.localhost:5174'
export const PUBLIC_ORIGIN: string = state?.urls?.publicOrigin || 'http://www.churchtimes.localhost:5173'
/** Never allowlisted anywhere. */
export const EVIL_ORIGIN = 'http://evil.example'

const credentials = readJson(path.join(stagingDir, 'credentials.json'))
export type RoleKey = 'admin' | 'editor-in-chief' | 'section-editor' | 'trusted-publisher' | 'reporter'
export const credentialsFor = (role: RoleKey): { email: string; password: string } => {
  const u = credentials?.users?.[role]
  if (!u) throw new Error(`No staging credentials for "${role}" in ${path.join(stagingDir, 'credentials.json')}.`)
  return u
}

/** PAYLOAD_SECRET from .staging/.env.staging (only used to forge an EXPIRED token for the expiry test). */
export const stagingPayloadSecret = (): string | undefined => {
  try {
    const line = fs
      .readFileSync(path.join(stagingDir, '.env.staging'), 'utf8')
      .split(/\r?\n/)
      .find((l) => l.startsWith('PAYLOAD_SECRET='))
    return line?.slice('PAYLOAD_SECRET='.length)
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------------------------------------
// HTTP client with a manual cookie jar
// ---------------------------------------------------------------------------------------------------------

export type Res = { status: number; headers: Headers; text: string; json: any; setCookies: string[] }

export type ReqOptions = {
  json?: unknown
  body?: BodyInit
  headers?: Record<string, string>
  /** Origin header; defaults to the client's origin. Pass `null` to send none. */
  origin?: string | null
  /** Send the cookie jar (default true; a public site call uses credentials:'omit' => false). */
  credentials?: boolean
  /** Send `Authorization: JWT <token>` instead of / in addition to the cookie. */
  token?: string
}

let ipSeq = Math.floor(Math.random() * 60000)
/** A unique client address per Client, so rate-limit buckets never collide (TRUST_PROXY=true, hops=1). */
const freshIp = (): string => {
  ipSeq += 1
  return `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq & 255}`
}

export class Client {
  cookies = new Map<string, string>()
  readonly ip: string
  constructor(
    readonly origin: string = CMS_ORIGIN,
    ip?: string,
  ) {
    this.ip = ip ?? freshIp()
  }

  cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  /** Update the jar from Set-Cookie headers exactly like a browser would (Max-Age=0 / past Expires deletes). */
  private absorb(setCookies: string[]) {
    for (const raw of setCookies) {
      const [pair, ...attrs] = raw.split(';').map((s) => s.trim())
      const eq = pair!.indexOf('=')
      const name = pair!.slice(0, eq)
      const value = pair!.slice(eq + 1)
      const lower = attrs.map((a) => a.toLowerCase())
      const expired =
        lower.includes('max-age=0') ||
        lower.some((a) => a.startsWith('expires=') && Date.parse(a.slice('expires='.length)) < Date.now())
      if (!value || expired) this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
  }

  async request(method: string, urlPath: string, opts: ReqOptions = {}): Promise<Res> {
    const headers: Record<string, string> = { 'x-forwarded-for': this.ip, ...(opts.headers ?? {}) }
    const origin = opts.origin === undefined ? this.origin : opts.origin
    if (origin) headers.origin = origin
    if ((opts.credentials ?? true) && this.cookies.size) headers.cookie = this.cookieHeader()
    if (opts.token) headers.authorization = `JWT ${opts.token}`
    let body = opts.body
    if (opts.json !== undefined) {
      body = JSON.stringify(opts.json)
      headers['content-type'] ??= 'application/json'
    }
    const res = await fetch(BASE_URL + urlPath, { method, headers, body, redirect: 'manual' })
    const text = await res.text()
    let json: any = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    const setCookies = res.headers.getSetCookie()
    this.absorb(setCookies)
    return { status: res.status, headers: res.headers, text, json, setCookies }
  }

  get = (p: string, o?: ReqOptions) => this.request('GET', p, o)
  post = (p: string, o?: ReqOptions) => this.request('POST', p, o)
  patch = (p: string, o?: ReqOptions) => this.request('PATCH', p, o)
  del = (p: string, o?: ReqOptions) => this.request('DELETE', p, o)

  login(email: string, password: string) {
    return this.post('/api/users/login', { json: { email, password } })
  }
}

/** Log in as a seeded synthetic staff member; returns the client (cookie in its jar) and the JWT. */
export async function loginAs(role: RoleKey, origin: string = CMS_ORIGIN) {
  const client = new Client(origin)
  const { email, password } = credentialsFor(role)
  const res = await client.login(email, password)
  if (res.status !== 200 || typeof res.json?.token !== 'string') {
    throw new Error(`Staging login as ${role} failed with HTTP ${res.status}. Is the staging environment up and seeded?`)
  }
  return { client, token: res.json.token as string, user: res.json.user as { id: number; role: string; email: string } }
}

// ---------------------------------------------------------------------------------------------------------
// Fixtures / builders
// ---------------------------------------------------------------------------------------------------------

/** Unique prefix for everything a run creates, so cleanup is exact and runs never collide. */
export const newRunId = () => `e2e-${randomBytes(4).toString('hex')}`

export const lexical = (text: string) => ({
  root: {
    type: 'root',
    format: '',
    indent: 0,
    version: 1,
    direction: 'ltr',
    children: [
      {
        type: 'paragraph',
        format: '',
        indent: 0,
        version: 1,
        direction: 'ltr',
        textFormat: 0,
        textStyle: '',
        children: [{ type: 'text', text, format: 0, detail: 0, mode: 'normal', style: '', version: 1 }],
      },
    ],
  },
})

export async function categoryId(client: Client, slug = 'news'): Promise<number> {
  const res = await client.get(`/api/categories?where[slug][equals]=${slug}&limit=1`, { credentials: false })
  const id = res.json?.docs?.[0]?.id
  if (typeof id !== 'number') throw new Error(`Category "${slug}" is not seeded (HTTP ${res.status}).`)
  return id
}

/** Valid RGB PNG (solid colour), built by hand so the suite needs no image library. */
export function makePng(width = 64, height = 48, rgb: [number, number, number] = [30, 90, 160]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => rgb).flat())])
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Multipart body for POST /api/media: `file` + `_payload` (JSON string), per api-contracts 6.3. */
export function mediaForm(file: Buffer, filename: string, mime: string, alt: string): FormData {
  const form = new FormData()
  form.set('_payload', JSON.stringify({ alt }))
  form.set('file', new Blob([new Uint8Array(file)], { type: mime }), filename)
  return form
}

// ---------------------------------------------------------------------------------------------------------
// Token forging (expired-session test). Mirrors Payload: HS256 with sha256(PAYLOAD_SECRET).hex.slice(0, 32).
// ---------------------------------------------------------------------------------------------------------

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url')

/** Re-sign a real token's claims with a different `exp` (and optionally a different key). */
export function resignToken(realToken: string, claims: Record<string, unknown>, secret: string, rawKey = false): string {
  const [h, p] = realToken.split('.')
  const header = JSON.parse(Buffer.from(h!, 'base64url').toString('utf8'))
  const payload = { ...JSON.parse(Buffer.from(p!, 'base64url').toString('utf8')), ...claims }
  const key = rawKey ? secret : createHash('sha256').update(secret).digest('hex').slice(0, 32)
  const signingInput = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`
  return `${signingInput}.${createHmac('sha256', key).update(signingInput).digest('base64url')}`
}

// ---------------------------------------------------------------------------------------------------------
// Network probe for the real Cloudflare Siteverify tests
// ---------------------------------------------------------------------------------------------------------

export async function cloudflareReachable(): Promise<boolean> {
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'secret=1x0000000000000000000000000000000AA&response=XXXX.DUMMY.TOKEN.XXXX',
      signal: AbortSignal.timeout(5000),
    })
    const json: any = await res.json()
    return json?.success === true
  } catch {
    return false
  }
}

export const DUMMY_TURNSTILE_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX'

export const validSubmission = (runId: string, extra: Record<string, unknown> = {}) => ({
  name: 'E2E Contributor',
  email: `${runId}-${randomBytes(3).toString('hex')}@staging.invalid`,
  title: `${runId} community tip ${randomBytes(3).toString('hex')}`,
  body: 'A synthetic end-to-end submission body that is comfortably longer than thirty characters.',
  turnstileToken: DUMMY_TURNSTILE_TOKEN,
  ...extra,
})
