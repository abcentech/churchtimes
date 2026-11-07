import type { Payload } from 'payload'

import { isMailConfigured, sendPlainMail } from '../mailer'
import { resolvePublicSiteUrl } from '../newsletter'
import { safeErrorFields } from '../safeLog'
import type { GivingEnv, GivingProvider } from './provider'
import type { GivingDeps } from './service'
import { normaliseGivingSettings, resolveGivingProvider, type EffectiveGivingSettings } from './settings'
import { payloadDonationStore, type DonationStore } from './store'

/**
 * Everything an endpoint needs, resolved per request from the environment and the `giving-settings` global (cached
 * briefly). With no PAYSTACK_SECRET_KEY the result is "off" WITHOUT reading the database or touching the network.
 */

export type GivingRuntime = {
  provider: GivingProvider | null
  /** Why giving is off (operator log only; never sent to browsers). */
  reason: string | null
  settings: EffectiveGivingSettings | null
  returnUrl: string | null
  /** New donations may start: enabled switch + provider + return URL + at least one usable currency. */
  accepting: boolean
}

const SETTINGS_CACHE_MS = 30_000
let cache: { at: number; raw: unknown } | undefined
let override: ((payload: Payload) => Promise<GivingRuntime>) | undefined
let storeOverride: ((payload: Payload) => DonationStore) | undefined

/** Test seams (NODE_ENV=test only): replace the runtime or the store. Pass undefined to restore. */
export function setGivingRuntimeForTests(fn: typeof override): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('setGivingRuntimeForTests is only available when NODE_ENV=test.')
  override = fn
}
export function setGivingStoreForTests(fn: typeof storeOverride): void {
  if (process.env.NODE_ENV !== 'test') throw new Error('setGivingStoreForTests is only available when NODE_ENV=test.')
  storeOverride = fn
}
export function resetGivingSettingsCache(): void {
  cache = undefined
}

/** `GIVING_RETURN_URL` (full URL) or `<PUBLIC_SITE_URL>/give/thanks/`; https only in production. */
export function resolveGivingReturnUrl(env: GivingEnv = process.env): string | null {
  const explicit = env.GIVING_RETURN_URL?.trim()
  if (explicit) {
    try {
      const url = new URL(explicit)
      if (url.username || url.password || url.hash) return null
      if (url.protocol === 'https:') return url.href
      const local = ['localhost', '127.0.0.1'].includes(url.hostname)
      return url.protocol === 'http:' && local && env.NODE_ENV !== 'production' ? url.href : null
    } catch {
      return null
    }
  }
  const site = resolvePublicSiteUrl(env as NodeJS.ProcessEnv)
  return site ? `${site}/give/thanks/` : null
}

async function readSettings(payload: Payload): Promise<unknown> {
  const now = Date.now()
  if (cache && now - cache.at < SETTINGS_CACHE_MS) return cache.raw
  let raw: unknown = null
  try {
    raw = await payload.findGlobal({ slug: 'giving-settings' as never, depth: 0, overrideAccess: true })
  } catch (err) {
    payload.logger.error(safeErrorFields(err), '[giving] could not read giving-settings; giving is off')
    raw = null
  }
  cache = { at: now, raw }
  return raw
}

export async function loadGivingRuntime(payload: Payload, env: GivingEnv = process.env): Promise<GivingRuntime> {
  if (override) return override(payload)
  // Only Paystack is implemented, so no Paystack key means no provider at all: stop before the database and the network.
  if (!env.PAYSTACK_SECRET_KEY?.trim()) {
    return { provider: null, reason: 'PAYSTACK_SECRET_KEY is not set.', settings: null, returnUrl: null, accepting: false }
  }
  const raw = await readSettings(payload)
  const resolved = resolveGivingProvider((raw as { provider?: unknown } | null)?.provider, env)
  if (!resolved.provider) return { provider: null, reason: resolved.reason, settings: null, returnUrl: null, accepting: false }
  const settings = normaliseGivingSettings(raw, resolved.provider)
  const returnUrl = resolveGivingReturnUrl(env)
  const accepting = settings.enabled && settings.currencies.length > 0 && returnUrl !== null
  const reason = accepting
    ? null
    : !settings.enabled
      ? 'giving-settings.enabled is off.'
      : returnUrl === null
        ? 'PUBLIC_SITE_URL (or GIVING_RETURN_URL) is not set or not https.'
        : 'No currency in giving-settings is supported by the provider.'
  return { provider: resolved.provider, reason, settings, returnUrl, accepting }
}

export function givingDeps(payload: Payload, runtime: GivingRuntime & { provider: GivingProvider }): GivingDeps {
  return {
    store: storeOverride ? storeOverride(payload) : payloadDonationStore(payload),
    provider: runtime.provider,
    logger: payload.logger,
    settings: runtime.settings,
    returnUrl: runtime.returnUrl ?? '',
    mailer: {
      configured: isMailConfigured(),
      send: (to, subject, text) => sendPlainMail(payload, { to: [to], subject, text }),
    },
  }
}
