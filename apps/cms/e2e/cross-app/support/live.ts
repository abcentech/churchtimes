import type { Page } from '@playwright/test'

import type { Role, XappConfig } from './helpers'
import { Api, apiBase } from './helpers'

/** Node-side JSON client for live coverage state (authoritative server truth, JWT header, so no cookie/CSRF involved). */
export class LiveApi extends Api {
  private root: string
  constructor(cfg: XappConfig) {
    super(cfg)
    this.root = apiBase(cfg)
  }

  async send(role: Role | null, method: 'POST' | 'PATCH', urlPath: string, body: unknown): Promise<{ status: number; json: any }> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (role) headers.authorization = `JWT ${await this.login(role)}`
    const res = await fetch(`${this.root}${urlPath}`, { method, headers, body: JSON.stringify(body) })
    let json: any = null
    try {
      json = await res.json()
    } catch {
      // not JSON
    }
    return { status: res.status, json }
  }

  /** Live event by exact title as admin (any status). */
  async eventByTitle(title: string): Promise<any | null> {
    const r = await this.get('admin', `/api/live-events?where[title][equals]=${encodeURIComponent(title)}&depth=0&limit=2`)
    return r.json?.docs?.[0] ?? null
  }

  /** Every update of an event as admin, creation order (any status; staff-only fields included). */
  async updatesOfEvent(eventId: number | string): Promise<any[]> {
    const r = await this.get('admin', `/api/live-updates?where[event][equals]=${eventId}&sort=sequence&depth=0&limit=100`)
    return r.json?.docs ?? []
  }
}

export type PublicFeed = { status: number; cacheControl: string | null; text: string; json: any }

/**
 * A real anonymous read: the browser is on the PUBLIC site origin (cross-origin to the CMS, subject to CORS) and the
 * request carries no cookies and no Authorization header (`credentials: 'omit'`).
 */
export async function anonymousGet(page: Page, cmsUrl: string, pathAndQuery: string): Promise<PublicFeed> {
  return page.evaluate(
    async ([cms, p]) => {
      const res = await fetch(`${cms}${p}`, { credentials: 'omit' })
      const text = await res.text()
      let json: any = null
      try {
        json = JSON.parse(text)
      } catch {
        // not JSON
      }
      return { status: res.status, cacheControl: res.headers.get('cache-control'), text, json }
    },
    [cmsUrl, pathAndQuery] as const,
  )
}
