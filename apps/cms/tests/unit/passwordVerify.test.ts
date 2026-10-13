import { pbkdf2Sync } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { passwordHashParameters, verifyStoredPassword } from '../../src/lib/passwordVerify'

const salt = 'ab'.repeat(32)
const current = `pbkdf2-sha256-v1:${pbkdf2Sync('correct-password-1', salt, 600_000, 32, 'sha256').toString('hex')}`
const legacy = pbkdf2Sync('legacy-password-1', salt, 25_000, 512, 'sha256').toString('hex')

describe('verifyStoredPassword (Payload-compatible pbkdf2)', () => {
  it('accepts the right password and rejects the wrong one for current hashes', async () => {
    expect(await verifyStoredPassword({ hash: current, salt }, 'correct-password-1')).toBe(true)
    expect(await verifyStoredPassword({ hash: current, salt }, 'correct-password-2')).toBe(false)
    expect(await verifyStoredPassword({ hash: current, salt: 'cd'.repeat(32) }, 'correct-password-1')).toBe(false)
  })

  it('supports legacy hashes', async () => {
    expect(passwordHashParameters(legacy)).toMatchObject({ iterations: 25_000, keyLength: 512 })
    expect(await verifyStoredPassword({ hash: legacy, salt }, 'legacy-password-1')).toBe(true)
    expect(await verifyStoredPassword({ hash: legacy, salt }, 'nope')).toBe(false)
  })

  it('fails closed on missing data', async () => {
    expect(await verifyStoredPassword(null, 'x')).toBe(false)
    expect(await verifyStoredPassword({ hash: current }, 'correct-password-1')).toBe(false)
    expect(await verifyStoredPassword({ hash: current, salt }, '')).toBe(false)
  })
})
