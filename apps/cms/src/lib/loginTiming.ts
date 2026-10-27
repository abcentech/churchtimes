import { pbkdf2Sync, randomBytes } from 'node:crypto'

import type { CollectionBeforeOperationHook } from 'payload'

import { verifyStoredPassword } from './passwordVerify'

/**
 * Login timing equaliser (found by tests/security: a wrong password for an EXISTING account took ~1.4 s because Payload
 * runs PBKDF2 at 600k iterations, while an unknown e-mail answered in ~10 ms, so response time revealed which staff
 * addresses exist). For an unknown e-mail we run the same PBKDF2 against a throw-away hash before Payload answers 401.
 */
let dummy: { hash: string; salt: string } | undefined
const getDummy = () => {
  if (!dummy) {
    const salt = randomBytes(32).toString('hex')
    dummy = { salt, hash: `pbkdf2-sha256-v1:${pbkdf2Sync(randomBytes(16).toString('hex'), salt, 600_000, 32, 'sha256').toString('hex')}` }
  }
  return dummy
}

export const equaliseLoginTiming: CollectionBeforeOperationHook = async ({ args, operation, req }) => {
  if (operation !== 'login' || req?.payloadAPI !== 'REST') return args
  const data = (args as { data?: { email?: unknown; password?: unknown } }).data
  const email = typeof data?.email === 'string' ? data.email.trim().toLowerCase() : ''
  if (!email) return args
  try {
    const found = await req.payload.count({
      collection: 'users',
      where: { email: { equals: email } },
      overrideAccess: true,
      req,
    })
    if (found.totalDocs === 0) await verifyStoredPassword(getDummy(), String(data?.password ?? 'x') || 'x')
  } catch {
    // never let the equaliser change the outcome
  }
  return args
}
