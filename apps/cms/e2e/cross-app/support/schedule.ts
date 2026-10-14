import type { Page } from '@playwright/test'

import type { Api, Role, XappConfig } from './helpers'

/** Value for <input type="datetime-local" step="1"> in the browser's (= this machine's) local time. */
export function localInputValue(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** Authenticated API call as a seeded role (Authorization header). API-DRIVEN: not a UI path; label tests that use it. */
export async function apiRequest(
  cfg: XappConfig,
  api: Api,
  role: Role,
  method: 'GET' | 'PATCH' | 'POST',
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const base = new URL(cfg.recorderUrl).origin
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: { authorization: `JWT ${await api.login(role)}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let json: any = null
  try {
    json = await res.json()
  } catch {
    // not JSON
  }
  return { status: res.status, json }
}

/** PATCH an article from inside the newsroom page with its real session cookie (the browser's own request, CMS origin). */
export function patchFromPage(page: Page, cmsUrl: string, id: number, body: Record<string, unknown>): Promise<{ status: number; message: string }> {
  return page.evaluate(
    async ([cms, aid, payload]) => {
      const r = await fetch(`${cms}/api/articles/${aid}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      let message = ''
      try {
        const j = await r.json()
        message = String(j?.errors?.[0]?.message ?? j?.message ?? '')
      } catch {
        // not JSON
      }
      return { status: r.status, message }
    },
    [cmsUrl, id, body] as const,
  )
}
