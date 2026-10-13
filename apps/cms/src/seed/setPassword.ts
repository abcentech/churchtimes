/**
 * Break-glass account recovery: `npm run admin:set-password` (runs `payload run src/seed/setPassword.ts`).
 *
 * Sets a new password for an existing user, clears any lockout and ends all of that user's sessions.
 * Needs shell access to the server (DATABASE_URL, PAYLOAD_SECRET), so it is only as exposed as the server.
 * The password policy (12+ chars, not common, not the e-mail address) still applies.
 *
 * Env:
 *   ADMIN_EMAIL          e-mail of the existing user
 *   ADMIN_NEW_PASSWORD   the new password (use a throw-away one and change it after signing in)
 *
 * The password is never logged. Prefer setting both variables inline for this one command so they are
 * not kept in shell history files or `.env`.
 */
import config from '@payload-config'
import { getPayload } from 'payload'

const email = (process.env.ADMIN_EMAIL ?? '').trim().toLowerCase()
const password = process.env.ADMIN_NEW_PASSWORD ?? ''

async function main() {
  if (!email || !password) throw new Error('Set ADMIN_EMAIL and ADMIN_NEW_PASSWORD.')
  const payload = await getPayload({ config })
  const found = await payload.find({
    collection: 'users',
    where: { email: { equals: email } },
    limit: 1,
    depth: 0,
    overrideAccess: true,
  })
  const user = found.docs[0]
  if (!user) throw new Error(`No user with e-mail ${email}.`)

  await payload.update({
    collection: 'users',
    id: user.id,
    data: { password, loginAttempts: 0, lockUntil: null } as never,
    overrideAccess: true,
    context: { seed: true },
  })
  // Password change already ends other sessions; make sure none survive.
  await payload.db.updateOne({
    collection: 'users',
    id: user.id,
    data: { sessions: [], loginAttempts: 0, lockUntil: null },
    returning: false,
  })
  payload.logger.info(`Password updated for ${email}. All sessions ended. Sign in and change it.`)
}

try {
  await main()
  process.exit(0)
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
}
