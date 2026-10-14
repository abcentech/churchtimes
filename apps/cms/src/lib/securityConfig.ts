import { isTurnstileDummySecret } from './turnstile'

/**
 * Pure helpers used by payload.config.ts to normalise and validate origin/secret settings.
 * Kept free of Payload imports so they can be unit tested.
 */

export const csv = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** Parse `value` as a bare origin (scheme://host[:port], no path/query). Returns null if it is not one. */
export function parseOrigin(value: string): URL | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.origin !== value) return null // rejects trailing slash, paths, queries, userinfo, uppercase host
    return url
  } catch {
    return null
  }
}

/** Normalise "https://X/" to "https://x" when it is a valid http(s) URL; otherwise return as is. */
export function normaliseOrigin(value: string): string {
  try {
    const url = new URL(value)
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin
  } catch {
    // fall through
  }
  return value
}

/** Hostnames that can only ever resolve to the machine itself (RFC 6761 `.localhost`, loopback addresses). */
export const isLoopbackHostname = (hostname: string): boolean =>
  hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '127.0.0.1' || hostname === '[::1]'

export type InsecureLocalStaging = { enabled: boolean; problems: string[] }

/**
 * CMS_ALLOW_INSECURE_LOCAL_STAGING=true lets a DISPOSABLE staging server run the real production build
 * (`next start` forces NODE_ENV=production) on http://*.localhost origins with Cloudflare's dummy Turnstile
 * test secret, so API/browser end-to-end tests can run without TLS or a real Turnstile widget.
 *
 * It is only honoured when CMS_PUBLIC_URL is set and EVERY configured origin (CMS_PUBLIC_URL, CMS_CORS_ORIGINS,
 * CMS_CSRF_ORIGINS, PUBLIC_SUBMISSION_ORIGINS) is a bare http(s) origin whose hostname is loopback-only
 * (localhost, *.localhost, 127.0.0.1, [::1]). A real deployment has public https origins, so setting the
 * flag there makes startup FAIL (it is never silently ignored) instead of weakening anything. Every other
 * production check (secrets, TRUST_PROXY, wildcard bans, ...) still applies.
 */
export function insecureLocalStaging(env: NodeJS.ProcessEnv): InsecureLocalStaging {
  if (env.CMS_ALLOW_INSECURE_LOCAL_STAGING !== 'true') return { enabled: false, problems: [] }
  const problems: string[] = []
  const lists: [string, string[]][] = [
    ['CMS_PUBLIC_URL', csv(env.CMS_PUBLIC_URL)],
    ['CMS_CORS_ORIGINS', csv(env.CMS_CORS_ORIGINS)],
    ['CMS_CSRF_ORIGINS', csv(env.CMS_CSRF_ORIGINS)],
    ['PUBLIC_SUBMISSION_ORIGINS', csv(env.PUBLIC_SUBMISSION_ORIGINS)],
  ]
  if (lists[0]![1].length === 0) problems.push('CMS_ALLOW_INSECURE_LOCAL_STAGING requires CMS_PUBLIC_URL.')
  for (const [name, list] of lists) {
    for (const entry of list) {
      const url = parseOrigin(entry)
      if (!url || !isLoopbackHostname(url.hostname)) {
        problems.push(
          `CMS_ALLOW_INSECURE_LOCAL_STAGING is set but ${name} entry "${entry}" is not a loopback origin ` +
            '(localhost, *.localhost, 127.0.0.1). Remove the flag outside local staging.',
        )
      }
    }
  }
  return { enabled: problems.length === 0, problems }
}


export type OriginCheckOptions = {
  name: string
  production: boolean
  /** Only set from insecureLocalStaging(): also accept http for loopback hostnames in production. */
  allowInsecureLoopback?: boolean
}

/** Returns human-readable problems with an origin list ([] when fine). */
export function checkOriginList(
  list: string[],
  { name, production, allowInsecureLoopback = false }: OriginCheckOptions,
): string[] {
  const problems: string[] = []
  for (const entry of list) {
    if (entry === '*' || entry.includes('*')) {
      problems.push(`${name} must not contain wildcards ("${entry}").`)
      continue
    }
    const url = parseOrigin(entry)
    if (!url) {
      problems.push(`${name} entry "${entry}" must be a bare origin like https://example.org (no path or trailing slash).`)
      continue
    }
    const insecureOk = (LOCAL_HOSTS.has(url.hostname) && !production) || (allowInsecureLoopback && isLoopbackHostname(url.hostname))
    if (url.protocol !== 'https:' && !insecureOk) {
      problems.push(`${name} entry "${entry}" must use https${production ? '' : ' (http is only allowed for localhost)'}.`)
    }
  }
  return problems
}

/** Headers that can never carry "the client address" (list-valued or unrelated to the connection). */
const UNSAFE_IP_HEADERS = new Set([
  'x-forwarded-for',
  'host',
  'cookie',
  'authorization',
  'user-agent',
  'origin',
  'referer',
  'content-type',
  'content-length',
])

export type ProductionEnvCheck = {
  /** Startup fails when non-empty. */
  problems: string[]
  /** Logged at startup; never fails the start. */
  warnings: string[]
}

/**
 * Startup validation for NODE_ENV=production. Returns every problem found so the operator can fix
 * them in one go. (Run by payload.config.ts; the config throws if the list is non-empty.)
 */
export function validateProductionEnv(env: NodeJS.ProcessEnv): ProductionEnvCheck {
  const problems: string[] = []
  const warnings: string[] = []

  const secret = env.PAYLOAD_SECRET ?? ''
  if (secret.length < 32) problems.push('PAYLOAD_SECRET must be set and at least 32 characters long.')

  const preview = env.PREVIEW_SECRET ?? ''
  if (preview.length < 32) problems.push('PREVIEW_SECRET must be set and at least 32 characters long.')
  else if (preview === secret) problems.push('PREVIEW_SECRET must differ from PAYLOAD_SECRET.')

  if ((env.IP_HASH_SALT ?? '').length < 16) problems.push('IP_HASH_SALT must be set and at least 16 characters long.')

  // Disposable local staging only (see insecureLocalStaging): http loopback origins + Cloudflare's test secret.
  const staging = insecureLocalStaging(env)
  problems.push(...staging.problems)

  const turnstile = env.TURNSTILE_SECRET_KEY?.trim() ?? ''
  if (!turnstile) problems.push('TURNSTILE_SECRET_KEY is required in production (Cloudflare Turnstile secret key).')
  else if (isTurnstileDummySecret(turnstile) && !staging.enabled) {
    problems.push('TURNSTILE_SECRET_KEY is one of Cloudflare\'s dummy test secrets; use the real secret in production.')
  }

  // Optional widget pinning. Not a startup failure (the secret alone is valid), but without these two settings a
  // token minted for another hostname or widget action is accepted. Disposable staging uses Cloudflare's dummy keys,
  // which always report fixed hostnames, so the advice does not apply there.
  if (!staging.enabled) {
    if (!(env.TURNSTILE_ALLOWED_HOSTNAMES ?? '').trim()) {
      warnings.push(
        'TURNSTILE_ALLOWED_HOSTNAMES is not set: Turnstile tokens issued for any hostname are accepted. Set it to the public ' +
          'hostname(s) of the widget (comma list, for example www.churchtimesnigeria.net).',
      )
    }
    if (!(env.TURNSTILE_EXPECTED_ACTION ?? '').trim()) {
      warnings.push(
        'TURNSTILE_EXPECTED_ACTION is not set: Turnstile tokens with any widget action are accepted. Set it to the action the ' +
          'public site sends (VITE_TURNSTILE_ACTION in its build, default submit-story).',
      )
    }
  }

  const publicUrl = env.CMS_PUBLIC_URL?.trim() ?? ''
  if (!publicUrl) problems.push('CMS_PUBLIC_URL is required in production (https origin, no trailing slash).')
  else {
    const url = parseOrigin(publicUrl)
    if (!url) problems.push('CMS_PUBLIC_URL must be a bare origin like https://cms.example.org (no path or trailing slash).')
    else if (url.protocol !== 'https:' && !staging.enabled) problems.push('CMS_PUBLIC_URL must use https in production.')
  }

  const originOptions = (name: string) => ({ name, production: true, allowInsecureLoopback: staging.enabled })
  problems.push(...checkOriginList(csv(env.CMS_CORS_ORIGINS), originOptions('CMS_CORS_ORIGINS')))
  problems.push(...checkOriginList(csv(env.CMS_CSRF_ORIGINS), originOptions('CMS_CSRF_ORIGINS')))
  problems.push(...checkOriginList(csv(env.PUBLIC_SUBMISSION_ORIGINS), originOptions('PUBLIC_SUBMISSION_ORIGINS')))

  // The app always runs behind a reverse proxy (docs/operations.md). Without TRUST_PROXY every client
  // shares one rate-limit bucket: public submissions would lock out everybody after a handful of
  // requests and per-IP login limits would be useless.
  if (env.TRUST_PROXY !== 'true') {
    problems.push(
      'TRUST_PROXY must be "true" in production: the CMS must run behind a reverse proxy (Caddy/nginx) that sets the client address ' +
        '(see docs/operations.md), otherwise all clients share one rate-limit bucket.',
    )
  }
  const hops = env.TRUST_PROXY_HOPS?.trim()
  if (hops && !(/^[0-9]{1,3}$/.test(hops) && Number(hops) >= 1 && Number(hops) <= 10)) {
    problems.push('TRUST_PROXY_HOPS must be an integer between 1 and 10 (number of trusted reverse proxies).')
  }
  const ipHeader = env.CLIENT_IP_HEADER?.trim()
  if (ipHeader && (!/^[A-Za-z0-9-]{1,64}$/.test(ipHeader) || UNSAFE_IP_HEADERS.has(ipHeader.toLowerCase()))) {
    problems.push(
      'CLIENT_IP_HEADER must be a single header name that your proxy overwrites with the client address ' +
        '(for example cf-connecting-ip or x-real-ip).',
    )
  }

  const smtpHost = env.SMTP_HOST?.trim()
  if (smtpHost && !(env.EMAIL_FROM_ADDRESS ?? '').trim()) {
    problems.push('EMAIL_FROM_ADDRESS is required when SMTP_HOST is set.')
  }

  return { problems, warnings }
}
