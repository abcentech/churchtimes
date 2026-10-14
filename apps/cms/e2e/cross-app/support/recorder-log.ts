import type { Page } from '@playwright/test'

import type { Recorded } from '../../browser/support/recorder'

import type { XappConfig } from './helpers'
import { isRemote } from './remote'

/** What the CMS really received (Origin, cookie NAMES only, status), from the recording proxy. LOCAL mode only. */
export async function serverLog(cfg: XappConfig): Promise<Recorded[]> {
  return (await (await fetch(cfg.recorderUrl)).json()) as Recorded[]
}

export type SeenRequest = Pick<Recorded, 'method' | 'path' | 'origin' | 'secFetchSite' | 'cookieNames'>

const COOKIE_NAME = /^\s*([^=;\s]+)=/

/**
 * Starts recording the requests that reach the CMS from now on; `finish()` returns them.
 *   - LOCAL: the recording proxy's log (what the CMS server really received), sliced from now. Same as before.
 *   - REMOTE (no proxy in front of the deployed CMS): the request headers Playwright sees on `page` (`request.allHeaders()` includes
 *     Origin and the Cookie header the network stack actually sent). It only covers traffic of THIS page, which is exactly what
 *     the cookie checks need; it cannot see server-side effects, so the CORS response columns of the proxy log do not exist.
 */
export async function startCmsRequestLog(page: Page, cfg: XappConfig): Promise<{ finish: () => Promise<SeenRequest[]> }> {
  if (!isRemote) {
    const start = (await serverLog(cfg)).length
    return { finish: async () => (await serverLog(cfg)).slice(start) }
  }
  const cmsOrigin = new URL(cfg.cmsUrl).origin
  const pending: Promise<SeenRequest | null>[] = []
  page.on('response', (res) => {
    let u: URL
    try {
      u = new URL(res.url())
    } catch {
      return
    }
    if (u.origin !== cmsOrigin) return
    const req = res.request()
    pending.push(
      req
        .allHeaders()
        .catch(() => req.headers())
        .then((h) => ({
          method: req.method(),
          path: u.pathname + u.search,
          origin: h['origin'] ?? null,
          secFetchSite: h['sec-fetch-site'] ?? null,
          cookieNames: (h['cookie'] ?? '')
            .split(';')
            .map((c) => COOKIE_NAME.exec(c)?.[1] ?? '')
            .filter(Boolean),
        }))
        .catch(() => null),
    )
  })
  return { finish: async () => (await Promise.all(pending)).filter((r): r is SeenRequest => r !== null) }
}
