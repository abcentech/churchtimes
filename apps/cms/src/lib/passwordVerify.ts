import { pbkdf2, timingSafeEqual } from 'node:crypto'

/**
 * Verify a password against Payload's stored `hash` / `salt` without side effects (no session, no
 * login-attempt bookkeeping).
 *
 * Mirrors payload@3.90.2 `auth/strategies/local/generatePasswordSaltHash.js` + `authenticate.js`
 * (those modules are not exported): current hashes are `pbkdf2-sha256-v1:<hex>` with 600 000
 * iterations and a 32-byte key; legacy hashes are bare hex with 25 000 iterations and a 512-byte key.
 * The salt is the hex string itself (used as the pbkdf2 salt string, not decoded).
 */
const CURRENT_PREFIX = 'pbkdf2-sha256-v1:'

export function passwordHashParameters(hash: string): { hash: string; iterations: number; keyLength: number } {
  return hash.startsWith(CURRENT_PREFIX)
    ? { hash: hash.slice(CURRENT_PREFIX.length), iterations: 600_000, keyLength: 32 }
    : { hash, iterations: 25_000, keyLength: 512 }
}

export function verifyStoredPassword(
  stored: { hash?: unknown; salt?: unknown } | null | undefined,
  candidate: string,
): Promise<boolean> {
  const { hash, salt } = stored ?? {}
  if (typeof hash !== 'string' || typeof salt !== 'string' || candidate.length === 0 || candidate.length > 1024) {
    return Promise.resolve(false)
  }
  const params = passwordHashParameters(hash)
  const expected = Buffer.from(params.hash, 'hex')
  return new Promise((resolve) => {
    pbkdf2(candidate, salt, params.iterations, params.keyLength, 'sha256', (err, derived) => {
      resolve(!err && derived.length === expected.length && timingSafeEqual(derived, expected))
    })
  })
}
