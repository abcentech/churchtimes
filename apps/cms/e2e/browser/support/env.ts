import { createHmac } from 'node:crypto'

import type { BrowserContext, Page } from '@playwright/test'

import type { E2EConfig } from './stack'
import type { Recorded } from './recorder'

export type { E2EConfig }

export function getConfig(): E2EConfig {
  const raw = process.env.CT_E2E_CONFIG
  if (!raw) throw new Error('CT_E2E_CONFIG is not set: run through playwright.config.ts (globalSetup boots the stack).')
  return JSON.parse(raw) as E2EConfig
}

export type Role = 'admin' | 'reporter' | 'editor'

/** `editor` resolves to section-editor, falling back to editor-in-chief / editor (staging credential files). */
export function creds(cfg: E2EConfig, role: Role): { email: string; password: string } {
  const order: Record<Role, string[]> = {
    admin: ['admin'],
    reporter: ['reporter'],
    editor: ['section-editor', 'editor-in-chief', 'editor'],
  }
  for (const key of order[role]) if (cfg.credentials[key]) return cfg.credentials[key]
  throw new Error(`No credentials for role "${role}" (looked for ${order[role].join(', ')}).`)
}

export type CallResult = {
  url: string
  method: string
  credentials: string
  ok?: boolean
  status?: number
  json?: any
  error?: string
  blocked?: boolean
}

export type CallOptions = {
  method?: string
  body?: unknown
  credentials?: 'include' | 'omit' | 'same-origin'
  mode?: 'cors' | 'no-cors'
  headers?: Record<string, string>
}

/** fetch() executed inside the page (so the browser applies CORS, SameSite and Origin rules). */
export async function call(page: Page, url: string, opts: CallOptions = {}): Promise<CallResult> {
  return page.evaluate(([u, o]) => (window as any).call(u, o), [url, opts] as const) as Promise<CallResult>
}

export async function openHarness(page: Page, origin: string): Promise<void> {
  await page.goto(`${origin}/`)
  await page.waitForFunction(() => typeof (window as any).call === 'function')
}

export async function login(page: Page, cfg: E2EConfig, role: Role): Promise<CallResult> {
  const c = creds(cfg, role)
  return call(page, `${cfg.cmsUrl}/api/users/login`, { method: 'POST', body: { email: c.email, password: c.password } })
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')

/** HS256 JWT; used to forge tokens (wrong key) or to craft correctly-signed but expired/unknown-session ones. */
export function signJwt(claims: Record<string, unknown>, key: string): string {
  const head = b64({ alg: 'HS256', typ: 'JWT' })
  const body = b64(claims)
  const sig = createHmac('sha256', key).update(`${head}.${body}`).digest('base64url')
  return `${head}.${body}.${sig}`
}

/** Minimal valid Lexical document. */
export const lexicalBody = (text = 'Synthetic body for browser auth E2E.') => ({
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
        children: [{ type: 'text', text, format: 0, detail: 0, mode: 'normal', style: '', version: 1 }],
      },
    ],
  },
})

export const uniq = (label: string) => `${label}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** Id of the first category (any user may read categories); throws when the CMS has none. */
export async function firstCategoryId(page: Page, cfg: E2EConfig): Promise<number> {
  const r = await call(page, `${cfg.cmsUrl}/api/categories?limit=1&depth=0`, { credentials: 'omit' })
  const id = r.json?.docs?.[0]?.id
  if (typeof id !== 'number' && typeof id !== 'string') throw new Error('The CMS has no categories to attach test articles to.')
  return id as number
}

export type Seen = { method: string; url: string; status?: number; requestHeaders: Record<string, string>; responseHeaders?: Record<string, string> }

/**
 * Records every request the browser context sends to the CMS together with the raw request and response
 * headers (including the Cookie / Origin the browser really sent and the Access-Control-* the CMS answered
 * with). fetch() hides most of this from page JavaScript, so tests read it here instead.
 */
export function trackCms(context: BrowserContext, cmsUrl: string) {
  const pending: Promise<Seen>[] = []
  context.on('requestfinished', () => {})
  context.on('request', (r) => {
    if (!r.url().startsWith(cmsUrl)) return
    pending.push(
      (async () => {
        const seen: Seen = { method: r.method(), url: r.url(), requestHeaders: await r.allHeaders() }
        try {
          const res = await r.response()
          if (res) {
            seen.status = res.status()
            seen.responseHeaders = await res.allHeaders()
          }
        } catch {
          // blocked / failed requests have no response to read
        }
        return seen
      })(),
    )
  })
  return {
    /** All recorded requests (settled), optionally only those whose URL ends with / contains `match`. */
    async all(match?: string): Promise<Seen[]> {
      const list = await Promise.all(pending)
      return match ? list.filter((s) => s.url.includes(match)) : list
    },
  }
}

/** What the CMS actually received/answered (own-boot only; null in STAGING_URL mode). Cookie values are never recorded. */
export async function serverLog(cfg: E2EConfig): Promise<Recorded[] | null> {
  if (!cfg.recorderUrl) return null
  return (await (await fetch(cfg.recorderUrl)).json()) as Recorded[]
}
