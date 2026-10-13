import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

import type { Page, TestInfo } from '@playwright/test'

import type { XappConfig } from './stack'

export type { XappConfig }

export function getConfig(): XappConfig {
  const raw = process.env.CT_XAPP_CONFIG
  if (!raw) throw new Error('CT_XAPP_CONFIG is not set: run through playwright.cross-app.config.ts (globalSetup boots the stack).')
  return JSON.parse(raw) as XappConfig
}

export type Role = 'admin' | 'reporter' | 'section-editor' | 'editor-in-chief'

export const uniq = (label: string) => `${label} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`

// ---------------------------------------------------------------------------------------------------------
// Evidence: step screenshots + a plain-text log. Synthetic data only; screenshots are taken before any password
// is typed on the login screen and password inputs are masked by the browser.
// ---------------------------------------------------------------------------------------------------------

const evidenceOn = () => process.env.XAPP_KEEP_EVIDENCE !== '0'
export const evidenceLogName = (): string => `cross-app-${new Date().toISOString().slice(0, 10)}.txt`

export function logLine(cfg: XappConfig, line: string): void {
  if (!evidenceOn()) return
  fs.appendFileSync(path.join(cfg.evidenceDir, evidenceLogName()), `${new Date().toISOString()}  ${line}\n`)
}

export class Evidence {
  private n = 0
  constructor(
    private cfg: XappConfig,
    private info: TestInfo,
    /** e.g. "A-newsroom-publish" */
    private scenario: string,
  ) {}

  get project(): string {
    return this.info.project.name
  }

  note(text: string): void {
    logLine(this.cfg, `[${this.scenario}][${this.project}] ${text}`)
  }

  /** Viewport screenshot of the current step. The last call with `final: true` also writes the headline image. */
  async shot(page: Page, step: string, opts: { final?: boolean; fullPage?: boolean } = {}): Promise<void> {
    this.n += 1
    const slug = step.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    const nn = String(this.n).padStart(2, '0')
    this.note(`step ${nn}: ${step}`)
    if (!evidenceOn()) return
    const base = `cross-app-${this.scenario}-${this.project}`
    const stepsDir = path.join(this.cfg.evidenceDir, 'cross-app-steps')
    fs.mkdirSync(stepsDir, { recursive: true })
    await page.screenshot({ path: path.join(stepsDir, `${base}-s${nn}-${slug}.png`), fullPage: opts.fullPage ?? false, scale: 'css' })
    if (opts.final) await page.screenshot({ path: path.join(this.cfg.evidenceDir, `${base}.png`), fullPage: opts.fullPage ?? false, scale: 'css' })
  }
}

// ---------------------------------------------------------------------------------------------------------
// Network recording of what a page really sent to the CMS (proves the UI is not running on mocks).
// ---------------------------------------------------------------------------------------------------------

export type Call = { method: string; path: string; status: number; credentials?: string }

export function trackCmsCalls(page: Page, cmsUrl: string) {
  const calls: Call[] = []
  const { port } = new URL(cmsUrl)
  // The public form posts via http://localhost:<port> (see stack.ts GAP WORKAROUND), staff/read calls via the cms.* host.
  const origins = new Set([new URL(cmsUrl).origin, `http://localhost:${port}`])
  page.on('response', (res) => {
    const u = new URL(res.url())
    if (!origins.has(u.origin)) return
    const req = res.request()
    calls.push({ method: req.method(), path: u.pathname + u.search, status: res.status() })
  })
  return {
    calls,
    find(method: string, pathPrefix: string, status?: number): Call | undefined {
      return calls.find((c) => c.method === method && c.path.startsWith(pathPrefix) && (status === undefined || c.status === status))
    },
    filter(method: string, pathPrefix: string): Call[] {
      return calls.filter((c) => c.method === method && c.path.startsWith(pathPrefix))
    },
    summary(): string {
      return calls.map((c) => `${c.method} ${c.path.split('?')[0]} -> ${c.status}`).join('; ')
    },
  }
}

// ---------------------------------------------------------------------------------------------------------
// Node-side API client (authoritative server state; Authorization header, so no cookie/CSRF involvement).
// ---------------------------------------------------------------------------------------------------------

export class Api {
  private tokens = new Map<string, string>()
  private base: string
  constructor(private cfg: XappConfig) {
    this.base = new URL(cfg.recorderUrl).origin // 127.0.0.1 proxy: Node does not resolve *.localhost on every OS
  }

  async login(role: Role): Promise<string> {
    const cached = this.tokens.get(role)
    if (cached) return cached
    const c = this.cfg.credentials[role]
    const res = await fetch(`${this.base}/api/users/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: c.email, password: c.password }),
    })
    if (!res.ok) throw new Error(`API login as ${role} failed: HTTP ${res.status}`)
    const token = ((await res.json()) as { token: string }).token
    this.tokens.set(role, token)
    return token
  }

  async get(role: Role | null, urlPath: string): Promise<{ status: number; json: any }> {
    const headers: Record<string, string> = {}
    if (role) headers.authorization = `JWT ${await this.login(role)}`
    const res = await fetch(`${this.base}${urlPath}`, { headers })
    let json: any = null
    try {
      json = await res.json()
    } catch {
      // not JSON
    }
    return { status: res.status, json }
  }

  /** Article lookup by exact title as admin (any status). */
  async articleByTitle(title: string): Promise<any | null> {
    const q = `/api/articles?where[title][equals]=${encodeURIComponent(title)}&depth=1&limit=5`
    const r = await this.get('admin', q)
    return r.json?.docs?.[0] ?? null
  }

  /** Submission lookup by reference as admin. */
  async submissionByReference(reference: string): Promise<any | null> {
    const r = await this.get('admin', `/api/submissions?where[reference][equals]=${encodeURIComponent(reference)}&depth=0&limit=2`)
    return r.json?.docs?.[0] ?? null
  }

  async mediaCount(prefix: string): Promise<number> {
    const r = await this.get('admin', `/api/media?where[filename][like]=${encodeURIComponent(prefix)}&limit=50&depth=0`)
    return r.json?.totalDocs ?? 0
  }
}

// ---------------------------------------------------------------------------------------------------------
// Synthetic PNG (no binary fixture committed). Valid 8-bit RGB image with a gradient + a diagonal stripe.
// ---------------------------------------------------------------------------------------------------------

const crcTable = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
const crc32 = (buf: Buffer): number => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type: string, data: Buffer): Buffer => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

export function makePng(dir: string, filename: string, width = 960, height = 540): { file: string; width: number; height: number; bytes: number } {
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1)
    raw[row] = 0
    for (let x = 0; x < width; x++) {
      const stripe = Math.abs(x - y * (width / height)) < 18
      const o = row + 1 + x * 3
      raw[o] = stripe ? 245 : Math.round((x / width) * 90) + 20
      raw[o + 1] = stripe ? 243 : Math.round((y / height) * 120) + 60
      raw[o + 2] = stripe ? 234 : 110
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolor
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, filename)
  fs.writeFileSync(file, png)
  return { file, width, height, bytes: png.length }
}

export const sha1 = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 8)

// ---------------------------------------------------------------------------------------------------------
// Public Turnstile widget on the real submit form
// ---------------------------------------------------------------------------------------------------------

/** Wait until the real Cloudflare widget (test key) produced a token and the form reports it. */
export async function waitForTurnstile(page: Page): Promise<void> {
  await page.locator('#challenge-status').filter({ hasText: /Verification complete/i }).waitFor({ timeout: 45_000 })
}
