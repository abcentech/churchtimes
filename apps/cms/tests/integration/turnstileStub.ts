import { setTurnstileFetchForTests } from '../../src/lib/turnstile'

/**
 * Integration tests never touch the network. The only thing replaced is the HTTP transport used by
 * `verifyTurnstile`; the endpoint still runs the real verification code against these canned answers.
 */
export const TURNSTILE_OK = 'test-token-ok'
export const TURNSTILE_BAD = 'test-token-rejected'
export const TURNSTILE_SPENT = 'test-token-spent'
export const TURNSTILE_NETWORK_ERROR = 'test-token-network-error'
export const TURNSTILE_HTTP_500 = 'test-token-http-500'

export type SiteverifyCall = { url: string; secret: string; response: string; remoteip: string | null }
export const siteverifyCalls: SiteverifyCall[] = []

export function installTurnstileStub(): void {
  setTurnstileFetchForTests(async (url, init) => {
    const form = new URLSearchParams(String(init.body))
    const response = form.get('response') ?? ''
    siteverifyCalls.push({ url, secret: form.get('secret') ?? '', response, remoteip: form.get('remoteip') })
    if (response === TURNSTILE_NETWORK_ERROR) throw new TypeError('fetch failed')
    if (response === TURNSTILE_HTTP_500) return new Response('boom', { status: 500 })
    if (response === TURNSTILE_SPENT) {
      return Response.json({ success: false, 'error-codes': ['timeout-or-duplicate'] })
    }
    if (response === TURNSTILE_OK) {
      return Response.json({ success: true, hostname: 'allowed.test', challenge_ts: new Date().toISOString() })
    }
    return Response.json({ success: false, 'error-codes': ['invalid-input-response'] })
  })
}

export function removeTurnstileStub(): void {
  setTurnstileFetchForTests(undefined)
}
