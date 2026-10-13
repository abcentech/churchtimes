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

export type OriginCheckOptions = { name: string; production: boolean }

/** Returns human-readable problems with an origin list ([] when fine). */
export function checkOriginList(list: string[], { name, production }: OriginCheckOptions): string[] {
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
    if (url.protocol !== 'https:' && !(LOCAL_HOSTS.has(url.hostname) && !production)) {
      problems.push(`${name} entry "${entry}" must use https${production ? '' : ' (http is only allowed for localhost)'}.`)
    }
  }
  return problems
}

export type ProductionEnvCheck = {
  problems: string[]
}

/**
 * Startup validation for NODE_ENV=production. Returns every problem found so the operator can fix
 * them in one go. (Run by payload.config.ts; the config throws if the list is non-empty.)
 */
export function validateProductionEnv(env: NodeJS.ProcessEnv): ProductionEnvCheck {
  const problems: string[] = []

  const secret = env.PAYLOAD_SECRET ?? ''
  if (secret.length < 32) problems.push('PAYLOAD_SECRET must be set and at least 32 characters long.')

  const preview = env.PREVIEW_SECRET ?? ''
  if (preview.length < 32) problems.push('PREVIEW_SECRET must be set and at least 32 characters long.')
  else if (preview === secret) problems.push('PREVIEW_SECRET must differ from PAYLOAD_SECRET.')

  if ((env.IP_HASH_SALT ?? '').length < 16) problems.push('IP_HASH_SALT must be set and at least 16 characters long.')

  const turnstile = env.TURNSTILE_SECRET_KEY?.trim() ?? ''
  if (!turnstile) problems.push('TURNSTILE_SECRET_KEY is required in production (Cloudflare Turnstile secret key).')
  else if (isTurnstileDummySecret(turnstile)) {
    problems.push('TURNSTILE_SECRET_KEY is one of Cloudflare\'s dummy test secrets; use the real secret in production.')
  }

  const publicUrl = env.CMS_PUBLIC_URL?.trim() ?? ''
  if (!publicUrl) problems.push('CMS_PUBLIC_URL is required in production (https origin, no trailing slash).')
  else {
    const url = parseOrigin(publicUrl)
    if (!url) problems.push('CMS_PUBLIC_URL must be a bare origin like https://cms.example.org (no path or trailing slash).')
    else if (url.protocol !== 'https:') problems.push('CMS_PUBLIC_URL must use https in production.')
  }

  problems.push(...checkOriginList(csv(env.CMS_CORS_ORIGINS), { name: 'CMS_CORS_ORIGINS', production: true }))
  problems.push(...checkOriginList(csv(env.CMS_CSRF_ORIGINS), { name: 'CMS_CSRF_ORIGINS', production: true }))
  problems.push(
    ...checkOriginList(csv(env.PUBLIC_SUBMISSION_ORIGINS), { name: 'PUBLIC_SUBMISSION_ORIGINS', production: true }),
  )

  const smtpHost = env.SMTP_HOST?.trim()
  if (smtpHost && !(env.EMAIL_FROM_ADDRESS ?? '').trim()) {
    problems.push('EMAIL_FROM_ADDRESS is required when SMTP_HOST is set.')
  }

  return { problems }
}
