import { RedirectConfigError } from '../lib/redirectPaths'

/**
 * Which host names mean "this site". The PRIMARY host is `churchtimesnigeria.net` (or the host of `PUBLIC_SITE_URL`);
 * `LEGACY_SITE_HOSTS` lists the other names the old site answered on, by default `churchtimesnigeria.org` and
 * `churchtimesnigeria.com`. A `www.` prefix never matters. A link to any of them is the same link on the primary host:
 * the link rewriter turns it into the same root-relative path.
 */
export const DEFAULT_PRIMARY_HOST = 'churchtimesnigeria.net'
export const DEFAULT_LEGACY_SITE_HOSTS: readonly string[] = ['churchtimesnigeria.org', 'churchtimesnigeria.com']

export const hostKey = (h: string): string => h.toLowerCase().replace(/\.+$/, '').replace(/^www\./, '')

const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

export type SiteHosts = { primary: string; legacy: string[] }

export function resolveSiteHosts(env: Record<string, string | undefined> = process.env): SiteHosts {
  let primary = DEFAULT_PRIMARY_HOST
  const url = (env.PUBLIC_SITE_URL ?? '').trim()
  if (url !== '') {
    try {
      primary = hostKey(new URL(url).hostname)
    } catch {
      throw new RedirectConfigError('PUBLIC_SITE_URL must be an absolute URL such as https://churchtimesnigeria.net.')
    }
    if (!HOST.test(primary)) throw new RedirectConfigError('PUBLIC_SITE_URL must name a host (no IP literal).')
  }
  const configured = (env.LEGACY_SITE_HOSTS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  for (const h of configured) {
    if (!HOST.test(h)) throw new RedirectConfigError('LEGACY_SITE_HOSTS must be a comma list of bare host names (no scheme, port or path).')
  }
  const list = configured.length > 0 ? configured.map(hostKey) : [...DEFAULT_LEGACY_SITE_HOSTS]
  return { primary, legacy: [...new Set(list)].filter((h) => h !== primary) }
}
