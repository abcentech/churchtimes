import { randomUUID } from 'node:crypto'

/**
 * Cloudflare Turnstile server-side validation ("Siteverify").
 * https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
 *
 * Fail CLOSED: anything other than an explicit `success: true` from Cloudflare (and, when
 * configured, an allowed hostname/action) is a rejection. The secret never leaves the server.
 */

export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

/**
 * Cloudflare's documented dummy secret that always passes (the real Siteverify endpoint still
 * answers). `2x0000000000000000000000000000000AA` always fails and
 * `3x0000000000000000000000000000000AA` reports `timeout-or-duplicate`.
 * https://developers.cloudflare.com/turnstile/troubleshooting/testing/
 */
export const TURNSTILE_TEST_SECRET = '1x0000000000000000000000000000000AA'

/** True for any of Cloudflare's dummy secrets (1x / 2x / 3x ...AA). Never acceptable in production. */
export const isTurnstileDummySecret = (secret: string): boolean => /^[123]x0{20,}AA$/.test(secret)

/** Documented maximum token length. */
export const TURNSTILE_MAX_TOKEN_LENGTH = 2048

export const TURNSTILE_FAILURE_MESSAGE = 'Verification failed. Please try again.'
export const TURNSTILE_MISSING_MESSAGE = 'Please complete the verification challenge.'

type FetchLike = (input: string, init: RequestInit) => Promise<Response>

type LoggerLike = {
  warn: (obj: unknown, msg?: string) => void
  error: (obj: unknown, msg?: string) => void
}

export type VerifyTurnstileArgs = {
  token: unknown
  remoteip?: string
  /** UUID so Cloudflare can de-duplicate retries. Generated when omitted. */
  idempotencyKey?: string
  /** Per-call overrides (tests / unit tests). Production code relies on the environment. */
  secret?: string
  fetchImpl?: FetchLike
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  logger?: LoggerLike
}

export type VerifyTurnstileResult =
  | { ok: true; hostname?: string; action?: string }
  | { ok: false; status: 400 | 403; field: 'turnstileToken'; message: string; reason: string }

// Test seam. Only usable when NODE_ENV === 'test'; a request can never reach it.
let testFetch: FetchLike | undefined

/**
 * Replace the network call with a stub. Throws outside NODE_ENV=test, so the production code
 * path cannot be switched off. Only the transport is replaced: success/hostname/action logic runs
 * unchanged against the stub's JSON. Call with `undefined` to restore.
 */
export function setTurnstileFetchForTests(fn: FetchLike | undefined): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('setTurnstileFetchForTests is only available when NODE_ENV=test.')
  }
  testFetch = fn
}

const csv = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)

const defaultLogger: LoggerLike = {
  warn: (obj, msg) => console.warn(msg ?? '', obj),
  error: (obj, msg) => console.error(msg ?? '', obj),
}

let warnedDevSecret = false

/** Resolve the Siteverify secret. Returns undefined when production has none (=> fail closed). */
export function resolveTurnstileSecret(
  env: NodeJS.ProcessEnv = process.env,
  logger: LoggerLike = defaultLogger,
): string | undefined {
  const configured = env.TURNSTILE_SECRET_KEY?.trim()
  if (configured) return configured
  if (env.NODE_ENV === 'production') return undefined
  if (!warnedDevSecret && env.NODE_ENV !== 'test') {
    warnedDevSecret = true
    logger.warn(
      {},
      '[turnstile] TURNSTILE_SECRET_KEY is not set. Using Cloudflare\'s always-pass TEST secret. ' +
        'Spam protection is NOT active. Never run like this in production.',
    )
  }
  return TURNSTILE_TEST_SECRET
}

const fail = (
  status: 400 | 403,
  reason: string,
  message = status === 400 ? TURNSTILE_MISSING_MESSAGE : TURNSTILE_FAILURE_MESSAGE,
): VerifyTurnstileResult => ({ ok: false, status, field: 'turnstileToken', message, reason })

export async function verifyTurnstile(args: VerifyTurnstileArgs): Promise<VerifyTurnstileResult> {
  const env = args.env ?? process.env
  const logger = args.logger ?? defaultLogger
  const { token } = args

  if (typeof token !== 'string' || token.trim() === '') return fail(400, 'missing-token')
  if (token.length > TURNSTILE_MAX_TOKEN_LENGTH) return fail(403, 'token-too-long')

  const secret = args.secret ?? resolveTurnstileSecret(env, logger)
  if (!secret) {
    logger.error({}, '[turnstile] TURNSTILE_SECRET_KEY is missing in production; rejecting (fail closed).')
    return fail(403, 'secret-not-configured')
  }

  const fetchImpl: FetchLike = args.fetchImpl ?? testFetch ?? ((url, init) => fetch(url, init))
  const timeoutMs = args.timeoutMs ?? 5000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let payload: Record<string, unknown>
  try {
    const form = new URLSearchParams()
    form.set('secret', secret)
    form.set('response', token)
    if (args.remoteip && args.remoteip !== 'unknown') form.set('remoteip', args.remoteip)
    form.set('idempotency_key', args.idempotencyKey ?? randomUUID())

    const res = await fetchImpl(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: controller.signal,
    })
    if (res.status !== 200) {
      logger.error({ status: res.status }, '[turnstile] Siteverify returned a non-200 status.')
      return fail(403, `http-${res.status}`)
    }
    const json: unknown = await res.json()
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      logger.error({}, '[turnstile] Siteverify returned an unexpected body.')
      return fail(403, 'bad-response')
    }
    payload = json as Record<string, unknown>
  } catch (err) {
    const aborted = controller.signal.aborted
    logger.error(
      { err: err instanceof Error ? err.message : String(err), timeout: aborted },
      '[turnstile] Siteverify request failed.',
    )
    return fail(403, aborted ? 'timeout' : 'network-error')
  } finally {
    clearTimeout(timer)
  }

  if (payload.success !== true) {
    // Cloudflare error codes are for operators only; never returned to the client.
    logger.warn({ errorCodes: payload['error-codes'] }, '[turnstile] verification rejected.')
    return fail(403, 'rejected')
  }

  const hostname = typeof payload.hostname === 'string' ? payload.hostname : undefined
  const action = typeof payload.action === 'string' ? payload.action : undefined

  const allowedHostnames = csv(env.TURNSTILE_ALLOWED_HOSTNAMES)
  if (allowedHostnames.length > 0 && !(hostname && allowedHostnames.includes(hostname.toLowerCase()))) {
    logger.warn({ hostname }, '[turnstile] hostname is not in TURNSTILE_ALLOWED_HOSTNAMES.')
    return fail(403, 'hostname-mismatch')
  }

  // Comma-separated allowlist (e.g. "submit-story,public_story"); exact, case-sensitive match. When set,
  // a token without an action, or with one outside the list, is rejected (fail closed).
  const expectedActions = (env.TURNSTILE_EXPECTED_ACTION ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (expectedActions.length > 0 && !(action !== undefined && expectedActions.includes(action))) {
    logger.warn({ action }, '[turnstile] action does not match TURNSTILE_EXPECTED_ACTION.')
    return fail(403, 'action-mismatch')
  }

  return { ok: true, hostname, action }
}
