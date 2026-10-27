/**
 * First administrator, created on the server: `npm run admin:create` (runs `payload run src/seed/createAdmin.ts`).
 *
 * In production POST /api/users/first-register is refused (see firstRegisterAllowed in lib/securityConfig.ts), so on an
 * empty database this is how the first admin is made, BEFORE the reverse proxy exposes the site. It refuses to run when
 * any user already exists (use `npm run admin:set-password` for an existing account).
 *
 * Env:
 *   ADMIN_EMAIL          e-mail of the new admin
 *   ADMIN_NEW_PASSWORD   the password (the password policy applies: 12+ chars, not common, not the e-mail)
 *   ADMIN_NAME           optional display name (default "Administrator")
 *
 * The password is never logged. Set the variables inline for this one command, not in `.env` or shell history.
 */
import config from '@payload-config'
import { getPayload } from 'payload'

const email = (process.env.ADMIN_EMAIL ?? '').trim().toLowerCase()
const password = process.env.ADMIN_NEW_PASSWORD ?? ''
const name = (process.env.ADMIN_NAME ?? '').trim() || 'Administrator'

async function main() {
  if (!email || !password) throw new Error('Set ADMIN_EMAIL and ADMIN_NEW_PASSWORD.')
  const payload = await getPayload({ config })
  const existing = await payload.count({ collection: 'users', overrideAccess: true })
  if (existing.totalDocs > 0) {
    throw new Error('Users already exist: refusing to create another admin here. Use npm run admin:set-password for an existing account.')
  }
  await payload.create({
    collection: 'users',
    data: { email, name, role: 'admin', sections: [], password },
    depth: 0,
    overrideAccess: true,
    context: { seed: true },
  })
  payload.logger.info(`First administrator created for ${email}. Sign in and change the password.`)
}

try {
  await main()
  process.exit(0)
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
}
